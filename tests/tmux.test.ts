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

    // When start is explicitly provided, we always capture from beginning (-S -)
    // to avoid double-application of offset. JavaScript slicing handles the start offset.
    expect(execMock).toHaveBeenCalledWith("tmux capture-pane -p -e -t '%1' -S - -E -");
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

  it("handles unreliable tmux -S parameter: when start is provided, tmux may return more lines than requested", async () => {
    // Simulate tmux's unreliable behavior: -S -5 might return 7 lines instead of 5
    // because it depends on "current position" which can change
    execMock.mockImplementationOnce(async () => {
      // tmux was asked for -S -5 but returns 7 lines (more than requested)
      const lines: string[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(`buffer-line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Request last 5 lines, but tmux returns 7 due to unreliable -S
    const content = await tmux.capturePaneContent("%1", { lines: 5 });

    // JavaScript slicing should give us exactly the last 5 lines
    const resultLines = content.split("\n");
    expect(resultLines).toHaveLength(5);
    expect(resultLines[0]).toBe("buffer-line-2"); // Last 5 of 7 lines
    expect(resultLines[4]).toBe("buffer-line-6");
  });

  it("handles unreliable tmux -S with explicit start: always captures from beginning, JavaScript slicing is authoritative", async () => {
    // When start is provided, we always capture from the beginning (-S -) to avoid
    // double-application of offset. JavaScript slicing handles the start offset accurately.
    execMock.mockImplementationOnce(async () => {
      // After fix: we always capture from beginning when start is explicit
      // So tmux returns the full buffer (lines 0-19)
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(`absolute-line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Request start: 10 - should get lines 10-19
    const content = await tmux.capturePaneContent("%1", { start: 10 });

    // After fix: JavaScript slices from index 10 of the full buffer
    const resultLines = content.split("\n");
    expect(resultLines).toHaveLength(10); // Lines 10-19
    expect(resultLines[0]).toBe("absolute-line-10");
    expect(resultLines[9]).toBe("absolute-line-19");
    
    // Verify we called tmux with -S - (beginning) not -S 10
    const commands = execMock.mock.calls.map(args => args[0]);
    expect(commands[0]).toContain("capture-pane");
    expect(commands[0]).toContain("-S -"); // Should capture from beginning
    expect(commands[0]).not.toContain("-S 10"); // Should not use the start value
  });

  it("handles negative start values correctly when explicit start is provided", async () => {
    // Negative start values are relative to the end of the buffer
    execMock.mockImplementationOnce(async () => {
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push(`buffer-line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Request start: -10 (last 10 lines) - should get lines 20-29
    const content = await tmux.capturePaneContent("%1", { start: -10 });

    const resultLines = content.split("\n");
    expect(resultLines).toHaveLength(10); // Last 10 lines
    expect(resultLines[0]).toBe("buffer-line-20"); // Line 20 (30 - 10)
    expect(resultLines[9]).toBe("buffer-line-29"); // Line 29
    
    // Verify we captured from beginning
    const commands = execMock.mock.calls.map(args => args[0]);
    expect(commands[0]).toContain("-S -"); // Should capture from beginning
  });

  it("always uses -E - regardless of end parameter value, handles end in JavaScript", async () => {
    // -E has the same unreliability as -S: it depends on "current position" and may
    // capture "old" lines or miss the intended end point. We always use -E - and
    // handle end slicing entirely in JavaScript.
    execMock.mockImplementationOnce(async () => {
      const lines: string[] = [];
      for (let i = 0; i < 25; i++) {
        lines.push(`full-buffer-line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Request end: 15 - should get lines 0-15 (16 lines total)
    const content = await tmux.capturePaneContent("%1", { start: 0, end: 15 });

    const resultLines = content.split("\n");
    expect(resultLines).toHaveLength(16); // Lines 0-15 inclusive
    expect(resultLines[0]).toBe("full-buffer-line-0");
    expect(resultLines[15]).toBe("full-buffer-line-15");
    
    // Verify we always use -E - regardless of end parameter
    const commands = execMock.mock.calls.map(args => args[0]);
    expect(commands[0]).toContain("-E -"); // Should always use -E -
    expect(commands[0]).not.toContain("-E 15"); // Should not use the end value
  });

  it("handles negative end values correctly with JavaScript slicing", async () => {
    // Negative end values are relative to the end of the captured buffer
    // end: -5 means "exclude the last 5 lines", so with 30 lines total:
    // - Last 5 lines are indices 25-29
    // - We want to end at index 25 (exclusive), so last included is index 24
    // - With start: 5, we get indices 5-25 (exclusive), which is 21 elements (lines 5-25)
    execMock.mockImplementationOnce(async () => {
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push(`buffer-line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Request start: 5, end: -5 (exclude last 5 lines) - should get lines 5-25 (21 lines)
    const content = await tmux.capturePaneContent("%1", { start: 5, end: -5 });

    const resultLines = content.split("\n");
    // Current implementation: end: -5 with 30 lines gives sliceEnd = 30 + (-5) + 1 = 26
    // slice(5, 26) gives indices 5-25, which is 21 elements
    expect(resultLines).toHaveLength(21);
    expect(resultLines[0]).toBe("buffer-line-5");
    expect(resultLines[20]).toBe("buffer-line-25"); // Last included line (before the last 5)
    
    // Verify we always use -E -
    const commands = execMock.mock.calls.map(args => args[0]);
    expect(commands[0]).toContain("-E -");
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

  // Sequence numbers start at 1 because the counter is incremented before assignment in the implementation.
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
  // After removing the echoed command line, requested start=5 and end=9 refer to rows 5..9 in the original array.
  // The slice then picks rows 4..8 in the processed array (since one line was removed), so lineStartIndex is 5 and lineEndIndex is 10 (exclusive).
  expect(status?.returnedLines).toBe(5); // inclusive indices 5..9 mapped to 4..8 after shift
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
  // Expected behavior: command should still complete and parse exit code even if start marker missing
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

  // BUG FIX TEST 1: Positive start values in capturePaneContent
  it("respects positive start values when capturing pane content (Bug Fix #1)", async () => {
    execMock.mockImplementationOnce(async () => {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(`line-${i}`);
      }
      return { stdout: lines.join("\n"), stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    // Capture starting from line 10
    const content = await tmux.capturePaneContent("%0", { start: 10, end: 14 });
    
    const capturedLines = content.split("\n");
    expect(capturedLines).toHaveLength(5); // lines 10-14 inclusive
    expect(capturedLines[0]).toBe("line-10");
    expect(capturedLines[4]).toBe("line-14");
  });

  // BUG FIX TEST 2: Shell injection prevention in createSession
  it("escapes session names to prevent shell injection (Bug Fix #2)", async () => {
    execMock.mockImplementationOnce(async (command: string) => {
      // Verify the command has properly escaped single quotes
      return { stdout: "", stderr: "" };
    })
    .mockImplementationOnce(async () => {
      return { 
        stdout: "$1:safe'test:0:1",
        stderr: ""
      };
    });

    const tmux = await import("../src/tmux.js");
    // Try to inject a malicious command using single quote
    const maliciousName = "safe'test";
    await tmux.createSession(maliciousName);

    const commands = execMock.mock.calls.map(args => args[0]);
    // Verify the name is properly escaped with single quotes
    expect(commands[0]).toContain("new-session -d -s 'safe'\\''test'");
    // Ensure double quotes are NOT used (which would be vulnerable)
    expect(commands[0]).not.toMatch(/new-session -d -s ".*"/);
  });

  it("prevents command injection via session name with dangerous characters (Bug Fix #2)", async () => {
    execMock.mockImplementationOnce(async () => ({ stdout: "", stderr: "" }))
              .mockImplementationOnce(async () => ({ 
                stdout: "$1:test:0:1",
                stderr: ""
              }));

    const tmux = await import("../src/tmux.js");
    // Try various injection attempts
    const dangerousName = "test$(whoami)";
    await tmux.createSession(dangerousName);

    const commands = execMock.mock.calls.map(args => args[0]);
    // With single quotes, $() should not be expanded
    expect(commands[0]).toContain("new-session -d -s 'test$(whoami)'");
    // Verify it's using single quotes which prevent command substitution
    expect(commands[0]).toMatch(/new-session -d -s '[^"]*'/);
  });

  // BUG FIX TEST 3: Fish shell variable interpolation
  it("properly interpolates fish shell exit status variable (Bug Fix #3)", async () => {
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "TMUX_MCP_START_1",
            "echo fish-test",
            "echo fish-test",
            "fish-test",
            "TMUX_MCP_DONE_0_1"
          ].join("\n"),
          stderr: ""
        };
      }
      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "fish", paneId: "%0" });
    
    const commandId = await tmux.executeCommand("%0", "echo fish-test");
    
    const commands = execMock.mock.calls.map(args => args[0]);
    const sendKeysCmd = commands.find(c => c.includes("send-keys") && c.includes("fish-test"));
    
    // Verify fish shell uses braces around $status to prevent ambiguity
    // The pattern should be: TMUX_MCP_DONE_{$status}_1
    // NOT: TMUX_MCP_DONE_$status_1 (which fish would interpret as variable $status_1)
    expect(sendKeysCmd).toContain('TMUX_MCP_DONE_"{$status}"_1');
    
    const status = await tmux.checkCommandStatus(commandId);
    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toContain("fish-test");
    
    // Reset to bash
    tmux.setShellConfig({ type: "bash", paneId: "%0" });
  });

  it("bash and zsh use $? without braces (Bug Fix #3 - regression check)", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    
    // Test bash
    tmux.setShellConfig({ type: "bash", paneId: "%1" });
    await tmux.executeCommand("%1", "echo bash-test");
    
    let commands = execMock.mock.calls.map(args => args[0]);
    let bashCmd = commands[commands.length - 1];
    expect(bashCmd).toContain('TMUX_MCP_DONE_$?_');
    expect(bashCmd).not.toContain('{$?}');
    
    // Test zsh
    tmux.setShellConfig({ type: "zsh", paneId: "%2" });
    await tmux.executeCommand("%2", "echo zsh-test");
    
    commands = execMock.mock.calls.map(args => args[0]);
    let zshCmd = commands[commands.length - 1];
    expect(zshCmd).toContain('TMUX_MCP_DONE_$?_');
    expect(zshCmd).not.toContain('{$?}');
  });
});
