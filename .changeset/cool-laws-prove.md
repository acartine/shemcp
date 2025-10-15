---
"shemcp": minor
---

Enforce pagination requirements and lower page limit to 40KB

- Cap pagination limit_bytes at 40KB default (down from 64KB) to improve performance and memory usage
- Make pagination object mandatory for all shell_exec requests - requests without page object are now rejected
- Apply consistent pagination defaults across all operations
- Update tool definitions, specifications, and documentation to reflect mandatory pagination