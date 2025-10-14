---
"shemcp": minor
---

Add bash wrapper support with login shell handling

Implements support for bash wrapper commands (bash -lc, bash -c, bash -l -c) that unwraps and validates the underlying command against the allowlist while executing via bash with proper flags. Includes login shell support (-l flag) for correct PATH/environment setup, and full command policy checking to preserve deny rules like "git push origin main".
