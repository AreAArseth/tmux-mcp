import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';

const exec = promisify(execCallback);

// Debug helper (enable by setting env TMUX_MCP_DEBUG=1 when launching server)
const DEBUG_ENABLED = process.env.TMUX_MCP_DEBUG === '1';
function debug(...args: any[]) {
  if (DEBUG_ENABLED) {
    // stderr to avoid interfering with captured pane content
    console.error('[tmux-mcp-debug]', ...args);
  }
}

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
  // Full untrimmed output between markers (without echoed command line)
  fullResult?: string;
  // Output lines array cached for slicing and grep operations
  outputLines?: string[];
  // Metadata when slicing
  truncated?: boolean;
  totalLines?: number;
  returnedLines?: number;
  lineStartIndex?: number;
  lineEndIndex?: number; // exclusive
  markerStartLost?: boolean; // true when start marker scrolled out but end marker found
  sequenceNumber?: number; // ordering among wrapped commands for pairing markers
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

function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
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
 * Note: tmux's -S and -E flags are unreliable due to cursor position,
 * so we capture a range and slice in JavaScript.
 */
export async function capturePaneContent(paneId: string, options: CapturePaneOptions = {}): Promise<string> {
  const {
    lines = 200,
    start,
    end,
    includeColors = false
  } = options;

  // Determine start value for tmux capture
  // We'll use this to capture enough data, then slice accurately
  let tmuxStart: string;
  if (start !== undefined) {
    tmuxStart = String(start);
  } else if (lines === 0) {
    // Capture all available lines
    tmuxStart = '-'; // start from the beginning of history
  } else {
    // Default: capture the last N lines from history
    tmuxStart = `-${lines}`;
  }

  const commandParts = ['capture-pane', '-p'];

  if (includeColors) {
    commandParts.push('-e');
  }

  commandParts.push(
    '-t', `'${paneId}'`,
    '-S', tmuxStart,
    '-E', '-'  // Always use '-' for end because specific line numbers are unreliable
  );

  const capturedLines = await executeTmux(commandParts.join(' '));

  // Now slice the output in JavaScript for accurate results
  const linesArray = capturedLines.split('\n');

  // Calculate actual slice indices
  let sliceStart = 0;
  let sliceEnd = linesArray.length;

  const resolveEndIndex = (value: string | number | undefined): number => {
    if (value === undefined) {
      if (lines !== undefined && lines > 0 && start === undefined) {
        return linesArray.length;
      }
      return sliceEnd;
    }

    const normalized = typeof value === 'number'
      ? value
      : value === '-'
        ? linesArray.length - 1
        : Number(value);

    if (Number.isNaN(normalized)) {
      return linesArray.length;
    }

    if (normalized < 0) {
      return Math.max(0, linesArray.length + normalized + 1);
    }

    return Math.min(linesArray.length, normalized + 1);
  };

  if (start !== undefined) {
    const startValue = typeof start === 'number'
      ? start
      : start === '-'
        ? 0
        : Number(start);

    if (!Number.isNaN(startValue)) {
      sliceStart = startValue < 0
        ? Math.max(0, linesArray.length + startValue)
        : Math.min(linesArray.length, startValue);
    }
  } else if (lines !== undefined && lines > 0) {
    sliceStart = Math.max(0, linesArray.length - lines);
  }

  if (end !== undefined) {
    const endValue = typeof end === 'number'
      ? end
      : end === '-'
        ? linesArray.length - 1
        : Number(end);

    if (Number.isNaN(endValue)) {
      sliceEnd = linesArray.length;
    } else if (endValue < 0) {
      sliceEnd = Math.max(0, linesArray.length + endValue + 1);
    } else {
      sliceEnd = Math.min(linesArray.length, endValue + 1);
    }
  }

  if (sliceEnd < sliceStart) {
    sliceEnd = sliceStart;
  }

  return linesArray.slice(sliceStart, sliceEnd).join('\n');
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string, options?: { minimal?: boolean; shellCommand?: string }): Promise<TmuxSession | null> {
  // Allow launching with a minimal shell to skip startup scripts.
  const safeName = escapeForSingleQuotes(name);
  let launchCmd = `new-session -d -s '${safeName}'`;
  if (options?.minimal) {
    const shell = options.shellCommand || 'bash --noprofile --norc';
    // Quote shell command separately so user shell isn't expanded prematurely.
    launchCmd += ` '${shell.replace(/'/g, "'\\''")}'`;
  } else if (options?.shellCommand) {
    launchCmd += ` '${options.shellCommand.replace(/'/g, "'\\''")}'`;
  }
  await executeTmux(launchCmd);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const safeName = escapeForSingleQuotes(name);
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${safeName}'`);
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

const startMarkerBase = 'TMUX_MCP_START';
const endMarkerBase = 'TMUX_MCP_DONE';
const DEFAULT_RESULT_LINES = 100; // default number of lines returned when output is large
type OutputSliceOptions = { lines?: number; start?: number; end?: number };

function hasSliceOptions(options?: OutputSliceOptions): boolean {
  return Boolean(options && (options.lines !== undefined || options.start !== undefined || options.end !== undefined));
}

function computeSliceBounds(totalLines: number, options?: OutputSliceOptions, defaultLimit?: number): { start: number; end: number } {
  let sliceStart = 0;
  let sliceEnd = totalLines;

  if (options?.start !== undefined || options?.end !== undefined) {
    if (options.start !== undefined) {
      sliceStart = Math.max(0, options.start);
    }
    if (options.end !== undefined) {
      sliceEnd = Math.min(totalLines, options.end + 1);
    }
  } else if (options?.lines !== undefined) {
    sliceStart = Math.max(0, totalLines - options.lines);
  } else if (defaultLimit !== undefined && totalLines > defaultLimit) {
    sliceStart = Math.max(0, totalLines - defaultLimit);
  }

  if (sliceEnd < sliceStart) {
    sliceEnd = sliceStart;
  }

  return { start: sliceStart, end: sliceEnd };
}

function applyOutputSlicing(command: CommandExecution, options?: OutputSliceOptions): void {
  if (!command.outputLines) {
    return;
  }

  const defaultLimit = hasSliceOptions(options) ? undefined : DEFAULT_RESULT_LINES;
  const { start: sliceStart, end: sliceEnd } = computeSliceBounds(command.outputLines.length, options, defaultLimit);
  const finalLines = command.outputLines.slice(sliceStart, sliceEnd);

  command.result = finalLines.join('\n').trim();
  command.returnedLines = finalLines.length;
  command.lineStartIndex = sliceStart;
  command.lineEndIndex = sliceEnd;
  command.totalLines = command.outputLines.length;
  command.truncated = command.outputLines.length > finalLines.length || Boolean(command.markerStartLost);
}

// Track tclsh initialization per pane to keep terminal output minimal
const tclshInitializedPanes = new Set<string>();
let wrappedCommandSequenceCounter = 0; // incremented for each non-raw wrapped command (sequence numbers)

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string, rawMode?: boolean, noEnter?: boolean): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  const shellType = resolveShellType(paneId);

  const sequenceNumber = (!rawMode && !noEnter) ? (wrappedCommandSequenceCounter + 1) : undefined;
  debug('executeCommand: preparing', { paneId, command, rawMode, noEnter, shellType, sequenceNumber });
  let fullCommand: string;
  if (rawMode || noEnter) {
    fullCommand = command;
  } else {
    if (shellType === 'tclsh') {
      await ensureTclshInitialized(paneId);
      fullCommand = buildTclshCommand(command, sequenceNumber!);
    } else {
      fullCommand = buildWrappedCommand(command, shellType, sequenceNumber!);
    }
  debug('executeCommand: wrapped command', fullCommand);
  }

  // Store command in tracking map
  if (sequenceNumber) {
    wrappedCommandSequenceCounter = sequenceNumber; // commit increment
  }
  debug('executeCommand: sending keys', { paneId, fullCommand, noEnter });

  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date(),
    rawMode: rawMode || noEnter,
    sequenceNumber
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

export async function checkCommandStatus(commandId: string, options?: OutputSliceOptions): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') {
    if (command.outputLines && (hasSliceOptions(options) || command.result === undefined)) {
      applyOutputSlicing(command, options);
      activeCommands.set(commandId, command);
    }
    return command;
  }

  const content = await capturePaneContent(command.paneId, { lines: 0 }); // capture entire scrollback to avoid missing markers
  debug('checkCommandStatus: captured content length', content.length, 'lines approx', content.split('\n').length);

  if (command.rawMode) {
    command.result = 'Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.';
    return command;
  }

  // Build marker blocks keyed by sequence number.
  const linesArr = content.split('\n');
  interface Block { startLine?: number; endLine: number; exitCode: number; seq: number; }
  const blocksBySeq = new Map<number, Block>();
  let lastEndLine = -1;
  for (let i = 0; i < linesArr.length; i++) {
    const line = linesArr[i].trim();
    // Start marker pattern: TMUX_MCP_START_<seq>
    const startMatch = line.match(new RegExp(`^${startMarkerBase}_(\\d+)$`));
    if (startMatch) {
      const seq = parseInt(startMatch[1], 10);
      const existing = blocksBySeq.get(seq) || { endLine: -1, exitCode: -1, seq };
      existing.startLine = i;
      blocksBySeq.set(seq, existing);
    debug('checkCommandStatus: start marker found', { seq, lineIndex: i, line });
      continue;
    }
    // End marker pattern: TMUX_MCP_DONE_<exit>_<seq>
    const endMatch = line.match(new RegExp(`^${endMarkerBase}_(\\d+)_([0-9]+)$`));
    if (endMatch) {
      const exitCode = parseInt(endMatch[1], 10);
      const seq = parseInt(endMatch[2], 10);
      const existing = blocksBySeq.get(seq) || { startLine: undefined, endLine: i, exitCode, seq };
      existing.endLine = i;
      existing.exitCode = exitCode;
      // If startLine missing (scrolled out), approximate start as previous end + 1
      if (existing.startLine === undefined && lastEndLine >= 0) {
        existing.startLine = lastEndLine + 1;
      }
      blocksBySeq.set(seq, existing);
      lastEndLine = i;
    debug('checkCommandStatus: end marker found', { seq, exitCode, lineIndex: i, line });
    }
  }
  debug('checkCommandStatus: blocks summary', Array.from(blocksBySeq.values()));

  // Determine this command's block by sequenceNumber ordering
  const sequenceNumber = command.sequenceNumber;
  if (sequenceNumber === undefined) {
    // Raw mode: keep showing tail
    const tail = linesArr.slice(-10).join('\n').trim();
    command.result = tail ? tail : '(no recent output)';
    return command;
  }

  const block = sequenceNumber !== undefined ? blocksBySeq.get(sequenceNumber) : undefined;
  if (!block) {
    // Not completed yet; show tail snapshot
    const tail = linesArr.slice(-10).join('\n').trim();
    command.result = tail ? tail : '(no recent output)';
  debug('checkCommandStatus: block not yet complete', { sequenceNumber, tailPreview: command.result });
    return command;
  }

  // If end marker not yet observed (endLine < 0), keep pending and show tail preview
  if (block.endLine < 0) {
    const tail = linesArr.slice(-10).join('\n').trim();
    command.result = tail ? tail : '(no recent output)';
    debug('checkCommandStatus: end marker missing, still pending', { sequenceNumber, tailPreview: command.result });
    return command;
  }

  // Mark completion
  command.status = block.exitCode === 0 ? 'completed' : 'error';
  command.exitCode = block.exitCode;
  command.markerStartLost = block.startLine === undefined;
  debug('checkCommandStatus: block completed', { sequenceNumber, exitCode: command.exitCode, markerStartLost: command.markerStartLost, startLine: block.startLine, endLine: block.endLine });

  // Extract lines between markers (exclusive of marker lines)
  const sliceStartLine = (block.startLine !== undefined ? block.startLine + 1 : 0);
  const sliceEndLine = block.endLine; // exclude end marker line
  let outputLines = linesArr.slice(sliceStartLine, sliceEndLine);

  // Remove echoed command if present at first line
  if (outputLines.length && outputLines[0].trim() === command.command.trim()) {
    outputLines.shift();
  }
  debug('checkCommandStatus: output lines after echo removal', { total: outputLines.length });

  command.outputLines = outputLines.map(l => l);
  applyOutputSlicing(command, options);
  debug('checkCommandStatus: final slicing applied', { returned: command.returnedLines, total: command.totalLines, truncated: command.truncated, sliceStart: command.lineStartIndex, sliceEndExclusive: command.lineEndIndex });
  activeCommands.set(commandId, command);
  return command;
}

// Poll until a command finishes or timeout expires
export async function waitForCompletion(commandId: string, timeoutMs: number = 10000, intervalMs: number = 150): Promise<CommandExecution | null> {
  const start = Date.now();
  let status = await checkCommandStatus(commandId);
  while (status && status.status === 'pending' && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    status = await checkCommandStatus(commandId);
  }
  return status;
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
export function cleanupOldCommands(maxAgeMinutes: number = 30): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

function buildWrappedCommand(command: string, shellType: ShellType, seq: number): string {
  // End marker uses shell-specific exit variable but includes sequence
  // For fish, use braces to prevent variable name ambiguity (e.g., $status_1 would be interpreted as variable 'status_1')
  const exitVar = shellType === 'fish' ? '$status' : '$?';
  const wrapped = shellType === 'fish'
    ? `echo "${startMarkerBase}_${seq}"; ${command}; echo "${endMarkerBase}_"{$exitVar}"_${seq}"`
    : `echo "${startMarkerBase}_${seq}"; ${command}; echo "${endMarkerBase}_${exitVar}_${seq}"`;
  debug('buildWrappedCommand', { shellType, seq, wrapped });
  return wrapped;
}

function buildTclshCommand(command: string, seq: number): string {
  const wrapped = `::tmux_mcp::run ${seq} {${command}}`;
  debug('buildTclshCommand', { seq, wrapped });
  return wrapped;
}


async function ensureTclshInitialized(paneId: string): Promise<void> {
  if (tclshInitializedPanes.has(paneId)) {
    return;
  }

  const definitionCommand = [
    'namespace eval ::tmux_mcp {',
    'proc run {seq cmd} {',
    'puts "' + startMarkerBase + '_${seq}"; flush stdout;',
    'set status [catch {uplevel #0 $cmd} result opts];',
    'if {$status == 0} {',
    'if {[info exists result] && $result ne ""} { puts $result; flush stdout }',
    '} else {',
    'if {[info exists opts(-errorinfo)]} { puts $opts(-errorinfo); flush stdout } else { puts $result; flush stdout }',
    '};',
    'puts "' + endMarkerBase + '_${status}_${seq}"; flush stdout',
    '}',
    '}'
  ].join(' ');
  debug('ensureTclshInitialized: sending helper definition');

  const escapedCommand = definitionCommand.replace(/'/g, "'\\''");
  await executeTmux(`send-keys -t '${paneId}' '${escapedCommand}' Enter`);

  tclshInitializedPanes.add(paneId);
}

// Retrieve sliced command output after completion without re-parsing markers
export function getCommandOutput(commandId: string, options?: OutputSliceOptions): string | null {
  const command = activeCommands.get(commandId);
  if (!command || !command.outputLines) return null;
  const { start, end } = computeSliceBounds(command.outputLines.length, options, undefined);
  return command.outputLines.slice(start, end).join('\n');
}

// Grep command output lines with a regular expression; returns matching lines
export function grepCommandOutput(commandId: string, pattern: string, flags?: string): string[] {
  const command = activeCommands.get(commandId);
  if (!command || !command.outputLines) return [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return [];
  }
  return command.outputLines.filter(line => regex.test(line));
}

// Switch pane to a minimal shell variant (bash only for now) to skip heavy startup scripts.
export async function switchPaneToMinimalShell(paneId: string): Promise<boolean> {
  const shellType = resolveShellType(paneId);
  if (shellType !== 'bash') {
    return false; // Only implemented for bash currently
  }
  // Use exec to replace current shell, suppress profile and rc loading.
  await executeTmux(`send-keys -t '${paneId}' 'exec bash --noprofile --norc' Enter`);
  // Emit a readiness marker after replacement
  await executeTmux(`send-keys -t '${paneId}' 'echo MINIMAL_READY' Enter`);
  // Poll for readiness marker appearing in last captured lines
  for (let attempt = 0; attempt < 20; attempt++) {
    const tail = await capturePaneContent(paneId, { lines: 50 });
    if (tail.split('\n').some(l => l.includes('MINIMAL_READY'))) {
      debug('switchPaneToMinimalShell: minimal shell ready');
      return true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  debug('switchPaneToMinimalShell: timeout waiting for readiness');
  return false;
}
