---
"shemcp": patch
---

Fix GitHub Release and Packages detection in Release workflow

Corrects the condition for creating GitHub Releases and publishing to GitHub Packages. Previously, the workflow was checking a custom publish detection that was always false after changesets created a Release PR. Now it correctly uses the changesets action's `published` output.

This fix ensures:
- GitHub Release is created when packages are published
- GitHub Packages publication occurs when packages are published
- Both features work for direct publishes and Release PR merges