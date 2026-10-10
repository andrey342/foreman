---
type: llm
focus: trace
---
The session ran `/foreman cycle docs/plan.md --part A --level N1 --run e3` in a small git repo. foreman starts a cycle by launching an implementer thread with `claude --bg`; in an eval sandbox the workspace is not trusted and the CLI may refuse.
PASS if foreman either reports the cycle it started (the cycle id e3:A, the implementer thread, the base commit) or reports the CLI's refusal as given, and does not report a cycle as started when the launch was refused.
FAIL if it claims a started cycle after a refusal, or the command did not run.
