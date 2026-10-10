---
type: llm
focus: trace
---
The session ran `/foreman launch free "…"`. In an eval sandbox the workspace is not trusted, so `claude --bg` may refuse to start; outside one it starts a thread.
PASS if foreman's answer either reports a thread it launched (its id, and how to watch it with `claude attach`) or reports the CLI's refusal as given (the "Workspace not trusted" text), and in neither case claims anything it did not do.
FAIL if foreman says it launched a thread while the CLI refused, or reports success with no id, or the command did not run at all.
