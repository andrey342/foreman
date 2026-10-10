# foreman

**Coordinate long-running Claude Code work as background threads (implement → review → apply) from one chat, with code doing the coordination.**

```text
C:\repos\demo · listed 10:42:07   [Refresh]

Threads (2)
  1. 3f9a1c2e  foreman:20261010-plan:implementer-A  · Ready for review
     sonnet/high · 48k in · 6120 out · 1210k cached · Fixed the off-by-one in sumTo; node test.js prints ok
     › Committed 9e5a683 with explicit paths; node test.js exits 0.
    [Open] [Review] [tell it…        Reply]
  2. b71d04aa  foreman:adhoc:free  · Working
     haiku/low · 8120 in · 512 out · 30k cached
    [Open]

Cycles
  20261010-plan:A  · reviewing · r1 NO · max 2

Reviews
  Review A r1: NO, 1 finding(s). .claude/runs/20261010-plan/review-A-r1.md
  Review A r2: running

No other background sessions in this repo.
```

*The foreman pane (`/foreman`), as drawn in a terminal.*

## Why

Long work on a real repo means several chats at once: one implements, another reviews with fresh eyes, a third checks acceptance. Moving between them is the slow part. You copy paths, paste "apply this review", watch for the one that stopped on a dialog, and redo it all after a usage limit.

foreman does that relay for you. Threads are ordinary `claude --bg` sessions on your machine. The reviewer is a fresh, read-only subagent. The loop that joins them is code: a 30-second watcher and a fixed state machine. No model routes the work, so coordinating costs **0 tokens**.

How it compares with Claude Code **Projects**: Projects can also run threads on your machine through Remote Control ("Work locally"). Its coordinator is a model, though, which costs tokens to route, and its implement → review loop is not fixed. Local threads also run only while the PC is awake, and that is just as true of foreman. foreman is 100% local, coordinated by code, and sets the cycle, the models and the cost per repo through a profile.

## Install

Tested on **Claude Code 2.1.296** (Windows 10; the code has no Windows-only parts, and macOS and Linux follow the same paths with `/` separators).

1. In a terminal:

   ```bash
   claude plugin install foreman --marketplace andrey342/foreman
   ```

   This adds the `andrey342/foreman` marketplace to your user settings and installs foreman at **user** scope (the default), so it is there in every repo. From inside a chat, `/plugin` does the same: add the marketplace `andrey342/foreman`, then install `foreman` with scope **user**.
2. Answer **y** if Claude Code asks you to trust the plugin's code. foreman runs function hooks: it starts `claude` processes and reads their transcripts.
3. Start `claude` in a repo you have **trusted** (Claude Code refuses background sessions in an untrusted folder) and type `/foreman help`.

Optional settings, for you rather than for a repo:

```bash
claude plugin configure foreman
```

| Setting | Default | What it does |
|---|---|---|
| `claudeExe` | empty: `claude` from PATH | The `claude` executable foreman runs to start and watch threads. |
| `notifyCommand` | empty: toasts only | Run on each cycle notice, by argv with no shell; `{{message}}` is replaced by the notice. Example: `powershell.exe -NoProfile -File C:\tools\notify.ps1 {{message}}`. Use `-File`, never `-Command "… {{message}}"`: with `-Command` the notice would run as PowerShell code. |

These two run programs without anyone typing them, so a repo's profile cannot set them. A profile that tries gets a warning, and the key is ignored.

## Quick start (5 minutes)

In a trusted git repo:

```text
/foreman init
/foreman launch implementer "Add a --verbose flag to the CLI and a test for it" --level N1
/foreman status
/foreman open 1
```

- `init` writes `.claude/foreman.json` with defaults, guessing the gates from `package.json`, `*.sln` or `pyproject.toml`. It is optional: without it foreman works the same, on the defaults.
- `launch` starts a background thread with the implementer's brief and answers with its id.
- `status` lists the threads: role, state, since when, tokens and the next action.
- `open` prints and copies `claude attach <id>`, to watch or talk to the thread in its own terminal.
- `/foreman` alone opens the pane, which has Open, Review and Reply on each thread.

When the thread is **Ready for review**, `/foreman review` starts a fresh reviewer on the thread's diff. Or let foreman run the whole loop:

```text
/foreman cycle docs/plans/my-plan.md --part A --level N2
```

## The cycle

```text
launch implementer (plan, part)
   │
   ▼
[implementing] ── watcher every 30 s: `claude agents --json` + the transcript's foreman-result ──┐
   │ done                                │ blocked / question            │ usage limit
   ▼                                     ▼                               ▼
[reviewing] fresh reviewer          [waiting] toast + pane           [limit] retried at the reset
   │ writes review-<part>-r<n>.md   you: /foreman tell …
   ▼
Verdict OK ─────────────────► [ready] "Part A is ready"; in night mode → the next part
Verdict NO, rounds left ─────► [applying] the implementer is told "apply review-<part>-r<n>.md:
                               fix or refute each finding with evidence" → [implementing]
Verdict NO, rounds used up ──► [waiting] "review rounds used up: decide"
Verdict BLOCKED / no verdict ► [waiting]
```

- One active cycle per run, and one implementer alive while `maxParallelThreads` is 1.
- foreman never answers a thread's question or blocker for it.
- It sends the implementer the review's path, not its text.
- Every transition is written, with its time, to `<runsDir>/<run>/foreman.json`.
- A cycle belongs to the chat that started it. If that chat closes, the next chat that opens foreman in the repo adopts the cycle and carries on.

**The foreman-result contract.** Every thread's brief asks it to end each turn with this block. foreman reads it to decide what happens next:

````text
```foreman-result
{ "status": "done", "summary": "one or two lines", "commits": ["<sha>"], "gates": [{ "cmd": "npm test", "exit": 0 }], "files": ["src/cli.js"] }
```
````

`status` is `done`, `question` (with `"question"`), `blocked` or `failed`. A turn without the block shows the thread as waiting, never as done.

**Review files.** The reviewer writes `<runsDir>/<run>/review-<part>-r<n>.md`, and its first line must read `Verdict: OK|NO|BLOCKED`. The critic writes `critic-<part>-r<n>.md` with `Verdict: PASS|FAIL|BLOCKED`. `Veredicto:` is accepted too. A missing file, or a first line with no verdict, counts as "no verdict", never as OK.

## Commands

| Command | What it does |
|---|---|
| `/foreman` | Open or close the pane. |
| `/foreman launch <role> "<task>" [--run <id>] [--part A] [--model m] [--effort e] [--level N1\|N2\|N3]` | Start a background thread with the role's brief. Roles: `planner`, `implementer`, `qa`, `free` (`free`: your task with only the common rules). `reviewer`, `critic` and `triage` are accepted too, but run outside the reviewer guard; use `/foreman review` and `/foreman critic` for those. |
| `/foreman status` | Threads: role, state, since, tokens, next action. |
| `/foreman tell <thread> "<message>"` | Send a message to a thread (stops it if live, then resumes it with the message). |
| `/foreman open <thread>` | Print and copy `claude attach <id>`. |
| `/foreman log <thread> [n]` | The last n lines of the thread's screen. |
| `/foreman stop <thread>` | Stop a thread; its conversation is kept. |
| `/foreman close <thread>` | Mark a thread done and take it off the pane. |
| `/foreman review [--part A] [--base <ref>] [--run <id>] [--plan <md>] [--deep]` | A fresh read-only reviewer on `<base>..HEAD` plus uncommitted work. `--deep`: a multi-agent review through the `Workflow` tool, when your session has it. |
| `/foreman critic [--part A] [--base <ref>] [--run <id>] [--plan <md>]` | A fresh acceptance critic: `critic-<part>-r<n>.md`. |
| `/foreman cycle <plan.md> --part A [--level N1\|N2\|N3] [--cycles 2] [--run <id>]` | Implement, review and apply until OK, or until it needs you. |
| `/foreman night on\|off\|status` | Chain the plan's parts, allow one more review round, and keep notices for the morning. |
| `/foreman init` | Write `.claude/foreman.json`, or check the one that is there. |
| `/foreman profile` | Show the profile in effect and its warnings. |
| `/foreman help` | The command list. |

`<thread>` is an id, a name, or the number from `/foreman status`. Thread names are `foreman:<run>:<role>-<part>` (`foreman:adhoc:<role>` without a run). `--base` defaults to `origin/HEAD`, else `HEAD~1`.

## Profile reference

`.claude/foreman.json` in the repo. **Every key is optional.** A missing key takes its default. A wrong key gets a warning and its default, and never blocks a command.

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | Profile format. |
| `runsDir` | `".claude/runs"` | Where each run's folder lives (`foreman.json`, reviews, the thread's `handoff.md`/`report.md`). Created on first use. |
| `isolation` | `"none"` | `"none"`: threads work in your checkout. `"worktree"`: Claude Code's own isolation of background sessions, one worktree each. |
| `repos` | `[{ "name": "root", "path": "." }]` | The repo and its submodules, named in the briefs. |
| `roles.<role>.model` / `.effort` | see *Models & cost* | Per role: `planner`, `implementer`, `reviewer`, `critic`, `qa`. |
| `roles.<role>.permissionMode` | `"auto"` | The thread's or subagent's permission mode. |
| `roles.<role>.byLevel.N1\|N2\|N3` | implementer `N1`: `sonnet` | Overrides by `--level`. |
| `roles.<role>.skills` | `[]` | Skills the brief asks the role to use. A skill the session does not list is left out, with a note. |
| `roles.<role>.extra` | `""` | Repo notes appended to the role's brief. |
| `roles.reviewer.tools`, `roles.critic.tools` | `["Read","Grep","Glob","Bash","Write"]` | The subagent's tools. The reviewer guard still allows only read-only shell commands and writes only under the run's folder. |
| `roles.<role>.kind`, `roles.<role>.contract` | reviewer and critic: `"subagent"` | Read but not acted on in 0.1.0. |
| `gates` | `{}` | `{ "<name>": ["<command>", …] }`: the commands the implementer must run and report. |
| `guards` | `[]` | Rules on tool calls (below). |
| `limits.maxParallelThreads` | `1` | Busy foreman threads at once in the repo, whichever chat launched them. |
| `limits.maxReviewCycles` | `2` | Review rounds before a cycle waits for you. |
| `limits.serialBuilds` | `true` | Read but not acted on in 0.1.0. |
| `hooks.onRunCreate` | `null` | A command run once when foreman creates a run folder: by argv, no shell, `{{runId}}` replaced, two minutes at most. A non-zero exit stops the launch. |
| `injectHandoff` | `true` | Tell each thread where its run's `handoff.md` and `report.md` are. |
| `notify.toast` | `true` | Toasts on cycle notices. |

A minimal profile:

```json
{
  "roles": { "implementer": { "model": "sonnet", "effort": "high" } },
  "gates": { "node": ["npm test"] }
}
```

### Guards

```json
{
  "guards": [
    { "when": { "tool": "Edit|Write|MultiEdit", "pathGlob": "src/**/*.cs" }, "requireToolCalledBefore": "mcp__gitnexus__impact", "mode": "warn", "reason": "Run the impact check first" },
    { "when": { "tool": "Bash|PowerShell", "commandRegex": "\\bgit(?:\\s+-C\\s+\\S+)*\\s+add\\s+(?:-A|--all|\\.)(?:\\s|$)" }, "mode": "deny", "reason": "Explicit paths, never git add -A" }
  ]
}
```

- `when.tool` is a name or a regex. `pathGlob` is matched against the path relative to the repo, with `/` separators and case-insensitively; `**` spans folders. `commandRegex` is matched against the shell command.
- `requireToolCalledBefore`: the rule applies only when that tool has not been called yet in the session.
- `mode: "warn"` lets the call run and tells both the model and you. `mode: "deny"` refuses the call.
- A path guard on the file tools also catches a shell command that writes a matching path (`sed -i`, `>`, `tee`, `cp`, `Set-Content`…). That match is by spelling, so it is best effort.

> **Guards act in every session that loads foreman, and they fail closed.**
>
> - Installed at user scope, foreman loads in every chat, and the repo's guards act there: your own chats, foreman's threads and any other background session.
> - A call foreman cannot judge (an internal error) is refused when the profile declares guards.
> - A profile with guards that stops parsing (a typo) also refuses calls, until you fix it.
>
> Keep guards few and precise. `/foreman profile` shows the guards in effect.

### Advanced: a full profile

[`profiles/msg.json`](profiles/msg.json) is the profile of a real multi-repo project. It shows:

- a `runsDir` of its own and two submodules;
- per-role skills and notes;
- gates;
- three guards (an impact check before editing a `.cs` file, a change check before `git commit`, and a ban on `git add -A`);
- an `onRunCreate` script that sets up each run's branch and files;
- `injectHandoff: false`, because the repo injects the handoff itself.

[`profiles/default.json`](profiles/default.json) is the defaults written out.

## Models & cost

Defaults, chosen for a Max 5x plan:

| Role | Model | Effort | Why |
|---|---|---|---|
| Planner | `opus` | high | Plans grounded in the code. |
| Implementer N2/N3 | `opus` | high | Raise to `xhigh` per launch if needed: the review loop catches most misses, and the cost rises steeply. |
| Implementer N1 | `sonnet` | high | Small, well-specified changes. |
| Reviewer / critic | `fable` | high | The most capable model. It is read-only and sees a bounded diff, so its runs are short. |
| QA | `sonnet` | medium | Scripted walk-throughs. |

- Coordination itself spends no tokens.
- The pane shows each thread's tokens, read from its transcript.
- `limits.maxParallelThreads: 1` keeps the work serial. `limits.maxReviewCycles: 2` bounds the review rounds.
- A thread that hits a usage limit is marked **Usage limit** and resumed a minute after the reset, by any chat that has foreman loaded.

## How it works

- **Threads** are `claude --bg` sessions started with the role's brief.
  - Their isolation is off by default (`isolation: "none"`).
  - Their environment carries `FOREMAN_THREAD`, so foreman loaded inside a thread only enforces the guards.
  - A message to a thread is `claude stop` (if live), then `claude --bg --resume <session> "<text>"`.
- **The watcher** runs every 30 s in each chat that has foreman loaded. It reads `claude agents --json --all` and the tail of each thread's transcript (`~/.claude/projects/…/<session>.jsonl`) to get the state, the usage, the last line and the `foreman-result` block.
- **Reviewers and critics** are subagents (`foreman:reviewer`, `foreman:critic`), fresh each time and hidden from the model, so only foreman spawns them.
  - A guard refuses their edits, allows a short list of read-only shell commands, and allows writes only under the run's folder.
  - The verdict comes from the file they write.
- **State** is shared between every chat of the repo through `$.store`; one owner per cycle and per review keeps the work from being done twice. Each run's history is in `<runsDir>/<run>/foreman.json`.
- foreman writes nothing in your repo except `runsDir`, the profile (`/foreman init`) and what the threads themselves do.

## Limitations

- Threads, the watcher and cycles run only while your machine is awake and a chat with foreman is open in the repo; they pick up again when one opens.
- The reviewer cannot run tests: it names the gates the implementer must run.
- `--deep` needs the `Workflow` tool, and runs in your chat's own loop, outside the reviewer guard. Treat it as an extra opinion: cycles always use the guarded reviewer.
- The shell-write match of path guards is by spelling, so it is best effort.
- `roles.*.kind`, `roles.*.contract` and `limits.serialBuilds` are read but not acted on in 0.1.0.
- The eval suite (`evals/`) cannot start background threads, because the eval workspace is untrusted. The full NO → apply → OK cycle is covered by `hooks/cycle-e2e.test.ts`.

## Troubleshooting

- **`claude --bg failed (exit 1): … Workspace not trusted`.** Run `claude` once in that folder, interactively, and accept the trust dialog. Background sessions refuse untrusted folders.
- **A thread shows Blocked (dialog open).** It is waiting on a permission dialog, and foreman never answers one for you. Run `/foreman open <thread>`, paste the `claude attach <id>` command into a terminal, and answer the dialog there. Or set the role's `permissionMode` in the profile.
- **Usage limit.** Nothing to do: the thread is resumed a minute after the reset (`/foreman status` says "retries at the reset").
- **Invalid profile.** The pane says `n profile warning(s)`, and `/foreman profile` lists them by key; each wrong key falls back to its default. If the file no longer parses and it declares guards, every tool call is refused until you fix it (see *Guards*).
- **Quotes from PowerShell 5.1.** `claude '/foreman launch free "…"'` typed in Windows PowerShell 5.1 loses the inner double quotes on the way to `claude.exe`. Use single quotes inside (`claude '/foreman launch free ''write a test'''`), or type the command in the chat's prompt box, which has no such problem.
- **A thread disappeared from the pane.** Closed threads are dropped; `claude agents --all` still lists the session, and its run's `foreman.json` keeps its history.

## Contributing

Issues and pull requests are welcome at <https://github.com/andrey342/foreman>. Before a pull request, check that these pass:

```bash
claude plugin validate .
```

```bash
npx tsc -p .
```

```bash
claude plugin test .
```

```bash
node scripts/check-profiles.mjs
```

Also note:

- Every call on `$` lives in `hooks/register.tsx`; `hooks/lib/*` and `hooks/ui/*` are pure.
- Design decisions are in [`docs/DECISIONES.md`](docs/DECISIONES.md).
- To try a change live, run `claude --plugin-dir <this folder>` in a trusted test repo.
- Run the eval suite (`claude plugin eval . --scaffold --trust-plugin`) from Git Bash on Windows.

## License

MIT, see [LICENSE](LICENSE).

---

## En español

**foreman** coordina trabajo largo de Claude Code en hilos en segundo plano (`claude --bg`) desde un solo chat: el implementador trabaja, un revisor fresco de solo lectura dicta `OK`/`NO` y, si es `NO`, el implementador aplica la review, hasta que la parte queda lista o necesita que decidas tú. La coordinación es código, no un modelo: 0 tokens.

- **Instalar:** `claude plugin install foreman --marketplace andrey342/foreman` (scope `user`). Responde `y` si Claude Code pide confiar en el código del plugin. Abre `claude` en un repo de confianza.
- **Empezar:** `/foreman init` (opcional), `/foreman launch implementer "…" --level N1`, `/foreman status`, `/foreman open 1`, y `/foreman` para el panel.
- **Ciclo completo:** `/foreman cycle docs/plan.md --part A`. Revisa con `/foreman review` y `/foreman critic`; `/foreman night on` encadena las partes por la noche.
- **Perfil:** `.claude/foreman.json`. Todas sus claves son opcionales y sin él funciona igual. `claudeExe` y `notifyCommand` van en los ajustes del plugin (`claude plugin configure foreman`), no en el repo. Para `notifyCommand`, usa `powershell.exe -NoProfile -File script.ps1 {{message}}`, nunca `-Command`.
- **Ojo con los guards:** actúan en **todas** las sesiones que cargan foreman (tus chats, sus hilos y cualquier otra) y fallan cerrados: una llamada que no pueden juzgar, o un perfil con guards que ya no se puede leer, se deniega.
- **Problemas frecuentes:**
  - «Workspace not trusted»: abre `claude` una vez en la carpeta y acepta la confianza.
  - Hilo bloqueado por un diálogo: `/foreman open` y respóndelo con `claude attach`.
  - Límite de uso: foreman reanuda el hilo un minuto después del reset.
  - Comillas en PowerShell 5.1: usa comillas simples dentro.

Probado en Claude Code 2.1.296.
