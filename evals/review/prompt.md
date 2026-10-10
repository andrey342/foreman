---
name: review
description: /foreman review starts a fresh read-only reviewer that writes its verdict on the review file's first line
tags: [smoke]
runs: 1
max_turns: 6
timeout_seconds: 300
model: haiku
---
/foreman review --run e2 --part A --base HEAD~1 --plan docs/plan.md --model haiku
