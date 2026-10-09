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

**D-17 · Thread state from a finished turn (corrected after review C-01).** `claude agents` says `done`; the transcript decides. foreman stamps `sentAt` on the thread when it launches it and at every `/foreman tell`, and reads the `foreman-result` only when the transcript holds a prompt written at or after `sentAt` with a `turn_duration` after it; `lastText` comes from the assistant rows after the last prompt only. Until then the thread stays `working`: after a resume the job's `state` never passes through `working` and the new prompt lands about 2 s later (SPIKE addendum), so neither the row nor an old turn end may close the new turn. A message that has not reached the transcript three minutes after `sentAt` leaves the thread `waiting` ("the message never reached the thread"). Then: a valid block with `done` → `ready` (needs review), or `done` for the self-closing roles `free` and `triage`; `question`/`blocked` → `waiting` with the question; `failed` → `failed`; no block or a broken one → `waiting` with `noResult` and the reason, never an invented done.

**D-18 · Usage is counted incrementally (corrected after review C-06).** Each sync adds the usage of assistant messages newer than the thread's `usageSince`, once per `message.id`, and skips the rows of `usageLastId`, the last message already counted: one message is written over several rows a second or more apart, so a read can fall between them. A transcript read through its tail (over 3.5 MB) still adds up.

**D-19 · Registry.** Threads live in `$.store` under `threads:<repo root, normalised>` (the registry every chat shares, D-25) and in `$.state` (`foreman.threads`, this session's copy). A thread launched with `--run <id>` is also written, with every transition, to `<runsDir>/<id>/foreman.json`. `onRunCreate` runs in Phase 5.

**D-20 · `maxParallelThreads` counts busy foreman sessions, whichever chat launched them (corrected after review C-02).** Busy: a live row of `claude agents` under the repo named `foreman:*` that is `working`/`blocked` (or `busy`/`waiting`), plus a registry thread just launched that the CLI does not list yet. A thread waiting for an answer, ready for review, failed or exited does not hold a slot.

**D-21 · No prefix in status and toasts.** The engine already draws them under the plugin's name (`⚠ foreman: foreman: 1 working` was seen), so the texts carry none.

**D-22 · PowerShell 5.1 and inner quotes.** Passing `'/foreman launch free "…"'` from PowerShell 5.1 to `claude.exe` mangles the inner double quotes; foreman's argument parser takes single quotes too (`'/foreman launch free ''…'''`). Inside a Claude Code session the prompt box has no such problem. For the README's troubleshooting.

## Phase 2 review (2026-10-10)

**D-23 · Review findings deferred.** C-13 (`claudeExe` from the repo's profile runs at `session.start` and every 30 s): kept for now, the same trust a project's settings hooks get once the workspace is trusted; Phase 6 moves `claudeExe` to `userConfig` and stops reading it from the repo. C-15 (`LIMIT_RE` matches the model's own words): goes with Phase 4, where `limit` starts an automatic retry; until then it only labels a thread whose turn ended without a block. C-17 (reviewer and critic have `Bash` and `Write`): goes with Phase 3's guards.

**D-24 · Rules every thread gets (review C-05).** `prompts/_rules.md` (no push, pull request, merge, tag or release unless the assignment says so in writing; stay in the repo and the task) is appended to every role's brief before the result contract, and `/foreman tell` adds the same rule to every message.

**D-25 · `$.store` is the shared registry (review C-02).** Every chat of the repo runs its own watcher. Each write re-reads the store and merges by id (the later `updatedAt` wins, then the later `usageSince`), and every sync and command first pulls the store into the session's copy, so a chat never drops a thread another chat launched and sees its changes. A transition the run file already ends with for that thread is not appended again. The read-merge-write is not atomic across processes: two chats writing in the same instant can still lose one write, which the next sync repairs from the CLI and the transcript.

**D-26 · The Windows tail script is fixed (review C-08).** `powershell.exe -NoProfile -NonInteractive -Command <script>` reads the path from `$env:FOREMAN_TAIL_PATH`, passed through `ProcessRunInit.env`; no path is spliced into the script. It is the one place foreman runs a shell, because Windows has no `tail`; elsewhere `tail -c`. Checked on a real 4.5 MB transcript (SPIKE addendum).

**D-27 · The registry stays small and run files are never lost (review C-14).** Results are cut to 2,000 characters per text and 50 entries per list, `waitingFor` to 300; closed threads are dropped after 14 days. A run `foreman.json` that does not parse is copied to `foreman.json.broken-<time>` before a new one is written, with a line in the transcript.

**D-28 · One sync at a time, shared (review C-09).** The module keeps the promise of the sync in flight: the watcher, Refresh and launch join it, and `/foreman status` and opening the pane wait for it and then run a fresh one, so they never print what is about to be replaced. It is a module value: a reload loses it, which at worst lets two syncs overlap, and D-25's merge absorbs that.

**D-29 · Work root and repo root (review C-16).** The session's own checkout (`$.session.root()` when it holds a `.git`, as a worktree does; else the repo root) is where threads run and where `.claude/foreman.json` and `runsDir` are read. The main working tree (`$.session.repo().root`) keys the registry and filters the pane, so the threads of every worktree of a repo show together.

**D-30 · Skills that do not exist (review C-11).** At launch foreman lists the session's commands (skills are among them, a plugin's as `plugin:name`) and leaves out of the brief every profile skill it does not find, saying which in the command's answer. When the list cannot be read, all are kept.

**D-31 · `failed` sessions (review C-03).** `claude agents` can say `state: "failed"` (a launch cut short while starting). The thread becomes `failed` with the reason and frees its slot; the pane has a Failed group; a session that exited while `blocked` (no `pid`) is shown as stopped, not as waiting for the user. The projects folder is scanned for a transcript only while the session is live.

**D-32 · Commands never fail silently (review C-12).** A `/foreman` command's errors come back as its answer (`/foreman <args> failed: <reason>`). A `tell` whose stop went through but whose resume did not marks the thread `stopped` ("a message failed to resume it"). A brief or message over 30,000 characters is refused before Windows' 32,767-character command line would refuse it.
