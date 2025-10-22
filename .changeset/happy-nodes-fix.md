---
"shemcp": patch
---

Fix npx execution by adding shebang line to dist/index.js. Without the shebang, npx attempts to execute the file as a shell script, causing "import: command not found" errors.
