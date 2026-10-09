Review part {{part}} of run `{{runId}}`: the changes from `{{base}}` to `HEAD`.

## What to read

- The diff `{{base}}..HEAD` in each repository of this project: {{repos}}. Start with `git diff --stat {{base}}..HEAD`, then the files it lists.
- The plan, when there is one: {{plan}}. Judge the change against what the plan asks for part {{part}}.
- The run's notes, when they exist: `{{runsDir}}/{{runId}}/handoff.md` and `{{runsDir}}/{{runId}}/report.md`. Claims in them are claims to check, not evidence.
- Skills to load first, if they exist here: {{skills}}
- Gates this repo declares: {{gates}}. Do not run gates that write (builds, formatters, migrations); say which ones the implementer must run.

## What to write

Write one file, `{{reviewFile}}`, and nothing else:

1. Its **first line** is exactly `Verdict: OK`, `Verdict: NO` or `Verdict: BLOCKED`. `OK`: nothing blocks merging part {{part}}. `NO`: at least one finding must be fixed. `BLOCKED`: you could not review (missing diff, unreadable plan), and why.
2. One section per finding, headed `### C-01 · P1 · path/to/file.ext:42 · <one line>` (P1 breaks the plan or the build, P2 a real defect with a plausible scenario, P3 robustness or clarity), with: the scenario that fails, the expected correction, and how to verify it (a command or a test).
3. A short list of what you checked and found fine.

{{extra}}

## How you finish

End your answer with this JSON on one line, after everything else:

{"verdict":"NO","findings":3,"file":"{{reviewFile}}"}
