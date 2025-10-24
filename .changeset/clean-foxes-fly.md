---
"shemcp": patch
---

Fixes environment variable prefix parsing in shell commands. Commands like `FOO=bar npm run test` now work correctly with both direct commands and bash/sh wrappers.

This change addresses issue #78 where environment variables declared at the beginning of commands were not properly recognized and handled. The fix ensures that:
- Environment variables are stripped before command validation
- Validation runs on the actual command (after env vars)
- Execution includes the full command with env vars preserved
- Works correctly with bash/sh wrapper commands
