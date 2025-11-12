# Tmux MCP Server

Model Context Protocol server that enables Claude Desktop to interact with and view tmux session content. This integration allows AI assistants to read from, control, and observe your terminal sessions.

## Features

- List and search tmux sessions
- View and navigate tmux windows and panes
- Capture and expose terminal content from any pane
- Execute commands in tmux panes and retrieve results across bash, zsh, fish, and tclsh shells (use it at your own risk ⚠️)
- Create new tmux sessions and windows
- Split panes horizontally or vertically with customizable sizes
- Kill tmux sessions, windows, and panes

Check out this short video to get excited!

</br>

[![youtube video](http://i.ytimg.com/vi/3W0pqRF1RS0/hqdefault.jpg)](https://www.youtube.com/watch?v=3W0pqRF1RS0)

## Prerequisites

- Node.js
- tmux installed and running

## Usage

### Configure Claude Desktop

Add this MCP server to your Claude Desktop configuration:

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp"]
  }
}
```

### MCP server options

You can optionally specify the default shell the server should assume when wrapping commands. If unspecified it defaults to `bash`.

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp", "--shell-type=fish"]
  }
}
```

The CLI flag only sets the server-wide default. You can still override individual panes (or change the default at runtime) with the `set-shell-type` tool described below. The MCP server needs to know the shell when executing commands so it can wrap and read exit statuses correctly.

## Available Resources

- `tmux://sessions` - List all tmux sessions
- `tmux://pane/{paneId}` - View content of a specific tmux pane
- `tmux://command/{commandId}/result` - Results from executed commands

## Available Tools

### Session & Window Management
- `list-sessions` - List all active tmux sessions
- `find-session` - Find a tmux session by name
- `create-session` - Create a new tmux session
- `kill-session` - Kill a tmux session by ID
- `list-windows` - List windows in a tmux session
- `create-window` - Create a new window in a tmux session
- `kill-window` - Kill a tmux window by ID

### Pane Management
- `list-panes` - List panes in a tmux window
- `capture-pane` - Capture content from a tmux pane
- `split-pane` - Split a tmux pane horizontally or vertically
- `kill-pane` - Kill a tmux pane by ID

### Command Execution
- `set-shell-type` - Configure the shell for command execution (bash, zsh, fish, tclsh)
- `execute-command` - Execute a command in a tmux pane
- `get-command-result` - Get the result of an executed command
- `wait-command-completion` - Poll until a command completes or timeout expires
- `grep-command-output` - Search completed command output using regex
