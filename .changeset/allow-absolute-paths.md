---
"shemcp": minor
---

Allow absolute paths within sandbox and worktree boundaries. Previously, shell_exec rejected all absolute cwd paths with an error. Now absolute paths are accepted if they resolve within the sandbox root or a valid git worktree, enabling better support for workflows where agents work with absolute paths. Also adds zstd to the default command allowlist.
