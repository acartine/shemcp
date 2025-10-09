---
"shemcp": minor
---

Remove shell_set_policy tool from MCP server

The shell_set_policy tool has been removed as it allowed runtime modification of security policies, which could be used to bypass security restrictions. The MCP server now only provides shell_exec and shell_info tools for safer operation.