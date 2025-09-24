---
"shemcp": minor
---

## New Features

### Server Version & Config Versioning
- Server version now sourced from package.json and passed to MCP handshake
- Add config_version (default 1) to schema; warn on unsupported future versions
- Update README/config.example to remove server.version and document config_version usage

### Per-Request Limit Overrides
- Support for `timeout_seconds` and `max_output_bytes` in shell_exec calls
- Smart clamping to policy limits and reasonable bounds
- Backward compatibility with legacy `timeout_ms`
- New `getEffectiveLimits()` function for computing effective limits

### Expanded Command List
- Added AWS CLI, Azure CLI, Python, Go, and many other development tools
- Enhanced command regex patterns for better security and flexibility

### Documentation Improvements
- Added comprehensive descriptions to all tool properties
- Clear examples and usage instructions for each parameter
- Improved developer experience with detailed schema documentation

## Technical Details
- Overrides clamped to [1s, 300s] for timeout and [1000, 10M] for output bytes
- Policy limits always respected as upper bounds
- Enhanced error reporting with effective limits in response
- Comprehensive test coverage for all new functionality

## Files Changed
- `src/index.ts` - Added limit override logic, version handling, and property descriptions
- `src/index.test.ts` - Comprehensive tests for new features and test fixes
- `config.example.toml` - Expanded allowed commands and config versioning
- `package-lock.json` - Version bump to 0.4.0