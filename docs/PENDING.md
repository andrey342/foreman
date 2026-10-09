# Pending for the user

Steps the plan asks to run in `C:\MSG`, which foreman's implementer did not run there: other chats were working in that checkout (review of Phase 2, 2026-10-10: "nothing in C:\MSG"). The equivalent was run in `C:\Users\javi-\source\repos\foreman-demo`.

## Phase 3 acceptance on the MSG run

Plan: "`/foreman review --part A --base origin/develop` on the current MSG run produces `review-A-r2.md` with the verdict on its first line, without touching code."

Run it after Phase 5 has put `C:\MSG\.claude\foreman.json` in place (its `runsDir` is `.agents/runs`; without the profile the review lands in `C:\MSG\.claude\runs/<run>/`):

```text
cd C:\MSG
claude --plugin-dir C:\Users\javi-\source\repos\foreman
/foreman review --run 20261006-fase2-p4-p5-duplicacion --part A --base origin/develop
```

What to check:

- the answer says `Started foreman:reviewer (…) on <run> part A, diff origin/develop..HEAD. It writes .agents/runs/<run>/review-A-r<n>.md`; `n` is one past the review files already in the run's folder;
- when it ends, a line `foreman: Review A r<n>: OK|NO|BLOCKED, <k> finding(s). …` and the file's first line `Verdict: …` (or `Veredicto: …`);
- `git status` in `C:\MSG` and both submodules shows nothing new but that file and `.agents/runs/<run>/foreman.json`.

Equivalent run in foreman-demo (2026-10-10): `review-A-r1.md` with `Verdict: NO` and the seeded bug as C-01; `critic-A-r1.md` with `Verdict: FAIL`; `git diff --stat` empty.

## Phase 3 note to check in Phase 5 (review N-03)

foreman leaves out of a brief the profile skills that `$.command.list()` does not list (D-30). Skills only the model may invoke (`user-invocable: false`) might not be listed. With the real `msg-*` skills, check that `/foreman launch implementer …` does not report them as missing; if it does, the check needs another source.
