# Pending for the user

Steps the plan asks to run in `C:\MSG`, which foreman's implementer did not run there: other chats were working in that checkout (review of Phase 2, 2026-10-10: "nothing in C:\MSG"). The equivalent of each was run in `C:\Users\javi-\source\repos\foreman-demo`. In order:

## 1. Put the MSG profile in place (Phase 5)

```text
copy C:\Users\javi-\source\repos\foreman\profiles\msg.json C:\MSG\.claude\foreman.json
```

Then, in a session in `C:\MSG` started with `claude --plugin-dir C:\Users\javi-\source\repos\foreman`, `/foreman profile` must say `Profile: defaults + .claude/foreman.json.` with no warning, `runsDir: ".agents/runs"` and three guards.

## 2. Try `onRunCreate` with `-DryRun` first (Phase 5)

The profile's hook is `new-run.ps1 -RunId {{runId}} -Repos MSG,Backend,Frontend -JoinBranch`. Before a real launch, change it for one run to end in `-DryRun`, launch something small with a new `--run`, and read what `new-run.ps1` says it would do (the launch's answer and `.agents/runs/<run>/foreman.json` under `hooks`); then put it back without `-DryRun`.

Equivalent in foreman-demo: `hooks.onRunCreate ran for p5c: DRY RUN: would create run p5c (handoff.md, report.md, branch codex/p5c)`.

## 3. Phase 5 acceptance in MSG

```text
/foreman launch implementer "N1: añade una línea a docs/shared/business/08-known-limitations.md (prueba) y termina" --run <new run> --level N1
```

What to check: the thread writes `report.md` in its run and ends with a `foreman-result`; a `git add -A` it tries is refused with `foreman guard: Rutas explícitas, nunca git add -A: …`; its status line (`claude logs <id>`) says `thread …: the profile's guards are on (3)`; it loads the `msg-*` skills, GitNexus and `run-state-hook.ps1` (they are the repo's: they apply).

Equivalent in foreman-demo (run `p5c`): the warn note before an edit of `src/`, `Edit test.js` and `git add -A` refused, `report.md` written, commit `2f7234c` by explicit paths, a valid `foreman-result` quoting both refusals.

## 4. Check the `msg-*` skills are found (review N-03)

foreman leaves out of a brief the profile skills that `$.command.list()` does not list (D-30). Skills only the model may invoke (`user-invocable: false`) might not be listed. In step 3, the launch must not answer `Skills not found in this session, left out of the brief: …` for `msg-implement-plan` or `msg-run-state`; if it does, the check needs another source.

## 5. Phase 3 acceptance on the MSG run

```text
/foreman review --run 20261006-fase2-p4-p5-duplicacion --part A --base origin/develop
```

What to check: the answer says `Started foreman:reviewer (…) on <run> part A, diff origin/develop..HEAD. It writes .agents/runs/<run>/review-A-r<n>.md`; when it ends, a line `Review A r<n>: OK|NO|BLOCKED, <k> finding(s). …` and the file's first line `Verdict: …` (or `Veredicto: …`); `git status` in `C:\MSG` and both submodules shows nothing new but that file and `.agents/runs/<run>/foreman.json`.

Equivalent in foreman-demo: `review-A-r1.md` with `Verdict: NO` and the seeded bug as C-01; `critic-A-r1.md` with `Verdict: FAIL`; `git diff --stat` empty.

## 6. Retire `gitnexus-guard.js` (plan §8)

Once steps 1 and 3 show the guards working in MSG, remove the `PreToolUse` entry that runs `node C:/MSG/.claude/hooks/gitnexus-guard.js` from `C:\MSG\.claude\settings.local.json`: the profile covers both of its reminders (impact before editing a `.cs`, detect_changes before `git commit`, both as warnings) and adds the `git add -A` refusal. Keep the script file until a few runs have gone by.

## 7. Guards act in every session (review P5-01)

With foreman installed at user scope, the profile's guards act in **every** session that loads it in that repo: your own chats too, not only foreman's threads; and they fail closed (a call foreman cannot judge, or a profile with guards that no longer parses, is refused). In `C:\MSG` this means the `git add -A` refusal and the two GitNexus warnings also apply in the chats you work in by hand. If that is not wanted, keep foreman loaded per session (`claude --plugin-dir …`) in MSG instead of at user scope, or drop the guard from the profile.
