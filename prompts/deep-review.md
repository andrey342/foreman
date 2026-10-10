/foreman review --deep asked for a deep review: run it now with the Workflow tool (the person asked for a multi-agent review by running this command).

Review part {{part}} of run `{{runId}}`: the changes from `{{base}}` to `HEAD` in {{repos}}, against the plan {{plan}}.

Write a workflow script with two phases:

1. Review: one agent per dimension, in parallel: correctness and edge cases; the plan's acceptance criteria; tests and gates; security and data handling; consistency with the repo's own rules (its CLAUDE.md and skills). Each reads the diff and returns findings as `{ id, severity: P1|P2|P3, file, line, scenario, correction, verification }`. Read-only: no edits, no commits, no commands that write.
2. Verify: for every finding, a fresh agent tries to refute it against the code; keep only the findings that survive.

Then write `{{reviewFile}}` yourself: its first line exactly `Verdict: OK`, `Verdict: NO` or `Verdict: BLOCKED`, then one section per surviving finding headed `### C-01 · P1 · path/to/file.ext:42 · <one line>`, then what was checked and found fine. Do not change any other file.
