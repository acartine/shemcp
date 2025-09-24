---
"shemcp": patch
---

Fix GitHub Release and Packages creation after Release PR merge

The workflow now properly detects when packages are published after a Release PR is merged. Previously, the changesets action's `published` output was only true for direct publishes, not for Release PR merges.

This fix adds detection logic that checks:
- If changesets reports a publish (direct push scenario)
- OR if we just merged a Release PR and the package is now on npm

This ensures GitHub Releases and GitHub Packages are created for all published versions.