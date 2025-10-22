---
"shemcp": patch
---

Fix npx execution failing silently due to symlink path resolution in main module check. The main module check was comparing process.argv[1] directly with fileURLToPath(import.meta.url), but when run via npx, argv[1] contains a symlink path while the URL path is resolved. Added null check and realpathSync() to properly resolve and compare paths, allowing the server to start correctly when executed via npx -y shemcp.
