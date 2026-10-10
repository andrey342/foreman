---
name: cycle
description: /foreman cycle starts the implementer from the cycle's base, or says why it cannot; it never records a cycle it did not start
tags: [smoke]
runs: 1
max_turns: 4
timeout_seconds: 240
model: haiku
---
/foreman cycle docs/plan.md --part A --level N1 --run e3
