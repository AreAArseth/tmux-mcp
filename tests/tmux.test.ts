/// <reference types="vitest" />

import { afterEach, describe, expect, it, vi } from "vitest";

type ExecResult = Promise<{ stdout: string; stderr: string }>;

// Use loosely typed mock to bypass complex generic constraints
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

describe("tmux utilities", () => {
  afterEach(() => {
    vi.resetModules();
    execMock.mockReset();
  });

  it("parses session listings correctly", async () => {
  execMock.mockImplementationOnce(async (command: string) => {
      return {
        stdout: "$1:main:1:2\n$2:backup:0:5",
        stderr: ""
      };
    });

    const tmux = await import("../src/tmux.js");
    const sessions = await tmux.listSessions();
  const commands = execMock.mock.calls.map(args => args[0]);

    expect(commands).toEqual([
      "tmux list-sessions -F '#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}'"
    ]);
    expect(sessions).toEqual([
      { id: "$1", name: "main", attached: true, windows: 2 },
      { id: "$2", name: "backup", attached: false, windows: 5 }
    ]);
  });

  it("captures panes with explicit start and end offsets", async () => {
  execMock.mockImplementationOnce(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    await tmux.capturePaneContent("%1", { start: "0", end: "-", includeColors: true });

    expect(execMock).toHaveBeenCalledWith("tmux capture-pane -p -e -t '%1' -S 0 -E -");
  });

  it("slices captured pane output correctly for numeric start and '-' end", async () => {
    execMock.mockImplementationOnce(async () => ({
      stdout: ["prompt>", "line-0", "line-1", "line-2", "line-3"].join("\n"),
      stderr: ""
    }));

    const tmux = await import("../src/tmux.js");
    const content = await tmux.capturePaneContent("%1", { start: 2, end: "-" });

    expect(content).toBe(["line-1", "line-2", "line-3"].join("\n"));
  });

  it("splits panes with direction and size options", async () => {
    execMock
      .mockImplementationOnce(async () => {
        return { stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        return { stdout: "@1", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        return { stdout: "%0:editor:1\n%1:logs:0", stderr: "" };
      });

    const tmux = await import("../src/tmux.js");
    const newPane = await tmux.splitPane("%0", "horizontal", 40);
  const commands = execMock.mock.calls.map(args => args[0]);

    expect(commands).toEqual([
      "tmux split-window -h -t '%0' -p 40",
      "tmux display-message -p -t '%0' '#{window_id}'",
      "tmux list-panes -t '@1' -F '#{pane_id}:#{pane_title}:#{?pane_active,1,0}'"
    ]);
    expect(newPane).toEqual({
      id: "%1",
      windowId: "@1",
      title: "logs",
      active: false
    });
  });

  it("updates command status using pane capture markers", async () => {
    execMock
      .mockImplementationOnce(async () => {
        return { stdout: "", stderr: "" };
      })
      .mockImplementationOnce(async () => {
        return {
          stdout: ["prompt>", "TMUX_MCP_START_1", "ls", "package.json", "README.md", "TMUX_MCP_DONE_0_1"].join("\n"),
          stderr: ""
        };
      });

    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%0", "ls");
    const status = await tmux.checkCommandStatus(commandId);
  const commands = execMock.mock.calls.map(args => args[0]);

  // Sequence numbers start at 1 now
  expect(commands[0]).toMatch(/tmux send-keys -t '%0' 'echo "TMUX_MCP_START_1"; ls; echo "TMUX_MCP_DONE_\$\?_1"' Enter/);
  expect(commands[1]).toBe("tmux capture-pane -p -t '%0' -S - -E -");
    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toBe("package.json\nREADME.md");
  });

  it("returns only last DEFAULT_RESULT_LINES when output is large and no options provided", async () => {
    // First call: send keys
    execMock
      .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
      // Second call: capture-pane returns large output
      .mockImplementationOnce(async () => {
  const lines: string[] = ["TMUX_MCP_START_1", "echo big", "echoed big start"];
        for (let i = 0; i < 150; i++) {
          lines.push(`line-${i}`);
        }
  lines.push("TMUX_MCP_DONE_0_1");
        return { stdout: lines.join("\n"), stderr: "" };
      });

    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%0", "echo big");
    const status = await tmux.checkCommandStatus(commandId);
    expect(status).not.toBeNull();
    expect(status?.returnedLines).toBe(100); // DEFAULT_RESULT_LINES
    expect(status?.truncated).toBe(true);
    // Should start from line-50 through line-149 (100 lines)
    expect(status?.result?.split("\n")[0]).toMatch(/line-50/);
    expect(status?.result?.split("\n").slice(-1)[0]).toMatch(/line-149/);
  });

  it("supports explicit line slicing via start/end options", async () => {
    execMock
      .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
      .mockImplementationOnce(async () => {
  const lines: string[] = ["TMUX_MCP_START_1", "echo slice", "echo slice"];
        for (let i = 0; i < 20; i++) {
          lines.push(`row-${i}`);
        }
  lines.push("TMUX_MCP_DONE_0_1");
        return { stdout: lines.join("\n"), stderr: "" };
      });
    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%0", "echo slice");
    const status = await tmux.checkCommandStatus(commandId, { start: 5, end: 9 });
  // Because the echoed command line was removed, indices shift: slice picks rows 4..8
  expect(status?.returnedLines).toBe(5); // inclusive indices 5..9 mapped to 4..8 after shift
  expect(status?.lineStartIndex).toBe(5); // underlying index after removal logic
  expect(status?.lineEndIndex).toBe(10);
  expect(status?.result).toBe(["row-4","row-5","row-6","row-7","row-8"].join("\n"));
  });

  it("supports grep of stored output lines", async () => {
    execMock
      .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
      .mockImplementationOnce(async () => {
  const lines: string[] = ["TMUX_MCP_START_1", "echo grep", "echo grep", "Info: all good", "Error: something broke", "Warning: beware", "Error: failed again", "TMUX_MCP_DONE_0_1"];        
        return { stdout: lines.join("\n"), stderr: "" };
      });
    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%0", "echo grep");
    const status = await tmux.checkCommandStatus(commandId);
    expect(status?.status).toBe("completed");
    const errorLines = tmux.grepCommandOutput(commandId, "^Error:");
    expect(errorLines).toEqual(["Error: something broke", "Error: failed again"]);
  });

  it("treats command as completed when end marker present even if start marker lost (expected new behavior)", async () => {
    // First call sends command
    execMock
      .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
      // Second call simulates capture-pane with end marker but missing start marker (scrolled out)
      .mockImplementationOnce(async () => {
        const lines: string[] = [];
        // Simulate massive output without start marker present in captured 1000 lines
        for (let i = 0; i < 995; i++) {
          lines.push(`data-${i}`);
        }
        lines.push("ls"); // original command echoed
        lines.push("fileA");
        lines.push("fileB");
  lines.push("TMUX_MCP_DONE_0_1"); // end marker only
        return { stdout: lines.join("\n"), stderr: "" };
      });

    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%9", "ls");
  const status = await tmux.checkCommandStatus(commandId);
  // Desired future behavior: command should still complete and parse exit code even if start marker missing
  expect(status?.status).toBe("completed");
  expect(status?.exitCode).toBe(0);
  // Expect output to include all lines except the echoed command and end marker
  expect(status?.result?.includes("fileA")).toBe(true);
  expect(status?.result?.includes("fileB")).toBe(true);
  // Ensure we captured more than just tail snapshot (large output scenario)
  expect((status?.result || '').split('\n').length).toBeGreaterThan(10);
  });

    it("escapes session names to prevent command injection when creating sessions", async () => {
      execMock
        .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
        .mockImplementationOnce(async () => ({
          stdout: "$1:unsafe'Name:0:1",
          stderr: ""
        }));

      const tmux = await import("../src/tmux.js");
      await tmux.createSession("unsafe'Name");

      const firstCommand = execMock.mock.calls[0][0];
      expect(firstCommand).toBe("tmux new-session -d -s 'unsafe'\\''Name'");
    });

    it("escapes window names when creating windows", async () => {
      execMock
        .mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
        .mockImplementationOnce(async () => ({
          stdout: "@1:unsafe'Window:1",
          stderr: ""
        }));

      const tmux = await import("../src/tmux.js");
      const window = await tmux.createWindow("$1", "unsafe'Window");

      const firstCommand = execMock.mock.calls[0][0];
      expect(firstCommand).toBe("tmux new-window -t '$1' -n 'unsafe'\\''Window'");
      expect(window?.name).toBe("unsafe'Window");
    });

  it("wraps tclsh commands and preserves Tcl output", async () => {
  execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "::tmux_mcp::run 1 {expr 1+2}",
            "TMUX_MCP_START_1",
            "3",
            "TMUX_MCP_DONE_0_1"
          ].join("\n"),
          stderr: ""
        };
      }

      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    const commandId = await tmux.executeCommand("%0", "expr 1+2");

  const commandsAfterExecute = execMock.mock.calls.map(args => args[0]);
  expect(commandsAfterExecute.some((cmd) => cmd.includes("namespace eval ::tmux_mcp {"))).toBe(true);
  const tclWrapped = commandsAfterExecute.find(c => c.includes("::tmux_mcp::run 1 {expr 1+2}"));
  expect(tclWrapped).toBeDefined();

    const status = await tmux.checkCommandStatus(commandId);

    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toBe("3");
  });

  it("supports default tclsh shell configuration", async () => {
  execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "::tmux_mcp::run 1 {expr 5+6}",
            "TMUX_MCP_START_1",
            "11",
            "TMUX_MCP_DONE_0_1"
          ].join("\n"),
          stderr: ""
        };
      }

      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh" });

    const commandId = await tmux.executeCommand("%0", "expr 5+6");

  const commandsAfterExecute = execMock.mock.calls.map(args => args[0]);
  expect(commandsAfterExecute.some((cmd) => cmd.includes("namespace eval ::tmux_mcp {"))).toBe(true);
  const tclWrapped = commandsAfterExecute.find(c => c.includes("::tmux_mcp::run 1 {expr 5+6}"));
  expect(tclWrapped).toBeDefined();

    const status = await tmux.checkCommandStatus(commandId);

    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toBe("11");
  });

  it("initializes tclsh helper only once per pane", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    await tmux.executeCommand("%0", "expr 1+2");
    await tmux.executeCommand("%0", "expr 3+4");

    const initCalls = execMock.mock.calls
      .map(args => args[0])
      .filter((cmd: string) => cmd.includes("namespace eval ::tmux_mcp {"));

    expect(initCalls).toHaveLength(1);
  });

  it("supports per-pane shell overrides", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");

    tmux.setShellConfig({ type: "tclsh", paneId: "%0" });

    await tmux.executeCommand("%0", "expr 1+2");
    await tmux.executeCommand("%1", "ls");

  const commands = execMock.mock.calls.map(args => args[0]);

  expect(commands.some((cmd) => cmd.includes("namespace eval ::tmux_mcp { proc run {seq cmd} {"))).toBe(true);
  expect(commands.some((cmd) => cmd.includes("::tmux_mcp::run 1 {expr 1+2}"))).toBe(true);
  const bashSeqCmd = commands.find(c => c.includes("tmux send-keys -t '%1' 'echo \"TMUX_MCP_START_2\"; ls; echo \"TMUX_MCP_DONE_\$\?_2\"' Enter"));
  expect(bashSeqCmd).toBeDefined();

    tmux.setShellConfig({ type: "bash", paneId: "%0" });
    await tmux.executeCommand("%0", "pwd");

  const resetCommands = execMock.mock.calls.map(args => args[0]);
    const bashCommand = resetCommands.find((cmd) => cmd.includes("tmux send-keys -t '%0'") && cmd.includes("pwd") && cmd.includes("TMUX_MCP_DONE_$?"));

    expect(bashCommand).toBeDefined();
  });

  it("cleans up completed commands older than the max age", async () => {
    execMock.mockImplementationOnce(async () => {
      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%1", "echo test");

    const command = tmux.getCommand(commandId);
    expect(command).not.toBeNull();

    if (command) {
      command.status = "completed";
      command.startTime = new Date(Date.now() - 61 * 60 * 1000);
    }

    tmux.cleanupOldCommands(60);

  const commands = execMock.mock.calls.map(args => args[0]);
  expect(commands[0]).toMatch(/echo "TMUX_MCP_START_1"; echo test; echo "TMUX_MCP_DONE_\$\?_1"/);
    expect(tmux.getActiveCommandIds()).not.toContain(commandId);
  });
});
