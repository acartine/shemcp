# Migration Guide: Simplified Directory Configuration

## What Changed

The MCP Shell Server has been refactored to use a much simpler directory security model:

### Before (v0.1.0 and earlier)
- Required explicit configuration of `directories.allowed` and `directories.default`
- Multiple allowed directories had to be pre-configured
- Complex configuration files with directory paths

### After (v0.2.0)
- **Automatic root directory**: The server uses the directory where it was launched as the single root
- **No configuration needed**: Directory restrictions are automatic based on launch location
- **Simpler sandbox**: Commands can only execute within the launch directory and its subdirectories

## Benefits

1. **Simplified Setup**: No need to configure allowed directories in config files
2. **Automatic Security**: Claude or other MCP clients automatically determine the sandbox boundary
3. **Project-Aware**: Each project gets its own sandbox automatically
4. **Intuitive Behavior**: The accessible directory matches where the user/AI started working

## How It Works

When Claude bootstraps the shemcp MCP server, it tells shemcp the broadest/highest directory of its sandbox by launching the server from that directory. The server then:

1. Uses `process.cwd()` to detect where it was launched
2. Restricts all shell operations to that directory and subdirectories
3. Validates working directories using path resolution to prevent directory traversal attacks

## Configuration Changes

### Old Config File (no longer needed):
```toml
[directories]
allowed = [
    "~/projects",
    "~/workspace", 
    "~/dev"
]
default = "~/projects"
```

### New Config File (simplified):
```toml
[directories]
# The root directory is automatically set to where the MCP server was launched
# No configuration needed - all operations are restricted to this directory and subdirectories
```

## API Changes

### Tool: `shell_set_cwd`
- **Before**: Set the default working directory (must be in allowedCwds)
- **After**: Set the root directory (must be within current root or subdirectory)

### Tool: `shell_set_policy` 
- **Before**: Could modify `allowed_cwds` and `default_cwd` parameters
- **After**: Directory parameters removed - only command patterns, limits, and env vars configurable

## Migration Steps

If you have existing configuration files:

1. **Remove directory configuration**: Delete or comment out the `[directories]` section
2. **Launch from project root**: Ensure the MCP server is launched from your desired project directory
3. **Update any scripts**: Remove directory path configuration from automation scripts

## Example Usage

```bash
# In your project directory
cd /path/to/my-project

# Launch Claude with MCP server (automatically uses current directory as root)
claude mcp add shell -- node /path/to/shemcp/dist/index.js

# Now all shell commands are restricted to /path/to/my-project and subdirectories
```

The AI can now safely execute commands like:
- `git status` (in project root)
- `ls src/` (in subdirectory)  
- `npm test` (in project root)

But cannot execute:
- Commands in `/etc/`
- Commands in `/home/user/other-project/`
- Commands outside the project tree

## Backwards Compatibility

This is a breaking change for configuration files, but:
- Existing config files will still work (directory settings are ignored)
- The security model is stricter (more secure)
- Tool interfaces remain mostly compatible
