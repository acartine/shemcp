import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** ---------- Tool definitions ---------- */
export const tools: Tool[] = [
  {
    name: "shell_exec",
    description: "Execute an allow-listed command within the sandbox (git project root). Optional cwd must be RELATIVE to the sandbox root. Supports pagination via limit_bytes and next_cursor (page and cursor are required for pagination). Automatically spills large outputs to file with spill_uri.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", minLength: 1, description: "The command to execute (e.g., 'git', 'npm', 'python')" },
        args: { type: "array", items: { type: "string" }, default: [], description: "Command arguments as an array of strings (e.g., ['status', '--short'])" },
        cwd: { type: "string", description: "Relative path from sandbox root (no absolute paths)" },
        // Deprecated: prefer timeout_seconds; kept for backward-compat
        timeout_ms: { type: "number", minimum: 1, maximum: 300000, description: "Command timeout in milliseconds (deprecated, use timeout_seconds instead)" },
        // New optional per-request overrides
        timeout_seconds: { type: "number", minimum: 1, maximum: 300, description: "Command timeout in seconds (1-300, will be clamped to policy limits)" },
        max_output_bytes: { type: "number", minimum: 1000, maximum: 10000000, description: "Maximum output size in bytes (1000-10M, will be clamped to policy limits)" },
        page: {
          type: "object",
          description: "Pagination configuration.  Pagination is always on and hence a required attribute.",
          properties: {
            cursor: {
              type: "object",
              description: "Position marker indicating where to start reading from the output stream. 0 for first request, then use next_cursor from prior response.",
              properties: {
                cursor_type: {
                  type: "string",
                  description: "Type of cursor positioning. Currently supports 'bytes' for byte-based positioning.",
                  enum: ["bytes"],
                  default: "bytes"
                },
                offset: {
                  type: "number",
                  minimum: 0,
                  description: "Byte offset from the start of the output stream. For 'bytes' cursor_type, this represents the byte position to start reading from.",
                  default: 0
                }
              },
              required: ["cursor_type"]
            },
            limit_bytes: {
              type: "number",
              minimum: 1,
              maximum: 40000,
              description: "Maximum number of bytes to return in this page. Larger values provide more content but use more memory. Default: 40 KB (40000 bytes).",
              default: 40000
            },
            limit_lines: {
              type: "number",
              minimum: 1,
              maximum: 100000,
              description: "Maximum number of lines to return in this page. The command stops on whichever limit (bytes or lines) is hit first. Useful for text files where line boundaries matter."
            }
          },
          required: ["cursor"]
        },
        on_large_output: { type: "string", enum: ["spill", "truncate", "error"], description: "How to handle large outputs", default: "spill" }
      },
      required: ["cmd", "page"]
    }
  },
  {
    name: "read_file_chunk",
    description: "Reads paginated data from a spilled file (stdout or stderr). Accepts cursor and limit_bytes to safely stream contents.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "URI of the spilled file (e.g., 'mcp://tmp/exec-abc123.out' or 'mcp://tmp/exec-abc123.err')" },
        cursor: {
          type: "object",
          description: "Position marker indicating where to start reading from the file.",
          properties: {
            cursor_type: {
              type: "string",
              description: "Type of cursor positioning. Currently supports 'bytes' for byte-based positioning.",
              enum: ["bytes"],
              default: "bytes"
            },
            offset: {
              type: "number",
              minimum: 0,
              description: "Byte offset from the start of the file.",
              default: 0
            }
          },
          default: { cursor_type: "bytes", offset: 0 }
        },
        limit_bytes: { type: "number", minimum: 1, maximum: 40000, description: "Maximum bytes to read", default: 40000 }
      },
      required: ["uri"]
    }
  },
  {
    name: "shell_info",
    description: "Get sandbox information including the sandbox root path, allow/deny command policy, and server version.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];
