import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';

const exec = promisify(execCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

export interface CapturePaneOptions {
  lines?: number;
  start?: string | number;
  end?: string | number;
  includeColors?: boolean;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
  rawMode?: boolean;
}

export const supportedShellTypes = ['bash', 'zsh', 'fish', 'tclsh'] as const;
export type ShellType = typeof supportedShellTypes[number];

type ShellConfigState = {
  defaultType: ShellType;
  paneOverrides: Map<string, ShellType>;
};

const shellConfig: ShellConfigState = {
  defaultType: 'bash',
  paneOverrides: new Map()
};

function normalizeShellType(type: string): ShellType {
  return (supportedShellTypes as readonly string[]).includes(type)
    ? (type as ShellType)
    : 'bash';
}

export function setShellConfig(config: { type: string; paneId?: string }): void {
  const normalized = normalizeShellType(config.type);

  if (config.paneId) {
    shellConfig.paneOverrides.set(config.paneId, normalized);
    // Reset cached initialization so the helper can be installed on demand
    tclshInitializedPanes.delete(config.paneId);
    return;
  }

  shellConfig.defaultType = normalized;
  if (normalized !== 'tclsh') {
    tclshInitializedPanes.clear();
  }
}

function resolveShellType(paneId: string): ShellType {
  return shellConfig.paneOverrides.get(paneId) ?? shellConfig.defaultType;
}

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  try {
    const { stdout } = await exec(`tmux ${tmuxCommand}`);
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux("list-sessions -F '#{session_name}'");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
  const output = await executeTmux(`list-sessions -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, attached, windows] = line.split(':');
    return {
      id,
      name,
      attached: attached === '1',
      windows: parseInt(windows, 10)
    };
  });
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
  const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, active] = line.split(':');
    return {
      id,
      name,
      active: active === '1',
      sessionId
    };
  });
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
  const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, title, active] = line.split(':');
    return {
      id,
      windowId,
      title: title,
      active: active === '1'
    };
  });
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, options: CapturePaneOptions = {}): Promise<string> {
  const {
    lines = 200,
    start,
    end,
    includeColors = false
  } = options;

  const startValue = start !== undefined ? String(start) : `-${lines}`;
  const endValue = end !== undefined ? String(end) : '-';
  
  const commandParts = ['capture-pane', '-p'];

  if (includeColors) {
    commandParts.push('-e');
  }

  commandParts.push(
    '-t', `'${paneId}'`,
    '-S', startValue,
    '-E', endValue
  );

  return executeTmux(commandParts.join(' '));
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(`new-session -d -s "${name}"`);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${name}'`);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(`kill-session -t '${sessionId}'`);
}

/**
 * Kill a tmux window by ID
 */
export async function killWindow(windowId: string): Promise<void> {
  await executeTmux(`kill-window -t '${windowId}'`);
}

/**
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(`kill-pane -t '${paneId}'`);
}

/**
 * Split a tmux pane horizontally or vertically
 */
export async function splitPane(
  targetPaneId: string,
  direction: 'horizontal' | 'vertical' = 'vertical',
  size?: number
): Promise<TmuxPane | null> {
  // Build the split-window command
  let splitCommand = 'split-window';

  // Add direction flag (-h for horizontal, -v for vertical)
  if (direction === 'horizontal') {
    splitCommand += ' -h';
  } else {
    splitCommand += ' -v';
  }

  // Add target pane
  splitCommand += ` -t '${targetPaneId}'`;

  // Add size if specified (as percentage)
  if (size !== undefined && size > 0 && size < 100) {
    splitCommand += ` -p ${size}`;
  }

  // Execute the split command
  await executeTmux(splitCommand);

  // Get the window ID from the target pane to list all panes
  const windowInfo = await executeTmux(`display-message -p -t '${targetPaneId}' '#{window_id}'`);

  // List all panes in the window to find the newly created one
  const panes = await listPanes(windowInfo);

  // The newest pane is typically the last one in the list
  return panes.length > 0 ? panes[panes.length - 1] : null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";

// Track tclsh initialization per pane to keep terminal output minimal
const tclshInitializedPanes = new Set<string>();

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string, rawMode?: boolean, noEnter?: boolean): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  const shellType = resolveShellType(paneId);

  let fullCommand: string;
  if (rawMode || noEnter) {
    fullCommand = command;
  } else {
    if (shellType === 'tclsh') {
      await ensureTclshInitialized(paneId);
      fullCommand = buildTclshCommand(command);
    } else {
      fullCommand = buildWrappedCommand(command, shellType);
    }
  }

  // Store command in tracking map
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date(),
    rawMode: rawMode || noEnter
  });

  // Send the command to the tmux pane
  if (noEnter) {
    // Check if this is a special key (e.g., Up, Down, Left, Right, Escape, Tab, etc.)
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = ['Up', 'Down', 'Left', 'Right', 'Escape', 'Tab', 'Enter', 'Space',
      'BSpace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

    if (specialKeys.includes(fullCommand)) {
      // Send special key as-is
      await executeTmux(`send-keys -t '${paneId}' ${fullCommand}`);
    } else {
      // For regular text, send each character individually to ensure proper processing
      // This handles both single characters (like 'q', 'f') and strings (like 'beam')
      for (const char of fullCommand) {
        await executeTmux(`send-keys -t '${paneId}' '${char.replace(/'/g, "'\\''")}'`);
      }
    }
  } else {
    await executeTmux(`send-keys -t '${paneId}' '${fullCommand.replace(/'/g, "'\\''")}' Enter`);
  }

  return commandId;
}

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  const content = await capturePaneContent(command.paneId, { lines: 1000 });

  if (command.rawMode) {
    command.result = 'Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.';
    return command;
  }

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split('\n')[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? 'completed' : 'error';
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex).trim();

    const outputLines = outputContent ? outputContent.split('\n') : [];
    if (outputLines.length > 0) {
      const firstLine = outputLines[0].trim();
      if (firstLine === command.command.trim()) {
        outputLines.shift();
      }
    }

    command.result = outputLines.join('\n').trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function getEndMarkerText(shellType: ShellType): string {
  if (shellType === 'fish') {
    return `${endMarkerPrefix}$status`;
  }

  if (shellType === 'tclsh') {
    return `${endMarkerPrefix}$::tmux_mcp_status`;
  }

  return `${endMarkerPrefix}$?`;
}

function buildWrappedCommand(command: string, shellType: ShellType): string {
  const endMarkerText = getEndMarkerText(shellType);
  return `echo "${startMarkerText}"; ${command}; echo "${endMarkerText}"`;
}

function buildTclshCommand(command: string): string {
  return `::tmux_mcp::run {${command}}`;
}


async function ensureTclshInitialized(paneId: string): Promise<void> {
  if (tclshInitializedPanes.has(paneId)) {
    return;
  }

  const definitionCommand = [
    'namespace eval ::tmux_mcp {',
    'proc run {cmd} {',
    `puts "${startMarkerText}";`,
    'set status [catch {uplevel #0 $cmd} result opts];',
    'if {$status == 0} {',
    'if {[info exists result] && $result ne ""} { puts $result }',
    '} else {',
    'if {[info exists opts(-errorinfo)]} { puts $opts(-errorinfo) } else { puts $result }',
    '};',
    `puts "${endMarkerPrefix}$status"`,
    '}',
    '}'
  ].join(' ');

  const escapedCommand = definitionCommand.replace(/'/g, "'\\''");
  await executeTmux(`send-keys -t '${paneId}' '${escapedCommand}' Enter`);

  tclshInitializedPanes.add(paneId);
}
