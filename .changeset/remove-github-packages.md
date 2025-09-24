---
"shemcp": patch
---

Remove GitHub Packages publishing from release workflow

GitHub Packages doesn't support publishing for user accounts (only organizations), so removing this step to keep the workflow clean and avoid unnecessary error messages.