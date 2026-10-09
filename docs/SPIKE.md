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
