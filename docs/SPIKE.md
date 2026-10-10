# Phase 0 spike

Date: 2026-10-09. Machine: Windows 10, Git Bash and PowerShell 5.1.
Claude Code: `claude --version` printed `2.1.291` at the start and `2.1.296` after an auto-update during the spike; the background service ran `2.1.296`; the plugin API types (`claude-code.d.ts`) are from `2.1.293`.

Everything below was run for real; outputs are copied from the terminal (ids are the ones that run produced). The spike ran in `C:\Users\javi-\source\repos\foreman\.spike` (a scratch folder inside this repo, since deleted) so that nothing was written in `C:\MSG`. `foreman-demo` could not be used: see "Workspace trust".

## 1. Starting a background session

```bash
claude --bg --name "foreman:spike" --model sonnet --effort low --permission-mode auto -p "escribe hola en spike.txt"
```

Refused, exit 1:

```
--bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.
```

Working form (prompt as the positional argument, no `-p`):

```bash
claude --bg --name "foreman:spike" --model sonnet --effort low --permission-mode auto "escribe hola en spike.txt"
```

```
backgrounded · 638b3576 · foreman:spike
  claude agents             list sessions
  claude attach 638b3576    open in this terminal
  claude logs 638b3576      show recent output
  claude stop 638b3576      stop this session
```

The short id is the second field of the first line (`backgrounded · <id> · <name>`).

`claude agents --json --all` while it ran, then when it finished:

```json
{"pid":123396,"id":"638b3576","cwd":"C:\\Users\\javi-\\source\\repos\\foreman\\.spike","kind":"background","startedAt":1791577427746,"sessionId":"638b3576-3810-439d-80af-04c5d251e732","name":"foreman:spike","status":"busy","state":"working"}
{"pid":123396,"id":"638b3576","cwd":"C:\\Users\\javi-\\source\\repos\\foreman\\.claude\\worktrees\\spike-hola","kind":"background","startedAt":1791577427746,"sessionId":"638b3576-3810-439d-80af-04c5d251e732","name":"foreman:spike","status":"idle","state":"done"}
```

Fields seen in `claude agents --json`:

| Field | Values seen | Notes |
|---|---|---|
| `id` | 8 hex chars | background sessions only; interactive rows have none |
| `sessionId` | UUID | transcript file name |
| `kind` | `background`, `interactive` | interactive sessions are listed too |
| `cwd` | path | follows the session into a worktree while it is live; back to the original cwd once it exited |
| `name` | `--name`, or an auto title | a fork made by `--resume` gets an auto title, not the `--name` |
| `pid`, `status` | `busy`, `idle`, `waiting` | only while the process is live |
| `waitingFor` | `permission prompt`, `dialog open` | with `status: waiting` |
| `state` | `working`, `done`, `blocked`, `stopped` | stays after the process exited |
| `startedAt` | epoch ms | |

Without `--all` only live sessions are listed; `--all` adds exited ones. `--cwd <path>` filters:

```bash
claude agents --json --all --cwd 'C:\Users\javi-\source\repos\foreman\.spike'
# 3 sessions: 638b3576:done:exited 628f2bbf:done:exited 48f95b75:stopped:exited
```

### Finding: background sessions are isolated into a worktree

The first `Write` to the shared checkout failed with:

```
This background session hasn't isolated its changes yet. Call EnterWorktree first so edits land in a worktree instead of the shared checkout, then retry this edit using the worktree path (a path inside a linked git worktree, including one you create with `git worktree add`, is accepted). (To disable this guard for this repo, set `"worktree": {"bgIsolation": "none"}` in .claude/settings.json.)
```

The agent then created `.claude/worktrees/spike-hola` and wrote there. The guard can be turned off per launch without touching the repo:

```bash
claude --bg --name "foreman:spike-dialog" --model sonnet --effort low --permission-mode manual --settings '{"worktree":{"bgIsolation":"none"}}' "escribe la palabra iso en el archivo iso.txt de este directorio"
```

That session stayed in `.spike` (no worktree) and asked to create `iso.txt` there (see point 5). Decision D-01 in `DECISIONES.md`.

## 2. Sending a message to a background session

a) `--bg --resume` while the session is still live (`done`, `idle`, has a `pid`):

```bash
claude --bg --resume 638b3576-3810-439d-80af-04c5d251e732 "responde solo con la palabra PING2 y nada más"
```

```
note: session 638b3576 is already running in the background, so this started a copy as 628f2bbf. `claude attach 638b3576` opens the original.
backgrounded · 628f2bbf
```

A copy, not a message to the original: wrong for `/foreman tell`.

b) `claude stop` first, then `--bg --resume`:

```bash
claude stop 638b3576
# stopped 638b3576
claude --bg --resume 638b3576-3810-439d-80af-04c5d251e732 "responde solo con la palabra PING3 y nada más"
```

```
Starting background service…
note: woke session 638b3576 with its saved options (--name, --effort, --permission-mode, --model).
backgrounded · 638b3576 · foreman:spike
```

Same id, same name and options; the transcript gained the user row `responde solo con la palabra PING3 y nada más` and the assistant answered `PING3` (`stop_reason: end_turn`, `model: claude-sonnet-5-5`).

**Primitive for `/foreman tell` and `applying`:** if the session has a `pid` and its `state` is not `working`, `claude stop <id>`; then `claude --bg --resume <sessionId> "<text>"`. A `working` session is never stopped to deliver a message. `claude -p --resume` was not needed.

After `claude stop`, a `done` session keeps `state: done`; a `blocked` one becomes `stopped`. `claude rm <id>` deletes the session (exit 0, `removed <id>`); it did not remove the worktree the agent had made by hand with `git worktree add`. Unknown id: `claude stop deadbeef` → `No job matching 'deadbeef'. Run 'claude agents' to list running sessions.`, exit 1; `claude logs` of a removed id → exit 1.

## 3. Transcript

Path: `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, where the encoded cwd replaces every character that is not a letter or digit with `-`:

| cwd | folder |
|---|---|
| `C:\MSG` | `C--MSG` (exists, holds the MSG sessions) |
| `C:\Users\javi-\source\repos\foreman\.spike` | `C--Users-javi--source-repos-foreman--spike` |
| `C:\Users\javi-\source\repos\foreman\.claude\worktrees\spike-hola` | `C--Users-javi--source-repos-foreman--claude-worktrees-spike-hola` |

When a session enters a worktree its transcript **moves** to the worktree's folder (rows `{"type":"relocated","relocatedCwd":…}` and `worktree-state`): session 638b3576 started in `.spike` but its file ended up in `C--Users-javi--source-repos-foreman--claude-worktrees-spike-hola`. Lookup order: the encoded `cwd` from `claude agents`, then a scan of `~/.claude/projects/*/<sessionId>.jsonl`.

Row types in a background transcript: `user`, `assistant`, `attachment`, `system`, `last-prompt`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta`, `atis-latch`, `relocated`, `worktree-state`. **There is no `result` row** (that belongs to `-p --output-format json`).

- Usage: on each `assistant` row as `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, …). One API message is split into several rows, one per content block, **each repeating the same usage**: 13 assistant rows, 7 distinct `message.id`. Sum once per `message.id`.
- End of a turn: a `system` row with `subtype: "turn_duration"` and `durationMs`.
- Last assistant text: the text blocks of the last `assistant` row (`message.content[].type === "text"`), here `[{"type":"text","text":"PING3"}]`. The `foreman-result` fence is parsed from it.
- Size: 324 KB for two tiny turns (attachments are large). A real thread will pass 4 MiB, so the reader must read the tail only.

## 4. A minimal mod

`spike/mod` (plugin `foreman-spike`): a `/fspike` command with `proc`, `spawn`, `pane`, `store`; an agent type `foreman-spike:echo`; a pane with a button. `claude plugin validate spike/mod` passes (one warning: no author).

Slash commands through Git Bash need `MSYS_NO_PATHCONV=1`, otherwise `/fspike` arrives as `C:/Program Files/Git/fspike`.

```bash
export MSYS_NO_PATHCONV=1
claude -p --plugin-dir 'C:\Users\javi-\source\repos\foreman\spike\mod' "/fspike proc"
```

```
foreman-spike: proc: {"claude":{"exitCode":0,"count":16,"stderr":""},"claude.exe":{"exitCode":0,"count":16,"stderr":""},"C:\\Users\\javi-\\.local\\bin\\claude.exe":{"exitCode":0,"count":16,"stderr":""}}
```

`$.process.run(['claude', 'agents', '--json', '--all'])` works with the bare name: no full path needed (`where claude` → `C:\Users\javi-\.local\bin\claude.exe`, a real exe).

```bash
claude -p --plugin-dir 'C:\Users\javi-\source\repos\foreman\spike\mod' "/fspike spawn"
```

```
foreman-spike: spawn: {"model":"claude-haiku-5-5","agentId":"a19e845b7c5aad737"}
```

`$.agent.spawn` resolved at start; the `turn.complete` hook matched `e.agentId` and wrote:

```json
{ "agentId": "a19e845b7c5aad737", "answer": "PONG",
  "usage": { "input_tokens": 2, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 1276, "model": "claude-haiku-5-5" } }
```

So in a `-p` run the subagent's `turn.complete` still arrives before the process exits. Alias `haiku` resolves to `claude-haiku-5-5`.

```bash
claude -p --plugin-dir 'C:\Users\javi-\source\repos\foreman\spike\mod' "/fspike pane"
# foreman-spike: pane: {"isPlaced":true}
claude -p --plugin-dir 'C:\Users\javi-\source\repos\foreman\spike\mod' "/fspike store"
# foreman-spike: store: {"loads":6,"spawnedAgentId":"a19e845b7c5aad737","spawnAnswer":{…}}
```

`$.store` survives fresh loads: `loads` is incremented in `session.start` and reached 6 after six separate runs.

Pane button, through the engine's test kit (`spike/mod/hooks/pane.test.tsx`, mounted on `terminal` and `desktop`, press, read back):

```bash
claude plugin test spike/mod
# (pass) the pane button counts presses on terminal and desktop
# 1 pass, 0 fail
```

Kit notes: a `Text` drops its `key` (find it by `{ type: 'Text', text: /…/ }`); the test's `$` has no `store` noun.

`.claude-plugin/types/` is laid only when an interactive (watched) session loads the folder; `claude -p` does not lay it. `tsc` is not installed globally (see D-05).

## 5. A tool that is not allowed

`--permission-mode manual`, Write in the shared checkout (isolation off):

```json
{"pid":12488,"id":"48f95b75","cwd":"C:\\Users\\javi-\\source\\repos\\foreman\\.spike","kind":"background","sessionId":"48f95b75-7fcb-49bd-a154-174c3212ce7a","name":"foreman:spike-dialog","status":"waiting","waitingFor":"permission prompt","state":"blocked"}
```

`claude logs 48f95b75` (ANSI stripped) ends with the dialog: `Do you want to create iso.txt? ❯ 1. Yes  2. Yes, and switch to accept edits …  3. No`.

`--permission-mode auto`: a live MSG session started in auto mode (`c0f2ffa4`, 19 `"permissionMode":"auto"` rows in its transcript, read only) is listed as:

```json
{"pid":88960,"id":"c0f2ffa4","cwd":"C:\\MSG","kind":"background","sessionId":"c0f2ffa4-bd20-429c-a360-236e85ea80d4","name":"c0f2ffa4","status":"waiting","waitingFor":"dialog open","state":"blocked"}
```

A denial by the auto-mode classifier does not block: it comes back to the model as the tool's error (`Permission for this action was denied by the Claude Code auto mode classifier. Reason: [...]`) and the turn goes on. I did not provoke an auto-mode denial in a background session on purpose: the classifier of this chat refused the launches as a way around a denial it had just made.

Mapping for foreman: `state: blocked` → thread `blocked`, shown with `waitingFor`; the way out is `/foreman open` (`claude attach <id>`).

## Other findings

- **Workspace trust.** `claude --bg` in a folder never opened interactively fails with exit 1 and `claude -p` skips the trust dialog. foreman reports the message as is:

  ```
  Workspace not trusted. Run `claude` in C:\Users\javi-\source\repos\foreman-demo once and accept the trust prompt, then retry.
  ```
- **`claude logs`** prints the session's terminal screen with ANSI escapes, not a log; foreman strips escapes and keeps the last n non-empty lines.
- The user-level settings hooks on this machine fail with `node:internal/modules/cjs/loader:1503` in every session (unrelated to foreman; non-blocking).

## Addendum (Phase 2 and its review, 2026-10-09/10)

- A multi-line prompt with double quotes and `$` passed as one argv element arrives intact: the transcript's first user row was exactly `Line one with "double quotes" and $dollar.\nLine two: reply with exactly the word ACK2 and nothing else.`, the answer `ACK2`.
- **`--resume` with any other flag starts a copy:**

  ```bash
  claude --bg --resume ac0feea7-8cf5-4651-9ad3-8382c735a16d --settings '{"worktree":{"bgIsolation":"none"}}' "Create the file r2.txt in the current directory containing r2. Then reply DONE."
  # note: background session ac0feea7 keeps its own saved options, so the flags you passed started a copy as 365a92a1. Without flags, the same command continues ac0feea7 itself.
  ```

  Without flags the saved options include `--settings`, so isolation stays off:

  ```bash
  claude --bg --resume ac0feea7-8cf5-4651-9ad3-8382c735a16d "Create the file r3.txt in the current directory containing r3. Then reply DONE."
  # note: woke session ac0feea7 with its saved options (--name, --effort, --permission-mode, --settings, --model).
  ```

  It asked `Do you want to create r3.txt?` in the shared checkout (`cwd` unchanged), not for a worktree. (This addendum was meant to land with Phase 2; the command that appended it was cut short by a failed `rm`, review C-10.)
- **`state: "failed"`** (review C-03): a `claude --bg` interrupted while starting (Ctrl-C two seconds in, terminal tab `c3`) left `7075eb6d` listed as `{"id":"7075eb6d","cwd":"C:\\MSG","kind":"background","name":"foreman:adhoc:free","state":"failed"}`, with no `pid` and no transcript; `~/.claude/jobs/7075eb6d/state.json` stayed at `"detail": "starting…"`. foreman maps it to a `failed` thread and the pane's Failed group.
- **After a resume the job's `state` does not pass through `working`** (review C-01): `~/.claude/jobs/22801afb/timeline.jsonl` goes `done` (21:02:52.840Z) → `done` (21:03:31.633Z), and the new prompt row reached the transcript about 2.3 s after `/foreman tell` returned. Only the transcript, read against the time foreman sent the message, says when the new turn ended.
- **Tail of a large transcript** (review C-08): `C--MSG/012b80d4….jsonl`, 4,495,828 bytes, read with foreman's own `tailArgv` (`powershell.exe -NoProfile -NonInteractive -Command <fixed script>`, the path in `FOREMAN_TAIL_PATH`): exit 0, exactly 3,000,000 bytes out, UTF-8 intact (`Añadido…`), parsed by `readTranscript` with the cut first line dropped (`lastId: msg_011CePkTgT2puuZXkrtkc6UA`, 196,928 output tokens in the tail).

## Addendum (Phase 4, 2026-10-10)

- **A usage limit is a row the CLI writes itself** (review C-15). Read only, across `~/.claude/projects/**/*.jsonl` on this machine: 124 rows carry `"isApiErrorMessage": true`; their `error` is `rate_limit` (121, `apiErrorStatus: 429`) or `authentication_failed` (3, 401). A limit row:

  ```json
  {"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","apiErrorStatus":429,
   "quotaLimits":{"status":"rejected","resetsAt":1787529600,"rateLimitType":"five_hour","overageStatus":"rejected",…},
   "message":{"model":"<synthetic>","stop_reason":"stop_sequence","content":[{"type":"text","text":"You've hit your session limit · resets 2am (Europe/Madrid)"}],"usage":{"input_tokens":0,"output_tokens":0,…}}}
  ```

  `quotaLimits.resetsAt` is the reset in epoch seconds; the text varies (`session limit`, `weekly limit`, times with and without minutes). foreman reads the row's fields, never the text, and only when the row is the last assistant row of the turn it is waiting for.
- **A subagent's hand-back is a peer prompt.** When a reviewer that foreman spawned ends, the parent session receives `prompt.submit` with `origin: { kind: "peer", from: "<agentId>", senderTaskId: "<agentId>", name: "foreman:reviewer", handback: true }` and the text `<agent-message from="<agentId>">[Subagent hand-back] …`. Live in the interactive Phase 4 run, each such hand-back woke the chat's own model (Opus 5.5) for a turn of its own ("Quick check of the claim before reporting"), and the engine then proposed `push it` as the next prompt (a suggestion, not sent). See D-47.
- **The live cycle** (foreman-demo, interactive `claude --plugin-dir`, 2026-10-09 23:20–23:22 UTC): `implementing` → `reviewing` (r1, `Verdict: NO`) → `applying` → `implementing` → `reviewing` (r2, `Verdict: OK`) → `ready` in 1 min 41 s, nobody typing after the first command; the resume prompt the implementer received was the review's path and the fixed instructions, nothing of the review's text.

## Addendum (Phase 5, 2026-10-10)

- **A thread knows it is one.** The `env` of `--settings` reaches the background session's process:

  ```bash
  claude --bg --name "foreman:spike-env" --model haiku --effort low --permission-mode auto --plugin-dir 'C:\Users\javi-\source\repos\foreman' --settings '{"worktree":{"bgIsolation":"none"},"env":{"FOREMAN_THREAD":"foreman:spike-env"}}' 'Run this exact shell command with the Bash tool and reply with its output only: echo "T=$FOREMAN_THREAD"'
  # backgrounded · 696442f1 · foreman:spike-env      → the answer: T=foreman:spike-env
  ```

  `--plugin-dir` is taken with `--bg`: the thread loaded foreman, and before thread mode existed its status line read `⚠ foreman: 1 ready`, which is the full watcher running inside the thread on the shared registry (the review's warning for Phase 5).
- **Thread mode, live.** With the marker, the thread's status line reads `⚠ foreman: thread foreman:p5b:implementer: the profile's guards are on`; neither thread's session id appears as an owner anywhere in the store.
- **The guards inside a thread, live** (foreman-demo, run `p5c`, implementer N1 on Sonnet, its brief asking for every guarded step): `Edit src/sum.js` before any Grep came back with the note `foreman guard (warning from this repo's profile): House rule: search the callers before you change src/: call Grep before Edit on src/sum.js` and ran; `Edit test.js` → `foreman guard: test.js is the acceptance; it is not edited by threads: Edit on test.js`; `git add -A` → `foreman guard: Explicit paths, never git add -A: Bash (cd /c/Users/javi-/source/repos/foreman-demo; git add -A)`. The thread wrote `report.md`, committed by explicit paths (`2f7234c`, test.js untouched) and ended with a valid `foreman-result` quoting both refusals.
- **A shell write is not an Edit.** In the run before (`p5b`) the thread changed `test.js` with `sed -i` through Bash, where the path guard (written for Edit/Write) did not look; see D-52.
- **onRunCreate, live:** `hooks.onRunCreate ran for p5c: DRY RUN: would create run p5c (handoff.md, report.md, branch codex/p5c)`, recorded in `.claude/runs/p5c/foreman.json` under `hooks` with its argv and exit 0.

## Addendum (Phase 6, 2026-10-10)

- **Install from GitHub in a clean profile.** In Git Bash, with `CLAUDE_CONFIG_DIR` set to an empty scratch folder, `GIT_TERMINAL_PROMPT=0` and stdin closed (no credentials anywhere): `claude plugin install foreman --marketplace andrey342/foreman` printed `SSH not configured, cloning via HTTPS: https://github.com/andrey342/foreman.git` … `✔ Successfully added marketplace: foreman (declared in user settings)` … `✔ Successfully installed plugin: foreman@foreman (scope: user)` and `2 userConfig options not yet set — run /plugin configure foreman@foreman in Claude Code, or pass --config KEY=VALUE.`, exit 0. `claude plugin list`: `foreman@foreman · Version: 0.1.0 · Scope: user · Status: ✔ enabled`. In the installed copy (`<config>/plugins/cache/foreman/foreman/0.1.0`): `claude plugin validate .` → `✔ Validation passed`; `claude plugin test .` → 161 pass, 0 fail. `claude plugin details foreman@foreman` counts `Hooks (0)`: it counts declared hooks, not function-hook modules.
- **The installed copy, live, with no profile** (foreman-demo, after removing its temporary profile and `scripts/fake-new-run.ps1`; foreman loaded with `--plugin-dir <installed copy>`, the real configuration has no foreman installed). A session in the scratch configuration cannot run a model without signing in, which was not done.
  - `claude --plugin-dir <copy> -p "/foreman profile"` → `No .claude/foreman.json: running on the defaults.` and the defaults.
  - `claude --plugin-dir <copy> -p '/foreman launch free "List the files in src/ and say how many there are. Do not edit anything." --model haiku --effort low'` → `Launched foreman:adhoc:free as 5a61eabf (haiku, effort low, auto).`; `claude agents` showed it `working`, then `done`.
  - `/foreman status` → row `| 4 | 5a61eabf | foreman:adhoc:free | free | Done | 2s | 19k in · 299 out · 80k cached | /foreman close 5a61eabf |`; `/foreman log 5a61eabf 8` → its `foreman-result` (`"status": "done", "summary": "src/ contains 1 file: sum.js. No edits made."`); `/foreman open 1` → ``Run in a terminal: `claude attach 7ced4baa` ``.
  - `/foreman review --run p6 --part A --base HEAD~1 --model haiku` → `Started foreman:reviewer (claude-haiku-5-5) on p6 part A, diff HEAD~1..HEAD.`; `.claude/runs/p6/review-A-r1.md` opens with `Verdict: OK`; the record: verdict OK, 2 findings, `settledBy: answer`. `git status` of foreman-demo: nothing outside `.claude/runs/`.
  - The thread's status line read `the profile's guards are on` with no profile at all; it now counts them, or says `no guards in the profile` (test).
- **`--safe-mode` drops `--plugin-dir` too**: with both, the session had no `/foreman` command. The plan's "`claude --safe-mode` + only this plugin" is therefore not a way to load one plugin.
- **Git Bash rewrites a leading `/`**: `claude -p "/foreman profile"` arrived as `C:/Program Files/Git/foreman profile`; `MSYS_NO_PATHCONV=1` fixes it (README, Troubleshooting).
- **Eval sandbox** (`claude plugin eval . --scaffold --trust-plugin --allow-tools Write`): `claude --bg failed (exit 1): … Workspace not trusted` for any thread; the reviewer subagent's Write is denied under the eval's dontAsk mode; PowerShell finds WSL's `bash` first for `scaffold_script` (`execvpe(/bin/bash) failed`), so the suite runs from Git Bash. Result: `cycle 1.00 · launch 1.00 · review 1.00`, 3 cases, $0.01 (D-59).
- **`--deep` live: not run.** This session has the `Workflow` tool, but a live `--deep` starts a multi-agent workflow (many agents, real cost), and nothing in the instructions opts into that scale; both branches (with and without `Workflow`) are covered by `reviews.test.ts`.
