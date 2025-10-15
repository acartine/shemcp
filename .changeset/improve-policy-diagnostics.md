---
"shemcp": minor
---

Enhance policy error diagnostics with detailed deny reasons

Add comprehensive diagnostic information when commands are denied by policy, including which regex rule matched, whether it was a deny rule or absence of allow rule, and for wrapped commands, both original and unwrapped versions. This makes policy debugging significantly easier for both users and agents.
