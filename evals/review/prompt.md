---
name: review
description: /foreman review starts foreman's read-only reviewer process on the part's diff, and its record never holds an OK it did not get
tags: [smoke]
runs: 1
max_turns: 6
timeout_seconds: 300
model: haiku
---
/foreman review --run e2 --part A --base HEAD~1 --model haiku
