---
"shemcp": patch
---

Fix GitHub Release and GitHub Packages publishing

Fixed the Release workflow to properly detect when npm publish succeeds and trigger GitHub Release creation and GitHub Packages publishing accordingly.

Previously, these steps were only triggered when changesets reported publishing in the current run, but when the Release PR is merged, the actual publish happens without changesets reporting it as "published".

Now the workflow:
- Checks if the current package version matches what's on npm
- If it does, it means a publish happened (either just now or in the PR merge)
- Uses this detection to trigger GitHub Release and GitHub Packages steps

This ensures that every npm release gets:
- A corresponding GitHub Release with changelog
- A GitHub Packages publication for alternative installation