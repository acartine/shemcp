---
"shemcp": minor
---

- Sandbox root now resolves to the Git repository root by default (fallback to the current working directory), with optional overrides via SHEMCP_ROOT or MCP_SANDBOX_ROOT.
- Removed the shell_set_cwd tool; shell_exec cwd must be RELATIVE to the sandbox root. Absolute paths are rejected with clear error messages that include the received path and the sandbox root.
- Added shell_info tool for introspection (reports sandbox_root and resolves relative cwd inputs, including within_sandbox checks).
- Hardened ensureCwd with realpath and boundary checks to prevent symlink escapes and ensure directory accessibility.
- Updated docs and tests to reflect the new behavior.
