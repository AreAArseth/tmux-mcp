#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tmux from "./tmux.js";
import pkg from "../package.json" with { type: "json" };

// Create MCP server
const server = new McpServer({
  name: "tmux-mcp",
  version: pkg.version
}, {
  capabilities: {
    resources: {
      subscribe: true,
      listChanged: true
    },
    tools: {
      listChanged: true
    },
    logging: {}
  }
});

const shellTypeSchema = z.enum(tmux.supportedShellTypes);

// List all tmux sessions - Tool
server.tool(
  "list-sessions",
  "List all active tmux sessions",
  {},
  async () => {
    try {
      const sessions = await tmux.listSessions();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(sessions, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing tmux sessions: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Find session by name - Tool
server.tool(
  "find-session",
  "Find a tmux session by name",
  {
    name: z.string().describe("Name of the tmux session to find")
  },
  async ({ name }) => {
    try {
      const session = await tmux.findSessionByName(name);
      return {
        content: [{
          type: "text",
          text: session ? JSON.stringify(session, null, 2) : `Session not found: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error finding tmux session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// List windows in a session - Tool
server.tool(
  "list-windows",
  "List windows in a tmux session",
  {
    sessionId: z.string().describe("ID of the tmux session")
  },
  async ({ sessionId }) => {
    try {
      const windows = await tmux.listWindows(sessionId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(windows, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing windows: ${error}`
        }],
        isError: true
      };
    }
  }
);

// List panes in a window - Tool
server.tool(
  "list-panes",
  "List panes in a tmux window",
  {
    windowId: z.string().describe("ID of the tmux window")
  },
  async ({ windowId }) => {
    try {
      const panes = await tmux.listPanes(windowId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(panes, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing panes: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Capture pane content - Tool
server.tool(
  "capture-pane",
  "Capture content from a tmux pane. Defaults to the last N lines, but you can provide tmux-style start/end offsets (like 0 and -) to walk the full scrollback.",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    lines: z.string().optional().describe("Number of trailing lines to capture when start/end offsets are omitted (defaults to 200)"),
    start: z.string().optional().describe("tmux -S offset; use 0 for the oldest line or a negative value to offset from the bottom"),
    end: z.string().optional().describe("tmux -E offset; use - for the newest line or 0 for the active cursor line"),
    colors: z.boolean().optional().describe("Include color/escape sequences for text and background attributes in output")
  },
  async ({ paneId, lines, start, end, colors }) => {
    try {
      // Parse lines parameter if provided
      const parsedLines = lines !== undefined ? parseInt(lines, 10) : undefined;
      const includeColors = colors ?? false;
      const options: tmux.CapturePaneOptions = {
        includeColors
      };

      if (parsedLines !== undefined && !Number.isNaN(parsedLines) && parsedLines > 0) {
        options.lines = parsedLines;
      }

      if (start !== undefined && start !== '') {
        options.start = start;
      }

      if (end !== undefined && end !== '') {
        options.end = end;
      }

      const content = await tmux.capturePaneContent(paneId, options);
      return {
        content: [{
          type: "text",
          text: content || "No content captured"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error capturing pane content: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Create new session - Tool
server.tool(
  "create-session",
  "Create a new tmux session (optionally minimal to skip startup scripts)",
  {
    name: z.string().describe("Name for the new tmux session"),
  minimal: z.boolean().optional().describe("Launch with a minimal shell (bash --noprofile --norc) to skip startup scripts for speed. If shellCommand is provided, it overrides the minimal shell setting."),
  shellCommand: z.string().optional().describe("Custom shell command in the new session. If minimal=true and shellCommand provided, it overrides the default minimal bash. Examples: 'bash --noprofile --norc', 'zsh -f'"),
  },
  async ({ name, minimal, shellCommand }) => {
    try {
      const session = await tmux.createSession(name, { minimal: minimal === true, shellCommand });
      return {
        content: [{
          type: "text",
          text: session
            ? `Session created: ${JSON.stringify(session, null, 2)}`
            : `Failed to create session: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Create new window - Tool
server.tool(
  "create-window",
  "Create a new window in a tmux session",
  {
    sessionId: z.string().describe("ID of the tmux session"),
    name: z.string().describe("Name for the new window")
  },
  async ({ sessionId, name }) => {
    try {
      const window = await tmux.createWindow(sessionId, name);
      return {
        content: [{
          type: "text",
          text: window
            ? `Window created: ${JSON.stringify(window, null, 2)}`
            : `Failed to create window: ${name}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill session - Tool
server.tool(
  "kill-session",
  "Kill a tmux session by ID",
  {
    sessionId: z.string().describe("ID of the tmux session to kill")
  },
  async ({ sessionId }) => {
    try {
      await tmux.killSession(sessionId);
      return {
        content: [{
          type: "text",
          text: `Session ${sessionId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing session: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill window - Tool
server.tool(
  "kill-window",
  "Kill a tmux window by ID",
  {
    windowId: z.string().describe("ID of the tmux window to kill")
  },
  async ({ windowId }) => {
    try {
      await tmux.killWindow(windowId);
      return {
        content: [{
          type: "text",
          text: `Window ${windowId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing window: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Kill pane - Tool
server.tool(
  "kill-pane",
  "Kill a tmux pane by ID",
  {
    paneId: z.string().describe("ID of the tmux pane to kill")
  },
  async ({ paneId }) => {
    try {
      await tmux.killPane(paneId);
      return {
        content: [{
          type: "text",
          text: `Pane ${paneId} has been killed`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error killing pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Split pane - Tool
server.tool(
  "split-pane",
  "Split a tmux pane horizontally or vertically",
  {
    paneId: z.string().describe("ID of the tmux pane to split"),
    direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (side by side) or 'vertical' (top/bottom). Default is 'vertical'"),
    size: z.number().min(1).max(99).optional().describe("Size of the new pane as percentage (1-99). Default is 50%")
  },
  async ({ paneId, direction, size }) => {
    try {
      const newPane = await tmux.splitPane(paneId, direction || 'vertical', size);
      return {
        content: [{
          type: "text",
          text: newPane
            ? `Pane split successfully. New pane: ${JSON.stringify(newPane, null, 2)}`
            : `Failed to split pane ${paneId}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error splitting pane: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Configure shell type - Tool
server.tool(
  "set-shell-type",
  "Configure the shell for command execution (bash, zsh, fish, tclsh). Provide paneId to override a specific pane.",
  {
    type: shellTypeSchema,
    paneId: z.string().optional().describe("ID of the tmux pane to override. Omit to change the default shell type.")
  },
  async ({ type, paneId }) => {
    try {
      tmux.setShellConfig({ type, paneId });
      const target = paneId ? `pane ${paneId}` : 'default';
      return {
        content: [{
          type: "text",
          text: `Shell type for ${target} set to ${type}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error setting shell type: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Execute command in pane - Tool
server.tool(
  "execute-command",
  "Execute a command in a tmux pane and get results. For interactive applications (REPLs, editors), use `rawMode=true`. IMPORTANT: When `rawMode=false` (default), avoid heredoc syntax (cat << EOF) and other multi-line constructs as they conflict with command wrapping. For file writing, prefer: printf 'content\\n' > file, echo statements, or write to temp files instead",
  {
    paneId: z.string().describe("ID of the tmux pane"),
    command: z.string().describe("Command to execute"),
    rawMode: z.boolean().optional().describe("Execute command without wrapper markers for REPL/interactive compatibility. Disables get-command-result status tracking. Use capture-pane after execution to verify command outcome."),
    noEnter: z.boolean().optional().describe("Send keystrokes without pressing Enter. For TUI navigation in apps like btop, vim, less. Supports special keys (Up, Down, Escape, Tab, etc.) and strings (sent char-by-char for proper filtering). Automatically applies rawMode. Use capture-pane after to see results.")
  },
  async ({ paneId, command, rawMode, noEnter }) => {
    try {
      // If noEnter is true, automatically apply rawMode
      const effectiveRawMode = noEnter || rawMode;
      const commandId = await tmux.executeCommand(paneId, command, effectiveRawMode, noEnter);

      if (effectiveRawMode) {
        const modeText = noEnter ? "Keys sent without Enter" : "Interactive command started (rawMode)";
        return {
          content: [{
            type: "text",
            text: `${modeText}.\n\nStatus tracking is disabled.\nUse 'capture-pane' with paneId '${paneId}' to verify the command outcome.\n\nCommand ID: ${commandId}`
          }]
        };
      }

      // Create the resource URI for this command's results
      const resourceUri = `tmux://command/${commandId}/result`;

      return {
        content: [{
          type: "text",
          text: `Command execution started.\n\nTo get results, subscribe to and read resource: ${resourceUri}\n\nStatus will change from 'pending' to 'completed' or 'error' when finished.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error executing command: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Get command result - Tool
server.tool(
  "get-command-result",
  "Get the result of an executed command",
  {
    commandId: z.string().describe("ID of the executed command"),
    lines: z.number().int().positive().optional().describe("Return only the last N lines of output"),
    start: z.number().int().min(0).optional().describe("Start line index (0-based) of slice to return"),
    end: z.number().int().min(0).optional().describe("End line index (0-based, inclusive) of slice to return")
  },
  async ({ commandId, lines, start, end }) => {
    try {
      // Check and update command status
      const command = await tmux.checkCommandStatus(commandId, { lines, start, end });

      if (!command) {
        return {
          content: [{
            type: "text",
            text: `Command not found: ${commandId}`
          }],
          isError: true
        };
      }

      // Format the response based on command status
      let resultText;
      if (command.status === 'pending') {
        if (command.result) {
          resultText = `Status: ${command.status}\nCommand: ${command.command}\n\n--- Message ---\n${command.result}`;
        } else {
          resultText = `Command still executing...\nStarted: ${command.startTime.toISOString()}\nCommand: ${command.command}`;
        }
      } else {
        const metaLines: string[] = [
          `Status: ${command.status}`,
          `Exit code: ${command.exitCode}`,
          `Command: ${command.command}`
        ];
        if (command.truncated) {
          const endIdxDisplay = command.lineEndIndex !== undefined ? command.lineEndIndex - 1 : (command.returnedLines ? (command.lineStartIndex ?? 0) + (command.returnedLines - 1) : 'unknown');
          metaLines.push(
            `Output truncated: showing ${command.returnedLines} of ${command.totalLines} lines (slice ${command.lineStartIndex}..${endIdxDisplay})`
          );
        } else if (command.outputLines) {
          metaLines.push(`Lines returned: ${command.returnedLines ?? command.outputLines.length}`);
        }
        resultText = metaLines.join("\n") + `\n\n--- Output ---\n${command.result}`;
      }

      return {
        content: [{
          type: "text",
          text: resultText
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error retrieving command result: ${error}`
        }],
        isError: true
      };
    }
  }
);

// Wait for command completion - Tool
server.tool(
  "wait-command-completion",
  "Poll until a command completes or timeout expires. Returns final or intermediate status with sliced output.",
  {
    commandId: z.string().describe("ID of the executed command"),
    timeoutMs: z.number().int().positive().optional().describe("Maximum milliseconds to wait (default 10000)"),
    intervalMs: z.number().int().positive().optional().describe("Polling interval milliseconds (default 150)"),
    lines: z.number().int().positive().optional().describe("Return only the last N lines of output when completed"),
    start: z.number().int().min(0).optional().describe("Start line index (0-based) slice"),
    end: z.number().int().min(0).optional().describe("End line index (0-based, inclusive) slice")
  },
  async ({ commandId, timeoutMs, intervalMs, lines, start, end }) => {
    try {
      const status = await tmux.waitForCompletion(commandId, timeoutMs ?? 10000, intervalMs ?? 150);
      if (!status) {
        return { content: [{ type: 'text', text: `Command not found: ${commandId}` }], isError: true };
      }
      // If completed we may want a sliced result
      if (status.status !== 'pending' && (lines !== undefined || start !== undefined || end !== undefined)) {
        const refreshed = await tmux.checkCommandStatus(commandId, { lines, start, end });
        if (refreshed) {
          // Adopt sliced result and metadata for consistency with get-command-result
          status.result = refreshed.result;
          status.returnedLines = refreshed.returnedLines;
            status.lineStartIndex = refreshed.lineStartIndex;
            status.lineEndIndex = refreshed.lineEndIndex;
            status.truncated = refreshed.truncated;
            status.totalLines = refreshed.totalLines;
            status.outputLines = refreshed.outputLines;
        }
      }
      const meta: string[] = [
        `Status: ${status.status}`,
        `Exit code: ${status.exitCode ?? 'n/a'}`,
        `Command: ${status.command}`
      ];
      if (status.truncated) {
        const endIdxDisplay = status.lineEndIndex !== undefined ? status.lineEndIndex - 1 : 'unknown';
        meta.push(`Output truncated: showing ${status.returnedLines} of ${status.totalLines} lines (slice ${status.lineStartIndex}..${endIdxDisplay})`);
      } else if (status.outputLines) {
        meta.push(`Lines returned: ${status.returnedLines ?? status.outputLines.length}`);
      }
      return {
        content: [{
          type: 'text',
          text: meta.join('\n') + `\n\n--- Output ---\n${status.result || ''}`
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error waiting for command: ${error}` }], isError: true };
    }
  }
);

// Grep command output - Tool
server.tool(
  "grep-command-output",
  "Search completed command output lines using a regular expression. Requires the command to have completed (non-pending). Returns matching lines.",
  {
    commandId: z.string().describe("ID of the executed command"),
    pattern: z.string().describe("Regular expression pattern (ECMAScript syntax)"),
    flags: z.string().optional().describe("Regex flags (e.g. i, m, g). 'g' is ignored for matching lines but allowed."),
    limit: z.number().int().positive().optional().describe("Maximum number of matching lines to return (from first match onward)")
  },
  async ({ commandId, pattern, flags, limit }) => {
    try {
      const command = tmux.getCommand(commandId);
      if (!command) {
        return { content: [{ type: 'text', text: `Command not found: ${commandId}` }], isError: true };
      }
      if (command.status === 'pending') {
        return { content: [{ type: 'text', text: `Command still pending: ${commandId}` }], isError: true };
      }
      const lines = tmux.grepCommandOutput(commandId, pattern, flags);
      const limited = limit ? lines.slice(0, limit) : lines;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            commandId,
            pattern,
            flags: flags || '',
            totalMatches: lines.length,
            returned: limited.length,
            matches: limited
          }, null, 2)
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error during grep: ${error}` }], isError: true };
    }
  }
);

// Expose tmux session list as a resource
server.resource(
  "Tmux Sessions",
  "tmux://sessions",
  async () => {
    try {
      const sessions = await tmux.listSessions();
      return {
        contents: [{
          uri: "tmux://sessions",
          text: JSON.stringify(sessions.map(session => ({
            id: session.id,
            name: session.name,
            attached: session.attached,
            windows: session.windows
          })), null, 2)
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: "tmux://sessions",
          text: `Error listing tmux sessions: ${error}`
        }]
      };
    }
  }
);

// Expose pane content as a resource
server.resource(
  "Tmux Pane Content",
  new ResourceTemplate("tmux://pane/{paneId}", {
    list: async () => {
      try {
        // Get all sessions
        const sessions = await tmux.listSessions();
        const paneResources = [];

        // For each session, get all windows
        for (const session of sessions) {
          const windows = await tmux.listWindows(session.id);

          // For each window, get all panes
          for (const window of windows) {
            const panes = await tmux.listPanes(window.id);

            // For each pane, create a resource with descriptive name
            for (const pane of panes) {
              paneResources.push({
                name: `Pane: ${session.name} - ${pane.id} - ${pane.title} ${pane.active ? "(active)" : ""}`,
                uri: `tmux://pane/${pane.id}`,
                description: `Content from pane ${pane.id} - ${pane.title} in session ${session.name}`
              });
            }
          }
        }

        return {
          resources: paneResources
        };
      } catch (error) {
        server.server.sendLoggingMessage({
          level: 'error',
          data: `Error listing panes: ${error}`
        });

        return { resources: [] };
      }
    }
  }),
  async (uri, { paneId }) => {
    try {
      // Ensure paneId is a string
      const paneIdStr = Array.isArray(paneId) ? paneId[0] : paneId;
      // Default to no colors for resources to maintain clean programmatic access
      const content = await tmux.capturePaneContent(paneIdStr, {
        lines: 200,
        includeColors: false
      });
      return {
        contents: [{
          uri: uri.href,
          text: content || "No content captured"
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          text: `Error capturing pane content: ${error}`
        }]
      };
    }
  }
);

// Create dynamic resource for command executions
server.resource(
  "Command Execution Result",
  new ResourceTemplate("tmux://command/{commandId}/result", {
    list: async () => {
      // Only list active commands that aren't too old
      tmux.cleanupOldCommands(10); // Clean commands older than 10 minutes

      const resources = [];
      for (const id of tmux.getActiveCommandIds()) {
        const command = tmux.getCommand(id);
        if (command) {
          resources.push({
            name: `Command: ${command.command.substring(0, 30)}${command.command.length > 30 ? '...' : ''}`,
            uri: `tmux://command/${id}/result`,
            description: `Execution status: ${command.status}`
          });
        }
      }

      return { resources };
    }
  }),
  async (uri, { commandId }) => {
    try {
      // Ensure commandId is a string
      const commandIdStr = Array.isArray(commandId) ? commandId[0] : commandId;

      // Check command status
      const command = await tmux.checkCommandStatus(commandIdStr);

      if (!command) {
        return {
          contents: [{
            uri: uri.href,
            text: `Command not found: ${commandIdStr}`
          }]
        };
      }

      // Format the response based on command status
      let resultText;
      if (command.status === 'pending') {
        // For rawMode commands, we set a result message while status remains 'pending'
        // since we can't track their actual completion
        if (command.result) {
          resultText = `Status: ${command.status}\nCommand: ${command.command}\n\n--- Message ---\n${command.result}`;
        } else {
          resultText = `Command still executing...\nStarted: ${command.startTime.toISOString()}\nCommand: ${command.command}`;
        }
      } else {
        resultText = `Status: ${command.status}\nExit code: ${command.exitCode}\nCommand: ${command.command}\n\n--- Output ---\n${command.result}`;
      }

      return {
        contents: [{
          uri: uri.href,
          text: resultText
        }]
      };
    } catch (error) {
      return {
        contents: [{
          uri: uri.href,
          text: `Error retrieving command result: ${error}`
        }]
      };
    }
  }
);

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        'shell-type': { type: 'string', default: 'bash', short: 's' }
      }
    });

    // Set shell configuration
    tmux.setShellConfig({
      type: values['shell-type'] as string
    });

    // Start the MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
