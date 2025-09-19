# MCP Shell Server

A secure shell command execution server for the Model Context Protocol (MCP).

## Overview

This MCP server provides sandboxed shell command execution with comprehensive security policies. It allows AI assistants to safely execute shell commands while enforcing strict access controls through configurable TOML files.

## Features

- **📋 TOML Configuration**: Easy-to-edit configuration files with validation
- **🔒 Command Allowlisting**: Only pre-approved commands can be executed
- **🚫 Command Denylisting**: Explicitly block dangerous command patterns
- **📁 User-Scoped Directory Access**: Commands can run anywhere within the user's home directory by default
- **🌍 Environment Filtering**: Only pass through safe environment variables
- **⏱️ Resource Limits**: Configurable timeouts and output size caps
- **🔧 Runtime Policy Updates**: Modify security policies on the fly (optional)

## Security Model

The server implements multiple layers of security:

1. **Command Validation**: Commands must match allowlist patterns and not match denylist patterns
2. **Directory Sandboxing**: Commands can only run within the user's home directory and its subdirectories (customizable via SHEMCP_ROOT)
3. **Environment Isolation**: Sensitive environment variables are filtered out
4. **Resource Limits**: Prevent runaway processes with timeouts and output limits

## Debugging

The server writes debug logs to `~/.shemcp/debug.log` which can help diagnose issues:

```bash
# View the debug log
tail -f ~/.shemcp/debug.log

# Clear the debug log
> ~/.shemcp/debug.log
```

The log captures:
- Server startup and configuration loading
- All MCP requests received
- Shutdown signals and cleanup process  
- Any errors or exceptions

### Default Policy

- **Allowed Commands**: git, gh, make, grep, sed, jq, aws, az, bash -lc
- **Denied Patterns**: git push to main/master branches  
- **Root Directory**: User's home directory (~/) by default, customizable via SHEMCP_ROOT environment variable
- **Timeout**: 60 seconds per command
- **Max Output**: 2MB per stream (stdout/stderr)

## Available Tools

### 1. `shell_exec`
Execute an allowed command with full sandboxing.

**Parameters:**
- `cmd` (required): The command to execute
- `args`: Array of command arguments
- `cwd`: Working directory (must be within the user's home directory or SHEMCP_ROOT)
- `timeout_ms`: Command timeout in milliseconds

### 2. `shell_set_cwd`
Set the root directory (must be within the current root directory or a subdirectory).

**Parameters:**
- `cwd` (required): The new root directory

### 3. `shell_set_policy`
Update the security policy at runtime (root directory can be overridden via SHEMCP_ROOT env var).

**Parameters:**
- `allow_patterns`: Array of regex patterns for allowed commands
- `deny_patterns`: Array of regex patterns for denied commands
- `timeout_ms`: Maximum command timeout
- `max_bytes`: Maximum output size per stream
- `env_whitelist`: Array of environment variables to pass through

## Quick Start

### 1. Installation

```bash
git clone https://github.com/acartine/shemcp.git
cd shemcp
npm install
npm run build
```

### 2. Configuration

Create your configuration file:

```bash
# Create config directory
mkdir -p ~/.config/shemcp

# Copy example config and customize
cp config.example.toml ~/.config/shemcp/config.toml

# Edit the config to match your needs
nano ~/.config/shemcp/config.toml
```

### 3. Setup for Claude Code

Add the MCP server using Claude Code's CLI:

```bash
# Navigate to your shemcp directory
cd /path/to/shemcp

# Add the shell MCP server to Claude Code
claude mcp add shell -- node /absolute/path/to/shemcp/dist/index.js

# Verify it was added successfully
claude mcp list
```

**Alternative scopes:**
```bash
# Add for current project only (default)
claude mcp add shell -- node /absolute/path/to/shemcp/dist/index.js

# Add for current user (available in all projects)
claude mcp add --scope user shell -- node /absolute/path/to/shemcp/dist/index.js

# Add for project team (creates .mcp.json in project root)  
claude mcp add --scope project shell -- node /absolute/path/to/shemcp/dist/index.js
```

### 4. Setup for Other MCP Clients

**For Cursor/VS Code with MCP:**
```json
{
  "mcp.servers": {
    "shell": {
      "command": "node",
      "args": ["/absolute/path/to/shemcp/dist/index.js"],
      "env": {}
    }
  }
}
```

**For Desktop MCP Clients:**
- **Command**: `node`
- **Arguments**: `["/absolute/path/to/shemcp/dist/index.js"]`
- **Working Directory**: `/path/to/shemcp`

## Configuration

The server loads configuration from:
1. `~/.config/shemcp/config.toml` (user config - highest priority)
2. `/etc/shemcp/config.toml` (system config - lower priority)
3. Built-in defaults (fallback)

### Configuration Structure

```toml
[server]
name = "shemcp"
version = "0.2.0"

[directories]
# The root directory defaults to the user's home directory (~/)
# Override with SHEMCP_ROOT environment variable if needed

[commands]
allow = ["^git(\\s|$)", "^npm(\\s|$)", "^make(\\s|$)"]
deny = ["^git\\s+push\\s+(origin\\s+)?(main|master)"]

[limits]
timeout_seconds = 60
max_output_bytes = 2000000

[environment]
whitelist = ["PATH", "HOME", "USER", "LANG"]

[security]
allow_runtime_policy_changes = true
require_secure_permissions = false
```

See `config.example.toml` for a complete example with documentation.

## Example Usage

Once configured with Claude Code or another MCP client, you can ask the AI to execute shell commands:

**Example interactions:**
- *"Check the git status of my project"* → Executes `git status`
- *"List all TypeScript files"* → Executes `find . -name "*.ts"`
- *"Run the tests"* → Executes `npm test` 
- *"Show recent commits"* → Executes `git log --oneline -10`
- *"Create a new branch for this feature"* → Executes `git checkout -b feature-name`

The AI can only execute commands that match your allow patterns and run in directories you've permitted, providing a secure sandbox for shell operations.

## Development

```bash
# Run tests
npm test

# Run tests with UI
npm test:ui

# Build TypeScript
npm run build

# Development mode
npm run dev
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Configuration Security**: Config files should not be world-writable. The server warns about insecure permissions.

2. **No Project-Level Configs**: By design, there are no `.shemcp.toml` files in working directories to prevent AI from modifying its own security constraints.

3. **Principle of Least Privilege**: Start with restrictive settings and gradually add permissions as needed.

4. **Regular Auditing**: Review your allowed commands and directories periodically.

## Testing

The project includes a comprehensive test suite covering:
- Configuration loading and validation
- Policy enforcement
- Command allowlisting/denylisting  
- Directory access controls
- Environment filtering
- Tool definitions
- Server configuration

Run tests with: `npm test`

## Troubleshooting

### Common Issues

**"Command not allowed" errors:**
- Check your `commands.allow` patterns in the config
- Ensure the command matches the regex patterns
- Verify the command isn't in the `commands.deny` list

**"Directory not allowed" errors:**
- By default, the server allows access to your entire home directory (~/)
- Use SHEMCP_ROOT environment variable to restrict to a specific directory if needed
- Ensure the directory exists and is accessible

**Server not connecting:**
- Verify the absolute path to `dist/index.js` in your MCP client config
- Check that the server was built with `npm run build`
- Look for error messages in the MCP client logs

### Debug Configuration

To see your current configuration:
```bash
# Check which config files exist
ls -la ~/.config/shemcp/config.toml
ls -la /etc/shemcp/config.toml

# List Claude Code MCP servers
claude mcp list

# Get details about your shell server
claude mcp get shell

# Remove server if needed
claude mcp remove shell
```

## License

MIT