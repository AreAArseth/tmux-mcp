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

const describeIfTmux = tmuxAvailable ? describe : describe.skip;

describeIfTmux("tmux integration", () => {
  const sessionName = `mcp-test-${process.pid}-${Date.now()}`;
  let session: tmux.TmuxSession | null = null;
  let primaryWindowId: string | null = null;
  let primaryPaneId: string | null = null;

  beforeAll(async () => {
    tmux.setShellConfig({ type: "bash" });
    session = await tmux.createSession(sessionName);
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
    let status = await tmux.checkCommandStatus(commandId);

    for (let attempt = 0; attempt < 20 && status?.status === "pending"; attempt++) {
      await delay(200);
      status = await tmux.checkCommandStatus(commandId);
    }

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.result ?? "").toContain("integration-check");
  });

  (zshAvailable ? it : it.skip)("runs commands when configured for zsh shells", async () => {
    expect(primaryPaneId).not.toBeNull();
    if (!primaryPaneId) return;

    tmux.setShellConfig({ type: "zsh" });
    const commandId = await tmux.executeCommand(primaryPaneId, "echo zsh-integration");
    let status = await tmux.checkCommandStatus(commandId);

    for (let attempt = 0; attempt < 20 && status?.status === "pending"; attempt++) {
      await delay(200);
      status = await tmux.checkCommandStatus(commandId);
    }

    tmux.setShellConfig({ type: "bash" });

    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
    expect(status?.result ?? "").toContain("zsh-integration");
  });
});
