---
"shemcp": patch
---

Add changeset reminder workflow for PRs

Added a GitHub Action that automatically checks pull requests for changeset files and posts a helpful comment when none are found. This helps contributors and automated agents understand when a PR will or won't trigger a release.

Features:
- Automatically comments on PRs without changesets
- Explains what changesets are and why they matter
- Lists which types of changes need changesets
- Non-blocking - just provides information
- Updates existing comment instead of creating duplicates