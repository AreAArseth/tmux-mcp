/// <reference types="vitest" />

import { afterEach, describe, expect, it, vi } from "vitest";

type ExecResult = Promise<{ stdout: string; stderr: string }>;

// Loosely typed mock mirroring tests/tmux.test.ts so child_process.exec is faked.
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
 * These tests reproduce the issues reported against long-running fc_shell /
 * tclsh sessions: wait-command-completion returning "completed" too early and
 * output being attributed to the wrong command.
 *
 * Root cause: executeCommand read the shared sequence counter, awaited shell
 * detection / tclsh init, and only committed the incremented counter afterwards.
 * Concurrent execute-command calls (e.g. probes fired while create_placement is
 * running) therefore interleave at those awaits, read the same counter value,
 * and receive DUPLICATE sequence numbers. Because completion tracking keys on
 * the sequence number alone, two commands that share a seq both match the same
 * TMUX_MCP_DONE_<exit>_<seq> marker -> false completion + cross-command output.
 */
describe("concurrent command tracking", () => {
  afterEach(() => {
    vi.resetModules();
    execMock.mockReset();
  });

  it("assigns unique sequence numbers to concurrently launched tracked commands", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    // Fire several execute-command calls at once, as an agent does when it
    // (incorrectly) believes the shell is idle and queues diagnostics.
    await Promise.all([
      tmux.executeCommand("%0", "cmdA"),
      tmux.executeCommand("%0", "cmdB"),
      tmux.executeCommand("%0", "cmdC"),
    ]);

    const runSeqs = execMock.mock.calls
      .map((args) => args[0])
      .map((cmd: string) => cmd.match(/::tmux_mcp::run (\d+) \{(cmd[ABC])\}/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => m[1]);

    expect(runSeqs).toHaveLength(3);
    // Bug reproduction: without the fix all three share seq "1".
    expect(new Set(runSeqs).size).toBe(3);
  });

  it("does not attribute a completed command's output to a concurrent sibling", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    const [idA, idB] = await Promise.all([
      tmux.executeCommand("%0", "puts PROBE_A"),
      tmux.executeCommand("%0", "puts PROBE_B"),
    ]);

    // Simulate the pane after ONLY the first command actually ran to completion.
    // The second command is still queued behind it (no marker yet), mirroring a
    // probe sent while a long fc_shell command is busy.
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "TMUX_MCP_START_1",
            "PROBE_A",
            "TMUX_MCP_DONE_0_1",
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const statusA = await tmux.checkCommandStatus(idA);
    const statusB = await tmux.checkCommandStatus(idB);

    expect(statusA?.status).toBe("completed");
    expect(statusA?.result).toBe("PROBE_A");

    // The queued sibling must NOT be reported completed with A's output.
    expect(statusB?.status).toBe("pending");
    expect(statusB?.result).not.toBe("PROBE_A");
  });

  it("keeps a probe pending while a long-running command holds the shell", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    // Long command starts first and is still running (no DONE marker).
    const longId = await tmux.executeCommand("%0", "create_placement -floorplan");
    // Probe queued behind it while busy.
    const probeId = await tmux.executeCommand("%0", "puts TMUX_PROBE_A");

    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "TMUX_MCP_START_1",
            "coarse place 14% done",
            "coarse place 100% done",
            // No TMUX_MCP_DONE for the long command, probe only queued.
            "::tmux_mcp::run 2 {puts TMUX_PROBE_A}",
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const longStatus = await tmux.checkCommandStatus(longId);
    const probeStatus = await tmux.checkCommandStatus(probeId);

    expect(longStatus?.status).toBe("pending");
    expect(probeStatus?.status).toBe("pending");
  });
});
