---
"shemcp": patch
---

Fix GitHub Packages authentication in Release workflow

Corrects the npm authentication method for GitHub Packages publishing. The previous approach of appending to ~/.npmrc conflicted with the setup-node action's configuration, causing authentication failures.

This fix:
- Uses `npm config set` instead of direct file manipulation
- Ensures proper authentication token configuration
- Will enable GitHub Packages publication for all future releases

Testing with v0.7.3 release to verify:
- GitHub Release creation works
- GitHub Packages publication succeeds