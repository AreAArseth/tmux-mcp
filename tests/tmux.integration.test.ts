/// <reference types="vitest" />

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as tmux from "../src/tmux.js";

const tmuxAvailable = (() => {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const zshAvailable = (() => {
  try {
    execSync("zsh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tclshAvailable = (() => {
  try {
    execSync("tclsh", { input: "exit\n", stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
})();

const describeIfTmux = tmuxAvailable ? describe : describe.skip;

describeIfTmux("tmux integration", () => {
  const sessionName = `mcp-test-${process.pid}-${Date.now()}`;
  let session: tmux.TmuxSession | null = null;
  let primaryWindowId: string | null = null;
  let primaryPaneId: string | null = null;

  const waitForCommandCompletion = (commandId: string) => tmux.waitForCompletion(commandId, 10000, 150);

  async function waitForTclPrompt(): Promise<boolean> {
    if (!primaryPaneId) {
      return false;
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      const paneSnapshot = await tmux.capturePaneContent(primaryPaneId, { lines: 20 });
      const hasPrompt = paneSnapshot
        .split("\n")
        .some((line) => line.trim() === "%");

      if (hasPrompt) {
        return true;
      }

      await delay(200);
    }

    return false;
  }

  beforeAll(async () => {
    tmux.setShellConfig({ type: "bash" });
  session = await tmux.createSession(sessionName, { minimal: true });
    expect(session).not.toBeNull();
    if (!session) return;

    for (let i = 0; i < 10 && !primaryWindowId; i++) {
      const windows = await tmux.listWindows(session.id);
      if (windows.length > 0) {
        primaryWindowId = windows[0].id;
        break;
      }
      await delay(100);
    }
    expect(primaryWindowId).not.toBeNull();

    if (!primaryWindowId) return;

    for (let i = 0; i < 10 && !primaryPaneId; i++) {
      const panes = await tmux.listPanes(primaryWindowId);
      if (panes.length > 0) {
        primaryPaneId = panes[0].id;
        break;
      }
      await delay(100);
    }
    expect(primaryPaneId).not.toBeNull();

  });

  afterAll(async () => {
    tmux.setShellConfig({ type: "bash" });
    if (session) {
      try {
        await tmux.killSession(session.id);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it("detects the newly created session", async () => {
    expect(session).not.toBeNull();
    if (!session) return;
    const sessions = await tmux.listSessions();
    expect(sessions.some((s) => s.name === sessionName)).toBe(true);
  });

  it("creates and lists windows and panes", async () => {
    expect(session).not.toBeNull();
    if (!session) return;

    const windowName = `${sessionName}-win`;
    const newWindow = await tmux.createWindow(session.id, windowName);
    expect(newWindow).not.toBeNull();
    if (!newWindow) return;

    const windows = await tmux.listWindows(session.id);
    expect(windows.some((w) => w.name === windowName)).toBe(true);

    const panes = await tmux.listPanes(newWindow.id);
    expect(panes.length).toBeGreaterThan(0);
  });

  it("executes commands within a pane and captures output", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    const commandId = await tmux.executeCommand(primaryPaneId, "echo integration-check");
    const status = await waitForCommandCompletion(commandId);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.result ?? "").toContain("integration-check");
  });

  it("captures stderr output for successful commands", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    tmux.setShellConfig({ type: "bash", paneId: primaryPaneId });
  // Avoid spawning a login shell; run directly in existing pane shell
  const commandId = await tmux.executeCommand(primaryPaneId, "echo 'stderr-only' 1>&2");
    const status = await waitForCommandCompletion(commandId);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.exitCode).toBe(0);
    expect(status?.result ?? "").toContain("stderr-only");
  });

  it("propagates non-zero exit codes and stderr content", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    tmux.setShellConfig({ type: "bash", paneId: primaryPaneId });
  // Use a subshell so exit doesn't terminate the pane shell
  const commandId = await tmux.executeCommand(primaryPaneId, "(echo 'failure' 1>&2; exit 17)");
    const status = await waitForCommandCompletion(commandId);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("error");
    expect(status?.exitCode).toBe(17);
    expect(status?.result ?? "").toContain("failure");
  });

  it("reports unusual exit codes without output", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    tmux.setShellConfig({ type: "bash", paneId: primaryPaneId });
  // Use subshell for non-zero exit code without output
  const commandId = await tmux.executeCommand(primaryPaneId, "(exit 123)");
    const status = await waitForCommandCompletion(commandId);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("error");
    expect(status?.exitCode).toBe(123);
    expect((status?.result ?? "").trim()).toBe("");
  });

  (zshAvailable ? it : it.skip)("runs commands when configured for zsh shells", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    tmux.setShellConfig({ type: "zsh" });
    const commandId = await tmux.executeCommand(primaryPaneId, "echo zsh-integration");
    const status = await waitForCommandCompletion(commandId);

    tmux.setShellConfig({ type: "bash" });

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.result ?? "").toContain("zsh-integration");
  });

  (tclshAvailable ? it : it.skip)("runs commands when configured for tclsh shells", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    await tmux.executeCommand(primaryPaneId, "tclsh", true);
    const promptReady = await waitForTclPrompt();
    expect(promptReady).toBe(true);

    tmux.setShellConfig({ type: "tclsh", paneId: primaryPaneId });
    const commandId = await tmux.executeCommand(primaryPaneId, "expr 4+5");
    const status = await waitForCommandCompletion(commandId);

    tmux.setShellConfig({ type: "bash", paneId: primaryPaneId });
    await tmux.executeCommand(primaryPaneId, "exit", true);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.result).toBe("9");
  }, 15000);

  (tclshAvailable ? it : it.skip)("reports tclsh command errors", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    await tmux.executeCommand(primaryPaneId, "tclsh", true);
    const promptReady = await waitForTclPrompt();
    expect(promptReady).toBe(true);

    tmux.setShellConfig({ type: "tclsh", paneId: primaryPaneId });
    const commandId = await tmux.executeCommand(primaryPaneId, "expr 1/0");
    const status = await waitForCommandCompletion(commandId);

    tmux.setShellConfig({ type: "bash", paneId: primaryPaneId });
    await tmux.executeCommand(primaryPaneId, "exit", true);

    expect(status).not.toBeNull();
    expect(status?.status).toBe("error");
    expect(status?.exitCode).toBe(1);
    expect(status?.result ?? "").toContain("divide by zero");
  }, 15000);

  it("captures distinct outputs for multiple sequential commands", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    // Execute three commands one after another, waiting only after all started
    const id1 = await tmux.executeCommand(primaryPaneId, "echo first-marker");
    const id2 = await tmux.executeCommand(primaryPaneId, "echo second-marker");
    const id3 = await tmux.executeCommand(primaryPaneId, "echo third-marker");

    // Wait for each to complete in order
    const s1 = await waitForCommandCompletion(id1);
    const s2 = await waitForCommandCompletion(id2);
    const s3 = await waitForCommandCompletion(id3);

    expect(s1?.status).toBe("completed");
    expect(s2?.status).toBe("completed");
    expect(s3?.status).toBe("completed");
    expect(s1?.result).toContain("first-marker");
    expect(s2?.result).toContain("second-marker");
    expect(s3?.result).toContain("third-marker");
    // Ensure outputs are not mixed (each should only contain its own marker string)
    expect(s1?.result?.includes("second-marker")).toBe(false);
    expect(s1?.result?.includes("third-marker")).toBe(false);
    expect(s2?.result?.includes("first-marker")).toBe(false);
    expect(s2?.result?.includes("third-marker")).toBe(false);
    expect(s3?.result?.includes("first-marker")).toBe(false);
    expect(s3?.result?.includes("second-marker")).toBe(false);
  }, 15000);
});
