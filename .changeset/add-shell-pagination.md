---
"shemcp": minor
---

Add pagination and large output handling to shell MCP server

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