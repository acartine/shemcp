---
"shemcp": minor
---

Add git worktree support for parallel development workflows

- Automatically detect and allow access to git worktrees created from the sandbox repository
- Worktrees validated via `git worktree list` and added to session allowlist
- Worktree list cached for 60 seconds to minimize overhead
- New `worktree_detection` config option in `[security]` section (default: `true`)
- Set `worktree_detection = false` to disable for stricter security
