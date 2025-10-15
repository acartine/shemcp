---
"shemcp": minor
---

Clarify shell_info tool to return sandbox root, policy, and version

The `shell_info` tool has been updated to align with its intended use case. It now clearly returns:
- `sandbox_root`: The absolute path to the sandbox root directory
- `server_version`: The MCP server version from package.json
- `command_policy`: The allow/deny regex patterns for command validation

The optional `cwd` resolution functionality has been removed as it was not aligned with the tool's intended purpose. This change improves tool discoverability by making the description match the actual data returned.
