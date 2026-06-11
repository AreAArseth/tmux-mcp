/// <reference types="vitest" />

import { afterEach, describe, expect, it, vi } from "vitest";

type ExecResult = Promise<{ stdout: string; stderr: string }>;

const execMock = vi.fn((command: string): ExecResult => Promise.resolve({ stdout: '', stderr: '' }));

vi.mock("child_process", () => {
  const exec = (command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    execMock(command)
      .then(({ stdout, stderr }) => callback(null, stdout, stderr))
      .catch((error: Error) => callback(error, "", ""));
    return null;
  };

  const customPromisify = Symbol.for("nodejs.util.promisify.custom");
  (exec as any)[customPromisify] = (command: string) => execMock(command);

  return { exec };
});

/**
 * Reproduces the false early-completion reported against long fc_shell runs.
 *
 * A tmux pane (fc_shell) outlives the MCP server. After a server restart the
 * sequence counter resets to 0/1, but the pane scrollback still contains old
 * TMUX_MCP_DONE markers. A fresh command that reuses a sequence number would
 * match the STALE done marker and report "completed" (often with empty output,
 * since the stale DONE precedes the fresh START) while the command is actually
 * still running.
 *
 * The fix tags markers with a per-process session nonce so a previous run's
 * markers can never satisfy this run's wait.
 */
describe("completion marker isolation across sessions", () => {
  afterEach(() => {
    vi.resetModules();
    execMock.mockReset();
  });

  it("embeds the session nonce in generated markers", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));
    const tmux = await import("../src/tmux.js");
    tmux.setSessionNonce("alpha");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    await tmux.executeCommand("%0", "expr 1+1");

    const sent = execMock.mock.calls.map((args) => args[0]);
    // The tclsh helper definition must print nonce-tagged markers.
    expect(sent.some((cmd) => cmd.includes('TMUX_MCP_START_alpha_${seq}'))).toBe(true);
    expect(sent.some((cmd) => cmd.includes('TMUX_MCP_DONE_${status}_alpha_${seq}'))).toBe(true);
  });

  it("does not complete on a stale DONE marker from a previous session", async () => {
    let paneContent = "";
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return { stdout: paneContent, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setSessionNonce("run2");
    tmux.setShellConfig({ type: "tclsh", paneId: "%20" });

    const commandId = await tmux.executeCommand("%20", "N_va_try -name pnr_safe_1450");

    // Pane state mirroring the report: a stale DONE_0_1 from a previous server
    // run sits ABOVE the fresh (nonce-tagged) START, and the long command is
    // still running with no fresh DONE yet.
    paneContent = [
      "TMUX_MCP_START_1",          // stale, previous session (no nonce)
      "old leftover output",
      "TMUX_MCP_DONE_0_1",         // stale DONE that previously caused false completion
      "::tmux_mcp::run 1 {N_va_try -name pnr_safe_1450}",
      "TMUX_MCP_START_run2_1",     // fresh start for THIS run
      "coarse place 0% done",
      "coarse place 100% done",
    ].join("\n");

    const pending = await tmux.checkCommandStatus(commandId);
    expect(pending?.status).toBe("pending");

    // Now the command genuinely finishes: fresh nonce-tagged DONE appears.
    paneContent = [
      "TMUX_MCP_START_1",
      "old leftover output",
      "TMUX_MCP_DONE_0_1",
      "::tmux_mcp::run 1 {N_va_try -name pnr_safe_1450}",
      "TMUX_MCP_START_run2_1",
      "coarse place 100% done",
      "NIC-WL: [TRY:pnr_safe_1450] wirelength 14407489.863",
      "TMUX_MCP_DONE_0_run2_1",
    ].join("\n");

    const done = await tmux.checkCommandStatus(commandId);
    expect(done?.status).toBe("completed");
    expect(done?.exitCode).toBe(0);
    expect(done?.result).toContain("NIC-WL: [TRY:pnr_safe_1450] wirelength 14407489.863");
  });

  it("does not complete when a stale DONE precedes the fresh START (ordering guard)", async () => {
    // Reproduces the exact reported symptom: wait reported completed/empty
    // while create_placement was still running, because a stale DONE marker
    // sat ABOVE the fresh START in scrollback. This must stay pending even in
    // the legacy (no-nonce) marker format.
    let paneContent = "";
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return { stdout: paneContent, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%20" });

    const commandId = await tmux.executeCommand("%20", "N_va_try -name pnr_safe_1450");

    paneContent = [
      "TMUX_MCP_START_1",   // stale pair from a previous run
      "old leftover output",
      "TMUX_MCP_DONE_0_1",  // stale DONE precedes the fresh START below
      "::tmux_mcp::run 1 {N_va_try -name pnr_safe_1450}",
      "TMUX_MCP_START_1",   // fresh start; long command still running
      "coarse place 100% done",
    ].join("\n");

    const status = await tmux.checkCommandStatus(commandId);
    expect(status?.status).toBe("pending");
  });

  it("ignores a stale DONE marker carrying a different session's nonce", async () => {
    let paneContent = "";
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return { stdout: paneContent, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setSessionNonce("current");
    tmux.setShellConfig({ type: "tclsh", paneId: "%5" });

    const commandId = await tmux.executeCommand("%5", "puts TMUX_POLL");

    // A previous run (nonce "prev") completed a command with the same seq.
    paneContent = [
      "TMUX_MCP_START_prev_1",
      "wrong # args: should be \"info commands ?pattern?\"",
      "TMUX_MCP_DONE_1_prev_1",
      "::tmux_mcp::run 1 {puts TMUX_POLL}",
    ].join("\n");

    const status = await tmux.checkCommandStatus(commandId);
    // The probe is still queued behind a busy shell; it must not inherit the
    // previous session's error/completion.
    expect(status?.status).toBe("pending");
  });
});
