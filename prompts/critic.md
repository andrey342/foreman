Judge, as an independent acceptance critic, whether part {{part}} of run `{{runId}}` meets its acceptance criteria.

## What to read

- The plan and its acceptance criteria: {{plan}}. When no plan is given, take the criteria from `{{runsDir}}/{{runId}}/handoff.md`.
- The changes from `{{base}}` to `HEAD` in each repository of this project: {{repos}}.
- The run's `report.md` in `{{runsDir}}/{{runId}}/`: every claim of evidence in it is to be checked against the repo, not believed.
- Skills to load first, if they exist here: {{skills}}

## What to write

Write one file, `{{reviewFile}}`, and nothing else:

1. Its **first line** is exactly `Verdict: PASS`, `Verdict: FAIL` or `Verdict: BLOCKED`. `PASS`: every criterion holds, with evidence you saw. `FAIL`: at least one does not. `BLOCKED`: a criterion cannot be judged from here, and why.
2. A table, one row per criterion: the criterion, `met` / `not met` / `cannot judge`, and the evidence (`file:line`, a command and its output).
3. For each criterion not met, a finding headed `### C-01 · P1 · <file:line> · <one line>`, with what is missing and how to verify the fix.

{{extra}}

## How you finish

End your answer with this JSON on one line, after everything else:

{"verdict":"FAIL","findings":1,"file":"{{reviewFile}}"}
