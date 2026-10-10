---
type: regex
target: trace
pattern: "(Launched foreman:adhoc:free as [0-9a-f]{8}|claude --bg failed \\(exit 1\\):\\s*\\\\n?Workspace not trusted)"
match: contains
---
