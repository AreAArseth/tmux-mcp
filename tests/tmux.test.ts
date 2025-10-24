/// <reference types="vitest" />

import { afterEach, describe, expect, it, vi } from "vitest";

type ExecResult = Promise<{ stdout: string; stderr: string }>;

const execMock = vi.fn<(command: string) => ExecResult>();

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
    execMock.mockImplementationOnce(async (command) => {
      return {
        stdout: "$1:main:1:2\n$2:backup:0:5",
        stderr: ""
      };
    });

    const tmux = await import("../src/tmux.js");
    const sessions = await tmux.listSessions();
    const commands = execMock.mock.calls.map(([cmd]) => cmd);

    expect(commands).toEqual([
      "tmux list-sessions -F '#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}'"
    ]);
    expect(sessions).toEqual([
      { id: "$1", name: "main", attached: true, windows: 2 },
      { id: "$2", name: "backup", attached: false, windows: 5 }
    ]);
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
    const commands = execMock.mock.calls.map(([cmd]) => cmd);

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
          stdout: ["prompt>", "TMUX_MCP_START", "ls", "package.json", "README.md", "TMUX_MCP_DONE_0"].join("\n"),
          stderr: ""
        };
      });

    const tmux = await import("../src/tmux.js");
    const commandId = await tmux.executeCommand("%0", "ls");
    const status = await tmux.checkCommandStatus(commandId);
    const commands = execMock.mock.calls.map(([cmd]) => cmd);

    expect(commands[0]).toBe(
      "tmux send-keys -t '%0' 'echo \"TMUX_MCP_START\"; ls; echo \"TMUX_MCP_DONE_$?\"' Enter"
    );
    expect(commands[1]).toBe("tmux capture-pane -p  -t '%0' -S -1000 -E -");
    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toBe("package.json\nREADME.md");
  });

  it("wraps fc_shell commands and preserves Tcl output", async () => {
    execMock.mockImplementation(async (command) => {
      if (command.includes("capture-pane")) {
        return {
          stdout: [
            "::tmux_mcp::run {expr 1+2}",
            "TMUX_MCP_START",
            "3",
            "TMUX_MCP_DONE_0"
          ].join("\n"),
          stderr: ""
        };
      }

      return { stdout: "", stderr: "" };
    });

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "fc_shell", paneId: "%0" });

    const commandId = await tmux.executeCommand("%0", "expr 1+2");

    const commandsAfterExecute = execMock.mock.calls.map(([cmd]) => cmd);
    expect(commandsAfterExecute.some((cmd) => cmd.includes("namespace eval ::tmux_mcp {"))).toBe(true);
    expect(commandsAfterExecute).toContain("tmux send-keys -t '%0' '::tmux_mcp::run {expr 1+2}' Enter");

    const status = await tmux.checkCommandStatus(commandId);

    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result).toBe("3");
  });

  it("initializes fc_shell helper only once per pane", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");
    tmux.setShellConfig({ type: "fc_shell", paneId: "%0" });

    await tmux.executeCommand("%0", "expr 1+2");
    await tmux.executeCommand("%0", "expr 3+4");

    const initCalls = execMock.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.includes("namespace eval ::tmux_mcp {"));

    expect(initCalls).toHaveLength(1);
  });

  it("supports per-pane shell overrides", async () => {
    execMock.mockImplementation(async () => ({ stdout: "", stderr: "" }));

    const tmux = await import("../src/tmux.js");

    tmux.setShellConfig({ type: "fc_shell", paneId: "%0" });

    await tmux.executeCommand("%0", "expr 1+2");
    await tmux.executeCommand("%1", "ls");

    const commands = execMock.mock.calls.map(([cmd]) => cmd);

    expect(commands.some((cmd) => cmd.includes("namespace eval ::tmux_mcp { proc run {cmd} {"))).toBe(true);
    expect(commands).toContain("tmux send-keys -t '%0' '::tmux_mcp::run {expr 1+2}' Enter");
    expect(commands).toContain("tmux send-keys -t '%1' 'echo \"TMUX_MCP_START\"; ls; echo \"TMUX_MCP_DONE_$?\"' Enter");

    tmux.setShellConfig({ type: "bash", paneId: "%0" });
    await tmux.executeCommand("%0", "pwd");

    const resetCommands = execMock.mock.calls.map(([cmd]) => cmd);
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

    const commands = execMock.mock.calls.map(([cmd]) => cmd);
    expect(commands).toEqual([
      "tmux send-keys -t '%1' 'echo \"TMUX_MCP_START\"; echo test; echo \"TMUX_MCP_DONE_$?\"' Enter"
    ]);
    expect(tmux.getActiveCommandIds()).not.toContain(commandId);
  });
});
