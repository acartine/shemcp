---
"shemcp": minor
---

Add support for environment variable prefixes in shell commands. Commands like `FOO=bar npm run test` and `FOO=bar bash -c "echo $FOO"` now work correctly, with env vars properly passed to executed processes. Fixes #78.
