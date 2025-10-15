---
"shemcp": patch
---

Refactor `src/index.ts` into smaller, focused modules

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