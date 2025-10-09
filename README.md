# Shemcp - the simple shell mcp server.

[![npm version](https://img.shields.io/npm/v/shemcp.svg)](https://www.npmjs.com/package/shemcp)
[![npm downloads](https://img.shields.io/npm/dm/shemcp.svg)](https://www.npmjs.com/package/shemcp)
[![CI](https://github.com/acartine/shemcp/actions/workflows/ci.yml/badge.svg)](https://github.com/acartine/shemcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Independent agentic coding without handing over the keys to the castle.  Stop getting approval prompts that are unimportant.

## What's new

- **🆕 Pagination Support**: Added pagination and large output handling to `shell_exec` with configurable `limit_bytes`, `limit_lines`, and `on_large_output` modes
- **🆕 Spill File Management**: Large outputs are automatically written to temporary files with `spill_uri` for safe, paginated reading
- **🆕 New `read_file_chunk` Tool**: Read paginated data from spilled files using `cursor` and `limit_bytes` for safe streaming
- Sandbox root now resolves to the Git repository root by default (fallback to the current working directory), with optional overrides via `SHEMCP_ROOT` or `MCP_SANDBOX_ROOT`.
- Removed the `shell_set_cwd` tool; `shell_exec` cwd must be RELATIVE to the sandbox root. Absolute paths are rejected with clear error messages that include the received path and the sandbox root.
- Added `shell_info` tool for introspection (reports `sandbox_root` and resolves relative `cwd` inputs, including `within_sandbox` checks).
- Hardened `ensureCwd` with `realpath` and boundary checks to prevent symlink escapes and ensure directory accessibility.
- Updated docs and tests to reflect the new behavior.

## Overview

This MCP server provides sandboxed shell command execution with comprehensive security policies. It allows AI assistants to safely execute shell commands while enforcing strict access controls through configurable TOML files.

### Sandbox root selection

To avoid the sandbox accidentally shrinking to a nested subdirectory, shemcp derives a stable sandbox root at startup using the following precedence:

1) SHEMCP_ROOT or MCP_SANDBOX_ROOT environment variable (if set and exists)
2) Nearest Git repository root discovered from the agent's process.cwd()
3) process.cwd() as a final fallback

The chosen root remains fixed for the duration of the process. All working directories for command execution must be specified as relative paths inside this sandbox; absolute paths are rejected.

- shell_exec optionally accepts a cwd that must be RELATIVE to the sandbox root; absolute paths are rejected.

This ensures that if the client happens to start the agent several levels deep, the sandbox still resolves to the project root (typically the Git root), preventing the MCP from becoming unable to access sibling paths in the repository.

You can explicitly override the root for special cases with SHEMCP_ROOT or MCP_SANDBOX_ROOT.

## Features

- **📋 TOML Configuration**: Easy-to-edit configuration files with validation
- **🔒 Command Allowlisting**: Only pre-approved commands can be executed
- **🚫 Command Denylisting**: Explicitly block dangerous command patterns
- **📁 Sandboxed to Project Root**: Commands run within the Git repository root by default (fallback to current working directory). Override with `SHEMCP_ROOT` or `MCP_SANDBOX_ROOT`.
- **🛡️ Hardened Path Enforcement**: `cwd` must be relative; absolute paths are rejected. Realpath boundary checks prevent symlink escapes.
- **🌍 Environment Filtering**: Only pass through safe environment variables
- **⏱️ Resource Limits**: Configurable timeouts and output size caps
- **📄 Pagination Support**: Handle large command outputs with configurable `limit_bytes` and `limit_lines`
- **💾 Spill File Management**: Large outputs automatically written to temporary files for safe, paginated access
- **🔄 Streaming Reads**: `read_file_chunk` tool for reading spilled files in token-safe chunks

## Security Model

The server implements multiple layers of security:

1. **Command Validation**: Commands must match allowlist patterns and not match denylist patterns
2. **Directory Sandboxing**: Commands can only run within the sandbox root (Git repository root by default; fallback to CWD). `cwd` must be relative to the sandbox root; absolute paths are rejected. Override via `SHEMCP_ROOT` or `MCP_SANDBOX_ROOT`.
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
- **Root Directory**: Git repository root by default (fallback to process.cwd()). Override via `SHEMCP_ROOT` or `MCP_SANDBOX_ROOT`.
- **Timeout**: 60 seconds per command
- **Max Output**: 2MB per stream (stdout/stderr)

## Commands

### 1) `shell_exec`
Execute an allow-listed command inside the sandbox with support for pagination and large output handling.

**Parameters:**
- `cmd` (required): Command to run (e.g., "git", "npm", "python")
- `args`: Array of string arguments (e.g., ["status", "--short"])
- `cwd`: Optional working directory relative to the sandbox root (no absolute paths)
- `timeout_ms`: Command timeout in milliseconds (deprecated, use `timeout_seconds`)
- `timeout_seconds`: Command timeout in seconds (1-300, clamped to policy limits)
- `max_output_bytes`: Maximum output size in bytes (1000-10M, clamped to policy limits)
- `page`: Pagination configuration object:
  - `cursor`: Opaque position marker (e.g., "bytes:0")
  - `limit_bytes`: Maximum bytes per page (default: 65536, ~8-16k tokens)
  - `limit_lines`: Maximum lines per page (default: 2000, stops on whichever hits first)
- `on_large_output`: How to handle large outputs: "spill" (default), "truncate", or "error"

**Rules:**
- `cwd` must be RELATIVE to the sandbox root
- Absolute paths are rejected with an error that includes the received path and the sandbox root
- Large outputs (>limit_bytes or >limit_lines) are handled according to `on_large_output` mode

**Response Format:**
```json
{
  "exit_code": 0,
  "stdout_chunk": "first 64k of data...",
  "stderr_chunk": "",
  "bytes_start": 0,
  "bytes_end": 65535,
  "total_bytes": 58112234,
  "truncated": false,
  "next_cursor": "bytes:65536",
  "spill_uri": "mcp://tmp/exec-abc123.out",
  "mime": "text/plain",
  "line_count": 1780,
  "stderr_count": 0,
  "cmdline": ["git", "log"],
  "cwd": "/path/to/project",
  "limits": {
    "timeout_ms": 60000,
    "max_output_bytes": 2000000
  }
}
```

### 2) `read_file_chunk`
Read paginated data from a spilled file created by `shell_exec` when `on_large_output` is set to "spill".

**Parameters:**
- `uri` (required): URI of the spilled file (e.g., "mcp://tmp/exec-abc123.out")
- `cursor`: Opaque position marker (default: "bytes:0")
- `limit_bytes`: Maximum bytes to read (default: 65536)

**Response Format:**
```json
{
  "data": "chunk of file content...",
  "bytes_start": 0,
  "bytes_end": 65535,
  "total_bytes": 58112234,
  "next_cursor": "bytes:65536",
  "mime": "text/plain"
}
```

### 3) `shell_info`
Introspection utility for the sandbox.

- Parameters (optional):
  - `cwd`: Relative path to resolve and validate against the sandbox root
- Returns: JSON including `sandbox_root`, and if `cwd` is provided, `resolved_path` and `within_sandbox` flags

### 4) Removed: `shell_set_cwd`
This command has been removed. Use `shell_exec` with a relative `cwd` instead.

## Quick reference

Ask your MCP client to call these tools with the following inputs:

- `shell_info` examples:
  - `{ "cwd": "." }` → returns `sandbox_root`, resolves to the root, and confirms within sandbox
  - `{ "cwd": "src" }` → returns resolved `src` path and `within_sandbox: true` if it exists/inside

- `shell_exec` examples:
  - `{ "cmd": "git", "args": ["status"], "cwd": "." }`
  - `{ "cmd": "npm", "args": ["test"], "cwd": "." }`
  - `{ "cmd": "ls", "args": ["-la"], "cwd": "src" }`

- **Pagination examples:**
  - `{ "cmd": "git", "args": ["log"], "page": { "limit_bytes": 32768 } }` → First 32KB of git log
  - `{ "cmd": "cat", "args": ["large.log"], "page": { "cursor": "bytes:65536" } }` → Next page from byte 65536
  - `{ "cmd": "find", "args": [".", "-name", "*.ts"], "on_large_output": "spill" }` → Spill large find results to file

- **Spill file reading examples:**
  - `{ "uri": "mcp://tmp/exec-abc123.out", "limit_bytes": 16384 }` → Read first 16KB of spilled file
  - `{ "uri": "mcp://tmp/exec-abc123.out", "cursor": "bytes:16384", "limit_bytes": 16384 }` → Read next 16KB chunk

## Quick Start

### 1) Install (npm)

Global (useful if you want the CLI available everywhere):

```bash
npm install -g shemcp
```

Project-local (dev dependency):

```bash
npm install -D shemcp
```

From source (optional, for contributors):

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
# Configuration format version (not the package version)
config_version = 1

[server]
name = "shemcp"

[directories]
# The sandbox root defaults to the Git repository root (fallback to the current
# working directory) and remains fixed for the process lifetime.
# Override with SHEMCP_ROOT or MCP_SANDBOX_ROOT environment variables if needed.

[commands]
allow = ["^git(\\s|$)", "^npm(\\s|$)", "^make(\\s|$)"]
deny = ["^git\\s+push\\s+(origin\\s+)?(main|master)"]

[limits]
timeout_seconds = 60
max_output_bytes = 2000000

[environment]
whitelist = ["PATH", "HOME", "USER", "LANG"]

[security]
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

## Pagination Usage Scenarios

### Handling Large Command Outputs

When dealing with commands that produce large outputs (like logs, large files, or directory listings), use pagination to avoid token limits:

**Scenario 1: Paginating through git log**
```json
{
  "cmd": "git",
  "args": ["log", "--oneline"],
  "page": { "limit_bytes": 32768 }
}
```
Returns first 32KB of git history with `next_cursor` for continuation.

**Scenario 2: Reading large files in chunks**
```json
{
  "cmd": "cat",
  "args": ["huge.log"],
  "on_large_output": "spill",
  "page": { "limit_bytes": 65536 }
}
```
Spills large log file and returns first 64KB with `spill_uri` for continued reading.

**Scenario 3: Processing large directory listings**
```json
{
  "cmd": "find",
  "args": [".", "-type", "f", "-name", "*.js"],
  "page": { "limit_lines": 1000 }
}
```
Returns up to 1000 lines of file listing, whichever comes first.

### Reading Spill Files

When `shell_exec` returns a `spill_uri`, use `read_file_chunk` to read the data in manageable chunks:

**Scenario 4: Reading spilled output**
```json
{
  "uri": "mcp://tmp/exec-abc123.out",
  "limit_bytes": 16384
}
```
Reads first 16KB of the spilled file.

**Scenario 5: Continuing to read spilled output**
```json
{
  "uri": "mcp://tmp/exec-abc123.out",
  "cursor": "bytes:16384",
  "limit_bytes": 16384
}
```
Reads the next 16KB chunk using the `next_cursor` from the previous response.

### Agent Behavior Patterns

**Automatic Pagination Loop:**
```javascript
// Pseudo-code for automatic pagination
let result = shell_exec(cmd, args, { limit_bytes: 65536 });
while (result.next_cursor) {
  // Process current chunk
  processChunk(result.stdout_chunk);

  // Get next chunk
  result = shell_exec(cmd, args, {
    page: { cursor: result.next_cursor }
  });
}
```

**Spill File Handling:**
```javascript
// Pseudo-code for handling spilled files
let result = shell_exec(cmd, args, { on_large_output: "spill" });
if (result.spill_uri) {
  let chunk = read_file_chunk(result.spill_uri, 65536);
  while (chunk.next_cursor) {
    processChunk(chunk.data);
    chunk = read_file_chunk(result.spill_uri, chunk.next_cursor);
  }
}
```

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
- The sandbox root is the Git project root (or process.cwd() if no Git repo). All paths must be inside it.
- Use SHEMCP_ROOT or MCP_SANDBOX_ROOT to override for special cases.
- Ensure the directory exists and is accessible.

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