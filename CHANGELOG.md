# Changelog

## 0.6.0

### Minor Changes

- [#16](https://github.com/acartine/shemcp/pull/16) [`a3f3d1e`](https://github.com/acartine/shemcp/commit/a3f3d1e63bf9150c5968007dd5a0ff4894a0b7d5) Thanks [@acartine](https://github.com/acartine)! - ## New Features

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

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2024-09-24

### Added

- **Sandbox Security Enhancements** (from PR #10)

  - Sandbox root now resolves to the Git repository root by default (fallback to the current working directory)
  - Optional overrides via SHEMCP_ROOT or MCP_SANDBOX_ROOT environment variables
  - Removed shell_set_cwd tool; shell_exec cwd must be RELATIVE to the sandbox root
  - Absolute paths are rejected with clear error messages including received path and sandbox root
  - Added shell_info tool for introspection (reports sandbox_root and resolves relative cwd inputs)
  - Hardened ensureCwd with realpath and boundary checks to prevent symlink escapes
  - Enhanced directory accessibility validation

- **Server Version & Config Versioning**

  - Server version now sourced from package.json and passed to MCP handshake
  - Add config_version (default 1) to schema; warn on unsupported future versions
  - Update README/config.example to remove server.version and document config_version usage

- **Per-Request Limit Overrides**

  - Support for `timeout_seconds` and `max_output_bytes` in shell_exec calls
  - Smart clamping to policy limits and reasonable bounds
  - Backward compatibility with legacy `timeout_ms`
  - New `getEffectiveLimits()` function for computing effective limits

- **Expanded Command List**

  - Added AWS CLI, Azure CLI, Python, Go, and many other development tools
  - Enhanced command regex patterns for better security and flexibility

- **Documentation Improvements**

  - Added comprehensive descriptions to all tool properties
  - Clear examples and usage instructions for each parameter
  - Improved developer experience with detailed schema documentation

- **Enhanced Release Automation**
  - Professional GitHub release formatting with emojis and comprehensive notes
  - Automated changelog integration for rich release documentation
  - Improved npm package coordination and discoverability

### Technical Details

- Overrides clamped to [1s, 300s] for timeout and [1000, 10M] for output bytes
- Policy limits always respected as upper bounds
- Enhanced error reporting with effective limits in response
- Comprehensive test coverage for all new functionality

### Security

- Prevented symlink escapes with realpath boundary checks
- Enhanced command validation with regex patterns
- Improved error messaging for security violations
- Hardened path validation and accessibility checks

### Files Changed

- `src/index.ts` - Added limit override logic, version handling, and property descriptions
- `src/index.test.ts` - Comprehensive tests for new features and test fixes
- `config.example.toml` - Expanded allowed commands and config versioning
- `package.json` - Enhanced package metadata and keywords
- `CHANGELOG.md` - Comprehensive changelog with Keep a Changelog format
- `.github/workflows/release.yml` - Enhanced release automation
- `.changeset/config-versioning-limit-overrides.md` - Detailed changeset documentation

## [0.4.0] - 2024-09-24

### Added

- Enhanced sandbox security with Git repository root detection
- Improved working directory validation with symlink protection
- Added shell_info tool for sandbox introspection
- Removed shell_set_cwd tool for better security
- Hardened path validation and accessibility checks

### Security

- Prevented symlink escapes with realpath boundary checks
- Enhanced command validation with regex patterns
- Improved error messaging for security violations

## [0.3.0] - 2024-09-23

### Added

- Initial Model Context Protocol (MCP) server implementation
- Shell command execution with policy-based allowlisting
- Configuration system with TOML support
- Comprehensive test suite
- TypeScript support with strict type checking

### Security

- Sandboxed command execution within Git repository root
- Environment variable filtering
- Command timeout and output size limits
- Regex-based command allow/deny patterns

## [0.2.0] - 2024-09-22

### Added

- Basic MCP server structure
- Tool definitions for shell operations
- Initial policy system

## [0.1.0] - 2024-09-21

### Added

- Project initialization
- Basic package structure
- Development environment setup
