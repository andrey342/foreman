# Decisions

Decisions taken while implementing the plan (`docs/PLAN.md`), with date and reason. Where the build's `claude-code.d.ts` or the CLI disagrees with the plan, the build wins and the difference is recorded here.

## Phase 0 (2026-10-09)

**D-01 · Background sessions run in the shared checkout by default.** Claude Code isolates a `--bg` session in a git repo into a worktree (its first edit is refused until it calls `EnterWorktree`; see SPIKE §1). The plan assumes threads work in the repo's checkout (MSG has submodules, Docker and run files there; `maxParallelThreads: 1` serialises the work). foreman therefore launches with `--settings '{"worktree":{"bgIsolation":"none"}}'` and never writes `.claude/settings.json` of the repo. New profile key `isolation`: `"none"` (default) or `"worktree"` (Claude Code's own behaviour, for parallel threads).

**D-02 · `--bg` without `-p`.** The plan's launch line carries `-p`; the CLI refuses `--bg` with `--print`. The prompt goes as the positional argument.

**D-03 · Message to a thread = stop if live, then `--bg --resume` with no other flag.** `claude --bg --resume <sessionId> "<text>"` on a live session starts a copy under another id; on a stopped one it wakes the same id with its saved options and delivers the text; any other flag on the resume line starts a copy (SPIKE addendum), and the saved options already carry `--settings`. `send` stops a live session first, and refuses to touch a `working` one. No §10 stop: there is a way to deliver a message.

**D-04 · Usage comes from `assistant` rows, deduplicated by `message.id`.** Background transcripts have no `result` row. Each API message is split into one row per content block, each with the same `usage`. A turn ends at a `system` row with `subtype: "turn_duration"`.

**D-05 · Type-checking.** `tsc` is not installed on the machine and `.claude-plugin/types/` is laid only by an interactive load. The repo carries `typescript` as a dev dependency (`npx tsc -p .`) and a script that copies the build's `claude-code.d.ts` into `.claude-plugin/types/claude-code/` when the engine has not laid it (git-ignored, regenerated, never edited).

**D-06 · `claude` from PATH.** `$.process.run(['claude', …])` resolves `claude.exe` from PATH on Windows; `claudeExe: null` means `'claude'`.

**D-07 · The plugin lives in this repo, not in the session's mods folder.** The plugin-authoring skill writes mods under `~/.claude/dev-mods/<session>/`; the user asked for `C:\Users\javi-\source\repos\foreman`, loaded with `claude --plugin-dir`.

**D-08 · Spike cwd.** The spike ran in a scratch folder of this repo, not in `C:\MSG` (nothing may be written there before Phase 5) nor in `foreman-demo` (not trusted yet: `--bg` refuses an untrusted workspace).

**D-09 · Haiku alias.** The plan's D4 names "Haiku 4.5" for panel summaries; the `haiku` alias resolves to `claude-haiku-5-5` on this build. Profiles use aliases (`haiku`, `sonnet`, `opus`, `fable`), not ids.

**D-10 · `claude logs` is a screen, not a log.** It prints the session's terminal with ANSI escapes. `/foreman log` strips them and keeps the last n non-empty lines.

## Phase 1 (2026-10-09)

**D-11 · Every call on `$` lives in `hooks/register.tsx`.** `claude plugin validate` refuses `$` passed to a function imported from another file ("$ is followed only into a function declared in this same file, never across an import"), and `update`/`read` need atoms declared in the same file. So `hooks/lib/*` and `hooks/ui/*` are pure (data in, data or element trees out: the pane gets the surface's element table, not `$`), and `register.tsx` holds the atoms, the `$` helpers and the hooks. The plan's file list stays; only where `$` is touched moves.

**D-12 · The spike's test is not a test of this plugin.** `claude plugin test .` runs every `*.test.ts(x)` under the folder, `spike/mod` included, where the spike plugin is not loaded. It is kept as `spike/mod/hooks/pane.spike.tsx` (it passed in Phase 0, commit a8832b9; rename it to `.test.tsx` and run `claude plugin test spike/mod` to repeat).

**D-13 · No `userConfig` yet.** Nothing global is needed so far: everything per repo is in the profile, and `claudeExe` defaults to `claude` from PATH. A `userConfig` field is added when a global setting appears.

**D-14 · The pane lists background sessions only.** Interactive chats appear in `claude agents --json` too; the pane shows `kind: background` rows under the repo root (worktrees included), live ones and exited ones from the last 7 days, grouped Working / Waiting for you / Done / Stopped. The status line counts live ones only.

**D-15 · Tested build.** The engine laid the 2.1.296 declarations at the first interactive load; `tsc -p .` runs against them. `scripts/sync-types.mjs` fills the folder from the skill bundle when no interactive load happened yet.

## Phase 2 (2026-10-09)

**D-16 · Command names follow §4 (English).** The Phase 2 list of the plan says `lanza, di, abre, log, para, cierra, estado`; the commands are `launch, tell, open, log, stop, close, status`, as §4 and the user's rules ask.

**D-17 · Thread state from a finished turn.** `claude agents` says `done`; the transcript's last assistant text decides: a valid `foreman-result` with `done` → `ready` (needs review), or `done` for the self-closing roles `free` and `triage`; `question`/`blocked` → `waiting` with the question; `failed` → `failed`; no block or a broken one → `waiting` with `noResult` and the reason, never an invented done. The fence is read only once the transcript shows the turn ended (`turn_duration` after the last prompt), so a stale `done` row right after a resume is not read as the new turn's end.

**D-18 · Usage is counted incrementally.** Each sync adds the usage of assistant messages (once per `message.id`) and the turns newer than the thread's `usageSince`, so a transcript read through its tail (over 3.5 MB) still adds up.

**D-19 · Registry.** Threads live in `$.state` (`foreman.threads`) and in `$.store` under `threads:<repo root, normalised>`, restored at `session.start`. A thread launched with `--run <id>` is also written, with every transition, to `<runsDir>/<id>/foreman.json`. `onRunCreate` runs in Phase 5.

**D-20 · `maxParallelThreads` counts threads that are `working` or `blocked`.** A thread waiting for an answer or ready for review does not hold a slot.

**D-21 · No prefix in status and toasts.** The engine already draws them under the plugin's name (`⚠ foreman: foreman: 1 working` was seen), so the texts carry none.

**D-22 · PowerShell 5.1 and inner quotes.** Passing `'/foreman launch free "…"'` from PowerShell 5.1 to `claude.exe` mangles the inner double quotes; foreman's argument parser takes single quotes too (`'/foreman launch free ''…'''`). Inside a Claude Code session the prompt box has no such problem. For the README's troubleshooting.
