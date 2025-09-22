# shemcp

## Unreleased

### Minor Changes

- Sandbox root now resolves to the Git repository root by default (fallback to the current working directory), with optional overrides via `SHEMCP_ROOT` or `MCP_SANDBOX_ROOT`.
- Removed the `shell_set_cwd` tool; `shell_exec` cwd must be RELATIVE to the sandbox root. Absolute paths are rejected with clear error messages that include the received path and the sandbox root.
- Added `shell_info` tool for introspection (reports `sandbox_root` and resolves relative `cwd` inputs, including `within_sandbox` checks).
- Hardened `ensureCwd` with `realpath` and boundary checks to prevent symlink escapes and ensure directory accessibility.

## 0.4.0

### Minor Changes

- [#6](https://github.com/acartine/shemcp/pull/6) [`9c68607`](https://github.com/acartine/shemcp/commit/9c6860718f6b8f713ed46ae1df0c36ec9c56ec3d) Thanks [@acartine](https://github.com/acartine)! - Set up npm publishing: add Changesets, CI, release workflow, README badges and installation docs prioritizing npm, and MIT license.

## 0.3.0

### Minor Changes

- [#2](https://github.com/acartine/shemcp/pull/2) [`7d8e72c`](https://github.com/acartine/shemcp/commit/7d8e72c7f9f30506a46bfaf2f355ee4debf2e5d5) Thanks [@acartine](https://github.com/acartine)! - Set up npm publishing: add Changesets, CI, release workflow, README badges and installation docs prioritizing npm, and MIT license.
