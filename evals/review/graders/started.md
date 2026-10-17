---
type: regex
target: trace
pattern: "Started foreman's reviewer \\(haiku, a read-only process\\) on e2 part A, diff HEAD~1\\.\\.HEAD\\. foreman writes its answer to .*[\\\\/]+\\.git[\\\\/]+foreman[\\\\/]+e2[\\\\/]+review-A-r1\\.md"
match: contains
---
The review starts as a `claude -p` process (D-73) on the part's diff, and its answer goes under `.git/foreman/e2/` (D-70), never in the work tree. The trace is JSON, so a Windows path's separators come doubled: `[\\/]+`.
