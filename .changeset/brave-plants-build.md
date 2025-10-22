---
"shemcp": patch
---

Fix npm publish workflow to build TypeScript before publishing. The publish step now runs npm ci and npm run build to ensure dist/index.js includes the shebang and all latest changes.
