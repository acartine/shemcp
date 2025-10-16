# Changelog

## 0.14.0

### Minor Changes

- [#61](https://github.com/acartine/shemcp/pull/61) [`e57f605`](https://github.com/acartine/shemcp/commit/e57f605b0ba4bf5b9474b50e41906e2656f7f76c) Thanks [@acartine](https://github.com/acartine)! - Add implicit support for 'sh' shell commands alongside 'bash'. The shell_exec command now accepts both 'sh' and 'bash' commands with the same privileges and handling, improving portability and POSIX compatibility.

## 0.13.0

### Minor Changes

- [#58](https://github.com/acartine/shemcp/pull/58) [`60ac433`](https://github.com/acartine/shemcp/commit/60ac4335fa427d145e34bdbf151f1825b5d54279) Thanks [@acartine](https://github.com/acartine)! - Enforce pagination requirements and lower page limit to 40KB

  - Cap pagination limit_bytes at 40KB default (down from 64KB) to improve performance and memory usage
  - Make pagination object mandatory for all shell_exec requests - requests without page object are now rejected
  - Apply consistent pagination defaults across all operations
  - Update tool definitions, specifications, and documentation to reflect mandatory pagination

## 0.12.1

### Patch Changes

- [#56](https://github.com/acartine/shemcp/pull/56) [`bfd8140`](https://github.com/acartine/shemcp/commit/bfd81405bf4863f48ae70faef11d25094ebcf14f) Thanks [@acartine](https://github.com/acartine)! - Refactor `src/index.ts` into smaller, focused modules

  This refactoring breaks down the monolithic `src/index.ts` (previously >1300 lines) into smaller, focused modules organized by responsibility:

  **New module structure:**

  - `src/lib/debug.ts` - Debug logging utilities
  - `src/lib/policy.ts` - Policy types and validation functions
  - `src/lib/sandbox.ts` - Sandbox root detection
  - `src/lib/command.ts` - Command parsing and validation
  - `src/lib/pagination.ts` - Pagination and spill file helpers
  - `src/lib/execution.ts` - Command execution logic
  - `src/tools/definitions.ts` - MCP tool schemas
  - `src/handlers/shell-exec.ts` - shell_exec handler
  - `src/handlers/shell-info.ts` - shell_info handler
  - `src/handlers/read-file-chunk.ts` - read_file_chunk handler

  **Benefits:**

  - Reduced cognitive load when reviewing changes
  - Clearer separation of concerns
  - Easier to add targeted unit tests
  - Better boundaries between policy enforcement, execution, and tool definitions

  **Backward compatibility:**

  - All existing functions and types are re-exported from `src/index.ts`
  - All 75 tests pass without modification
  - Public API surface remains unchanged

## 0.12.0

### Minor Changes

- [#54](https://github.com/acartine/shemcp/pull/54) [`4f66825`](https://github.com/acartine/shemcp/commit/4f668251220aa898179c9dc9b4c8d9acb744ce5d) Thanks [@acartine](https://github.com/acartine)! - Clarify shell_info tool to return sandbox root, policy, and version

  The `shell_info` tool has been updated to align with its intended use case. It now clearly returns:

  - `sandbox_root`: The absolute path to the sandbox root directory
  - `server_version`: The MCP server version from package.json
  - `command_policy`: The allow/deny regex patterns for command validation

  The optional `cwd` resolution functionality has been removed as it was not aligned with the tool's intended purpose. This change improves tool discoverability by making the description match the actual data returned.

## 0.11.0

### Minor Changes

- [#52](https://github.com/acartine/shemcp/pull/52) [`56ebcf8`](https://github.com/acartine/shemcp/commit/56ebcf8352d3328bd1676e8d1b7c2f3c6ffa3b45) Thanks [@acartine](https://github.com/acartine)! - Enhance policy error diagnostics with detailed deny reasons

  Add comprehensive diagnostic information when commands are denied by policy, including which regex rule matched, whether it was a deny rule or absence of allow rule, and for wrapped commands, both original and unwrapped versions. This makes policy debugging significantly easier for both users and agents.

## 0.10.0

### Minor Changes

- [#47](https://github.com/acartine/shemcp/pull/47) [`3c9b322`](https://github.com/acartine/shemcp/commit/3c9b3227e69e553206a839014374f35258873016) Thanks [@acartine](https://github.com/acartine)! - Add comprehensive bash wrapper support with login shell handling

  Implements full support for bash wrapper commands (`bash -lc`, `bash -c`, `bash -l -c`) that intelligently unwraps and validates the underlying command against the allowlist while executing via bash with proper flags.

  ## Key Features

  - **Login shell support**: Detects `-l` flag (including combined forms like `-lc`) to execute commands in a login shell for correct PATH and environment setup
  - **Full command policy checking**: Preserves deny rules by reconstructing the complete command string for policy validation (e.g., `git push origin main` is correctly denied even when wrapped)
  - **Positional parameters**: Maintains trailing arguments after the command string to support `$0`, `$1`, etc. in bash scripts
  - **User flag preservation**: Keeps all user-supplied bash flags like `--noprofile`, `--norc`, `-o posix` when building the execution command
  - **Combined short flag handling**: Properly splits combined short flags (e.g., `-xec` becomes `['-x', '-e', '-c']`) to ensure all flags are activated correctly
  - **Execution order**: Maintains correct bash argument order: user flags → login flag → execution flags → command → positional parameters

  ## Examples

  - `bash -lc "aws s3 ls"` → Executes in login shell with correct PATH
  - `bash --noprofile -c "echo hi"` → Preserves `--noprofile` flag
  - `bash -xec "false"` → Correctly activates both `-x` (trace) and `-e` (exit on error) flags
  - `bash -c 'echo "$1"' -- foo` → Properly passes `foo` as `$1` positional parameter

  This enhancement allows MCP agents to use bash wrappers naturally while maintaining the security guarantees of the allowlist system.

## 0.9.1

### Patch Changes

- Wait for npm propagation before creating GitHub releases to keep GitHub tags in sync with npm publishes.

## 0.9.0

### Minor Changes

- [#42](https://github.com/acartine/shemcp/pull/42) [`215ff6e`](https://github.com/acartine/shemcp/commit/215ff6e6afb4d510dd7a6d423f89c4fcbc942bc9) Thanks [@acartine](https://github.com/acartine)! - Add pagination and large output handling to shell MCP server

  - **New `shell_exec` features:**

    - Add `page` parameter with `cursor`, `limit_bytes`, and `limit_lines` options
    - Add `on_large_output` parameter with "spill", "truncate", or "error" modes
    - Return comprehensive pagination metadata (`next_cursor`, `total_bytes`, `truncated`, etc.)

  - **New `read_file_chunk` tool:**

    - Read paginated data from spilled files using `cursor` and `limit_bytes`
    - Support for both stdout and stderr spill files
    - Safe streaming of large command outputs

  - **Spill file management:**

    - Automatic creation of temporary files for large outputs
    - Proper cleanup when files are no longer needed
    - URI-based file referencing for both stdout and stderr

  - **Enhanced response format:**
    - Include `spill_uri` and `stderr_spill_uri` for spilled outputs
    - Add MIME type detection and line counting
    - Maintain backward compatibility with existing functionality

  This feature prevents token overflow errors when dealing with large command outputs while maintaining full functionality and security constraints.

### Patch Changes

- [#42](https://github.com/acartine/shemcp/pull/42) [`760ae79`](https://github.com/acartine/shemcp/commit/760ae7951e766de17345b48f5822ab887f999961) Thanks [@acartine](https://github.com/acartine)! - Fix PR #42 review comments for shell pagination and spill file handling

  - **Fixed `read_file_chunk` memory usage**: Now reuses range reader instead of loading entire spill files into RAM
  - **Fixed `readFileRange` edge case**: Added proper handling for `end <= start` to avoid ERR_OUT_OF_RANGE errors
  - **Improved file size detection**: Uses `statSync` to get file size without reading content into memory
  - **Enhanced error handling**: Better bounds checking and validation for pagination parameters

## 0.8.0

### Minor Changes

- [#40](https://github.com/acartine/shemcp/pull/40) [`34d86ea`](https://github.com/acartine/shemcp/commit/34d86ea274ed1360ff79ab5f4fd2108b4cf6d68a) Thanks [@acartine](https://github.com/acartine)! - Remove shell_set_policy tool from MCP server

  The shell_set_policy tool has been removed as it allowed runtime modification of security policies, which could be used to bypass security restrictions. The MCP server now only provides shell_exec and shell_info tools for safer operation.

## 0.7.7

### Patch Changes

- [#38](https://github.com/acartine/shemcp/pull/38) [`c08df6f`](https://github.com/acartine/shemcp/commit/c08df6fd32579f5f6031714419e9e736eaae9552) Thanks [@acartine](https://github.com/acartine)! - Remove GitHub Packages publishing from release workflow

  GitHub Packages doesn't support publishing for user accounts (only organizations), so removing this step to keep the workflow clean and avoid unnecessary error messages.

## 0.7.6

### Patch Changes

- [#36](https://github.com/acartine/shemcp/pull/36) [`3a8bd38`](https://github.com/acartine/shemcp/commit/3a8bd38fb32c79b7152266ebde5e6becc2ab1551) Thanks [@acartine](https://github.com/acartine)! - Make GitHub Packages publish non-blocking

  The GitHub Packages publish step now continues on error to ensure GitHub Release creation happens even if GitHub Packages fails. This is important because GitHub Packages can fail for permission reasons (e.g., trying to create an org package for a user account) but we still want the GitHub Release to be created.

## 0.7.5

### Patch Changes

- [#34](https://github.com/acartine/shemcp/pull/34) [`7744b9b`](https://github.com/acartine/shemcp/commit/7744b9bededd54902c9fe87369dbe3a68fdb45d4) Thanks [@acartine](https://github.com/acartine)! - Fix GitHub Release and Packages creation after Release PR merge

  The workflow now properly detects when packages are published after a Release PR is merged. Previously, the changesets action's `published` output was only true for direct publishes, not for Release PR merges.

  This fix adds detection logic that checks:

  - If changesets reports a publish (direct push scenario)
  - OR if we just merged a Release PR and the package is now on npm

  This ensures GitHub Releases and GitHub Packages are created for all published versions.

## 0.7.4

### Patch Changes

- [#32](https://github.com/acartine/shemcp/pull/32) [`2bdcbd6`](https://github.com/acartine/shemcp/commit/2bdcbd6d49476d50c03b5d4d95d8598dc30a37fd) Thanks [@acartine](https://github.com/acartine)! - Fix GitHub Release and Packages detection in Release workflow

  Corrects the condition for creating GitHub Releases and publishing to GitHub Packages. Previously, the workflow was checking a custom publish detection that was always false after changesets created a Release PR. Now it correctly uses the changesets action's `published` output.

  This fix ensures:

  - GitHub Release is created when packages are published
  - GitHub Packages publication occurs when packages are published
  - Both features work for direct publishes and Release PR merges

## 0.7.3

### Patch Changes

- [#30](https://github.com/acartine/shemcp/pull/30) [`c3db634`](https://github.com/acartine/shemcp/commit/c3db634c3a2472a39b6fe66f07c942636b941095) Thanks [@acartine](https://github.com/acartine)! - Fix GitHub Packages authentication in Release workflow

  Corrects the npm authentication method for GitHub Packages publishing. The previous approach of appending to ~/.npmrc conflicted with the setup-node action's configuration, causing authentication failures.

  This fix:

  - Uses `npm config set` instead of direct file manipulation
  - Ensures proper authentication token configuration
  - Will enable GitHub Packages publication for all future releases

  Testing with v0.7.3 release to verify:

  - GitHub Release creation works
  - GitHub Packages publication succeeds

## 0.7.2

### Patch Changes

- [#28](https://github.com/acartine/shemcp/pull/28) [`fb28727`](https://github.com/acartine/shemcp/commit/fb287276182870007b0db0f9caadf77c101253bd) Thanks [@acartine](https://github.com/acartine)! - Fix GitHub Release and GitHub Packages publishing

  Fixed the Release workflow to properly detect when npm publish succeeds and trigger GitHub Release creation and GitHub Packages publishing accordingly.

  Previously, these steps were only triggered when changesets reported publishing in the current run, but when the Release PR is merged, the actual publish happens without changesets reporting it as "published".

  Now the workflow:

  - Checks if the current package version matches what's on npm
  - If it does, it means a publish happened (either just now or in the PR merge)
  - Uses this detection to trigger GitHub Release and GitHub Packages steps

  This ensures that every npm release gets:

  - A corresponding GitHub Release with changelog
  - A GitHub Packages publication for alternative installation

## 0.7.1

### Patch Changes

- [#26](https://github.com/acartine/shemcp/pull/26) [`1d89b09`](https://github.com/acartine/shemcp/commit/1d89b09f05045d1f990cb98cccb3454353fb325a) Thanks [@acartine](https://github.com/acartine)! - Add changeset reminder workflow for PRs

  Added a GitHub Action that automatically checks pull requests for changeset files and posts a helpful comment when none are found. This helps contributors and automated agents understand when a PR will or won't trigger a release.

  Features:

  - Automatically comments on PRs without changesets
  - Explains what changesets are and why they matter
  - Lists which types of changes need changesets
  - Non-blocking - just provides information
  - Updates existing comment instead of creating duplicates

## 0.7.0

### Minor Changes

- [#18](https://github.com/acartine/shemcp/pull/18) [`752c79f`](https://github.com/acartine/shemcp/commit/752c79fe36b16014b57b19c628bf01bf267a0acc) Thanks [@acartine](https://github.com/acartine)! - ## New Features

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

<<<<<<< HEAD

## 0.6.0

=======
All notable changes to this project will be documented in this file.

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<<<<<<< HEAD

- [#16](https://github.com/acartine/shemcp/pull/16) [`a3f3d1e`](https://github.com/acartine/shemcp/commit/a3f3d1e63bf9150c5968007dd5a0ff4894a0b7d5) Thanks [@acartine](https://github.com/acartine)! - ## New Features

  ### Server Version & Config Versioning

=======

## [Unreleased]

## [0.5.0] - 2024-09-24

### Added

- **Server Version & Config Versioning**
  > > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)
  - Server version now sourced from package.json and passed to MCP handshake
  - Add config_version (default 1) to schema; warn on unsupported future versions
  - Update README/config.example to remove server.version and document config_version usage

<<<<<<< HEAD

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

=======

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

### Technical Details

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Overrides clamped to [1s, 300s] for timeout and [1000, 10M] for output bytes
- Policy limits always respected as upper bounds
- Enhanced error reporting with effective limits in response
- Comprehensive test coverage for all new functionality

<<<<<<< HEAD

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
- # `.changeset/config-versioning-limit-overrides.md` - Detailed changeset documentation

### Files Changed

- `src/index.ts` - Added limit override logic, version handling, and property descriptions
- `src/index.test.ts` - Comprehensive tests for new features and test fixes
- `config.example.toml` - Expanded allowed commands and config versioning
- `package-lock.json` - Version bump to 0.4.0
  > > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

## [0.4.0] - 2024-09-24

### Added

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Enhanced sandbox security with Git repository root detection
- Improved working directory validation with symlink protection
- Added shell_info tool for sandbox introspection
- Removed shell_set_cwd tool for better security
- Hardened path validation and accessibility checks

### Security

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Prevented symlink escapes with realpath boundary checks
- Enhanced command validation with regex patterns
- Improved error messaging for security violations

## [0.3.0] - 2024-09-23

### Added

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Initial Model Context Protocol (MCP) server implementation
- Shell command execution with policy-based allowlisting
- Configuration system with TOML support
- Comprehensive test suite
- TypeScript support with strict type checking

### Security

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Sandboxed command execution within Git repository root
- Environment variable filtering
- Command timeout and output size limits
- Regex-based command allow/deny patterns

## [0.2.0] - 2024-09-22

### Added

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Basic MCP server structure
- Tool definitions for shell operations
- Initial policy system

## [0.1.0] - 2024-09-21

### Added

<<<<<<< HEAD

=======

> > > > > > > 43ab9dd (feat: enhance release automation and npm package coordination)

- Project initialization
- Basic package structure
- Development environment setup
