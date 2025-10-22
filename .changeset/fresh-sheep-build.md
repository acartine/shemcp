---
"shemcp": patch
---

Fix npm publish to include built files with shebang. Added prepack script that automatically builds TypeScript and runs tests before packaging, ensuring dist/index.js always has the shebang line needed for npx execution.
