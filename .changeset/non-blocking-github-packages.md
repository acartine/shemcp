---
"shemcp": patch
---

Make GitHub Packages publish non-blocking

The GitHub Packages publish step now continues on error to ensure GitHub Release creation happens even if GitHub Packages fails. This is important because GitHub Packages can fail for permission reasons (e.g., trying to create an org package for a user account) but we still want the GitHub Release to be created.