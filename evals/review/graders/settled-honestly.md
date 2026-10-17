---
type: regex
target:
  source: file
  path: .git/foreman/e2/foreman.json
pattern: "\"part\": \"A\",[^{}]*\"verdict\": \"(none|NO)\""
match: contains
---
The review of a seeded bug is recorded as `none` (the eval session ends before the reviewer process answers, and the process ends with it: no result, never an OK) or as `NO`. Never `OK`.
