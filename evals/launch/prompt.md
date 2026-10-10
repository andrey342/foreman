---
name: launch
description: /foreman launch starts a background thread and says how to watch it
tags: [smoke]
runs: 1
max_turns: 4
timeout_seconds: 180
model: haiku
---
/foreman launch free "write the word hello to hello.txt" --model haiku --effort low
