# MCP Shell Server

A secure shell command execution server for the Model Context Protocol (MCP).

## Overview

This MCP server provides sandboxed shell command execution with comprehensive security policies. It allows AI assistants to safely execute shell commands while enforcing strict access controls.

## Features

- **Command Allowlisting**: Only pre-approved commands can be executed
- **Command Denylisting**: Explicitly block dangerous command patterns
- **Working Directory Restrictions**: Limit execution to specific directories
- **Environment Filtering**: Only pass through safe environment variables
- **Resource Limits**: Configurable timeouts and output size caps
- **Runtime Policy Updates**: Modify security policies on the fly

## Security Model

The server implements multiple layers of security:

1. **Command Validation**: Commands must match allowlist patterns and not match denylist patterns
2. **Directory Sandboxing**: Commands can only run in pre-approved directories
3. **Environment Isolation**: Sensitive environment variables are filtered out
4. **Resource Limits**: Prevent runaway processes with timeouts and output limits

### Default Policy

- **Allowed Commands**: git, gh, make, grep, sed, jq, aws, az, bash -lc
- **Denied Patterns**: git push to main/master branches
- **Allowed Directories**: `/Users/cartine/brutus`, `/Users/cartine/chat`
- **Timeout**: 60 seconds per command
- **Max Output**: 2MB per stream (stdout/stderr)

## Available Tools

### 1. `shell_exec`
Execute an allowed command with full sandboxing.

**Parameters:**
- `cmd` (required): The command to execute
- `args`: Array of command arguments
- `cwd`: Working directory (must be in allowed list)
- `timeout_ms`: Command timeout in milliseconds

### 2. `shell_set_cwd`
Set the default working directory for subsequent commands.

**Parameters:**
- `cwd` (required): The new working directory

### 3. `shell_set_policy`
Update the security policy at runtime.

**Parameters:**
- `allowed_cwds`: Array of allowed working directories
- `default_cwd`: Default working directory
- `allow_patterns`: Array of regex patterns for allowed commands
- `deny_patterns`: Array of regex patterns for denied commands
- `timeout_ms`: Maximum command timeout
- `max_bytes`: Maximum output size per stream
- `env_whitelist`: Array of environment variables to pass through

## Installation

```bash
npm install
npm run build
```

## Usage

The server runs as an MCP server over stdio:

```bash
node dist/index.js
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

## Testing

The project includes a comprehensive test suite covering:
- Policy validation
- Command allowlisting/denylisting
- Directory access controls
- Environment filtering
- Tool definitions
- Server configuration

Run tests with: `npm test`

## License

MIT