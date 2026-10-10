---
type: regex
target:
  source: file
  path: .claude/runs/e2/foreman.json
pattern: "\"part\": \"A\",\\s*\"n\": 1,[\\s\\S]*\"verdict\": \"(none|NO)\""
match: contains
---
The review of a seeded bug is recorded as pending (`none`: the eval session ends before the subagent's file is settled, and under the eval's dontAsk mode the file is not written) or as `NO`. Never `OK`.
