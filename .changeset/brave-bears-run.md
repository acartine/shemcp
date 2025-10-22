---
"shemcp": patch
---

Fix server startup when executed via npx with symlinked binaries. Changed main module check from comparing file:// URLs to using fileURLToPath for proper path resolution, allowing the server to start correctly when run through npm bin symlinks.
