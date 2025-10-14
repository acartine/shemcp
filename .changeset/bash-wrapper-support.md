---
"shemcp": minor
---

Add comprehensive bash wrapper support with login shell handling

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
