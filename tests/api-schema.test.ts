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
 * Follow-up coverage for the minor API/schema gotchas reported against the
 * tmux MCP server:
 *   - capture-pane "lines" had to be a string, not a number
 *   - find-session required an exact name, not a pattern
 *   - multi-arg Tcl commands were thought to fail under MCP wrapping
 */
describe("api/schema gotchas", () => {
  afterEach(() => {
    vi.resetModules();
    execMock.mockReset();
  });

  describe("capture-pane line count accepts numbers and numeric strings", () => {
    it("coerceLineCount handles numbers, numeric strings, and bad input", async () => {
      const tmux = await import("../src/tmux.js");
      expect(tmux.coerceLineCount(40, 200)).toBe(40);
      expect(tmux.coerceLineCount("40", 200)).toBe(40);
      expect(tmux.coerceLineCount(undefined, 200)).toBe(200);
      expect(tmux.coerceLineCount("", 200)).toBe(200);
      expect(tmux.coerceLineCount("not-a-number", 200)).toBe(200);
    });

    it("builds the same capture command whether lines is a number or a string", async () => {
      execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));
      const tmux = await import("../src/tmux.js");

      await tmux.capturePaneContent("%0", { lines: 40 });
      await tmux.capturePaneContent("%0", { lines: "40" });

      const captureCommands = execMock.mock.calls
        .map((args) => args[0])
        .filter((cmd: string) => cmd.includes("capture-pane"));

      expect(captureCommands).toHaveLength(2);
      expect(captureCommands[0]).toBe("tmux capture-pane -p -t '%0' -S -40 -E -");
      expect(captureCommands[1]).toBe("tmux capture-pane -p -t '%0' -S -40 -E -");
    });
  });

  describe("find-session matches by name, substring, and regex", () => {
    function mockSessions(...names: string[]) {
      execMock.mockImplementation(async (command: string) => {
        if (command.includes("list-sessions")) {
          const stdout = names
            .map((name, index) => `$${index + 1}:${name}:0:1`)
            .join("\n");
          return { stdout, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
    }

    it("returns the exact match when the name matches exactly", async () => {
      mockSessions("mcu_aux_1503", "scratch");
      const tmux = await import("../src/tmux.js");
      const sessions = await tmux.findSessions("mcu_aux_1503");
      expect(sessions.map((s) => s.name)).toEqual(["mcu_aux_1503"]);
    });

    it("falls back to a case-insensitive substring match", async () => {
      mockSessions("mcu_aux_1503", "mcu_aux_1781", "unrelated");
      const tmux = await import("../src/tmux.js");
      const sessions = await tmux.findSessions("AUX");
      expect(sessions.map((s) => s.name)).toEqual(["mcu_aux_1503", "mcu_aux_1781"]);
    });

    it("falls back to a regular-expression match", async () => {
      mockSessions("build-01", "build-02", "deploy-03");
      const tmux = await import("../src/tmux.js");
      const sessions = await tmux.findSessions("^build-0[12]$");
      expect(sessions.map((s) => s.name)).toEqual(["build-01", "build-02"]);
    });

    it("returns an empty array when nothing matches", async () => {
      mockSessions("alpha", "beta");
      const tmux = await import("../src/tmux.js");
      const sessions = await tmux.findSessions("gamma");
      expect(sessions).toEqual([]);
    });
  });

  describe("multi-word Tcl commands wrap and complete", () => {
    it("wraps a balanced multi-arg Tcl command and parses its output", async () => {
      execMock.mockImplementation(async (command: string) => {
        if (command.includes("capture-pane")) {
          return {
            stdout: [
              "::tmux_mcp::run 1 {set x {a b c}}",
              "TMUX_MCP_START_1",
              "a b c",
              "TMUX_MCP_DONE_0_1",
            ].join("\n"),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const tmux = await import("../src/tmux.js");
      tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

      const commandId = await tmux.executeCommand("%0", "set x {a b c}");

      const sentCommands = execMock.mock.calls.map((args) => args[0]);
      expect(sentCommands.some((cmd) => cmd.includes("::tmux_mcp::run 1 {set x {a b c}}"))).toBe(true);

      const status = await tmux.checkCommandStatus(commandId);
      expect(status?.status).toBe("completed");
      expect(status?.result).toBe("a b c");
    });
  });
});
