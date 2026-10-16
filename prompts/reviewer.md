Review part {{part}} of the plan `{{plan}}`: the changes from `{{base}}` to `HEAD`.

## The part, as the plan writes it

{{partText}}

## Acceptance criteria

{{criteria}}

## What to read

- The diff `{{base}}..HEAD`: start with `git diff --stat {{base}}..HEAD`, then the files it lists. In a repository with submodules, read each one's diff too.
- Work not committed: run `git status`. A change left uncommitted is a note, not a finding (checks leave files behind).
- The previous review of this part: {{previous}}. When there is one, check that each of its findings was fixed or refuted with evidence; one left open is a finding again.
- What foreman knows of the run: `{{progress}}`. Claims there and in the commit messages are claims to check, not evidence.
- Skills to load first, if they exist here: {{skills}}
- Gates of this repo: {{gates}}. Do not run gates that write (builds, formatters, migrations); name the ones the implementer must run.

## What to write

Write one file, `{{reviewFile}}`, and nothing else:

1. Its **first line** is exactly `Verdict: OK`, `Verdict: NO` or `Verdict: BLOCKED`. `OK`: nothing blocks this part. `NO`: at least one finding must be fixed. `BLOCKED`: you could not review (no diff, an unreadable plan), and why.
2. One `###` section per finding. Suggested heading: `### C-01 · P1 · path/to/file.ext:42 · <one line>` (P1 breaks the part or the build, P2 a real defect with a plausible scenario, P3 robustness or clarity); in it, the scenario that fails, the expected correction, and how to verify it (a command or a test).
3. Last, a `### What I checked` section with what you found fine.

{{extra}}

## How you finish

End your answer with this JSON on one line, after everything else:

{"verdict":"NO","findings":3,"file":"{{reviewFile}}"}
