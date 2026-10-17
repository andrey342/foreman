# foreman

**Run a written plan with Claude Code: each part in its own background thread, reviewed until OK, from one chat, with code doing the coordination.**

```text
Fix login                                        [Pause] [Stop]
Waiting for your answer on part B
 ✓ A  Reproduce the bug in a test
 ● B  Fix the handler
 ○ C  Document it

╭ Needs you ─────────────────────────────────────────────────╮
│ Part B asks: keep the old /login route for the mobile app? │
│ [your answer…                                     ] [Send] │
╰────────────────────────────────────────────────────────────╯
foreman decided: passed part B to you (10:42)  [Why]
▸ Details
```

*The foreman pane (`/foreman`), as a terminal draws it. The app draws the same pane in its side panel.*

## Why

Long work on a real repo means several chats at once: one implements, another reviews with fresh eyes, someone answers the questions. Moving between them is the slow part: copying paths, pasting "apply this review", noticing the one that stopped on a dialog.

foreman does that relay for you, from a plan you write:

- Each part of the plan is worked by a **thread**: an ordinary `claude --bg` session on your machine.
- When the thread is done, a **reviewer** checks the part: a fresh, read-only `claude -p` process. On NO, the thread is told to apply the review; up to 3 rounds.
- When a thread stops with a question, or the rounds run out, a **supervisor** (another short `claude -p` process) answers from the plan, replans, asks for another review, or passes it to you. A fixed list of things always comes to you: credentials, writes outside the repo, scope, delivery, deletions, permissions, spending.
- The loop that joins them is code: a 30-second watcher and a fixed state machine. A model runs only when a thread, a reviewer or the supervisor has work to do.
- At the end foreman delivers the work the way the repo's rules ask (a branch, a pull request or a merge) and writes a report.

Everything runs locally, while your machine is awake.

## Install

Tested with the Claude desktop app 2.1.295 and the Claude Code CLI 2.1.296, on Windows 10.

**From a chat** (the app or a terminal): paste this sentence.

> Install the foreman plugin from the marketplace andrey342/foreman.

Claude runs `claude plugin marketplace add andrey342/foreman` and `claude plugin install foreman@foreman`, at **user** scope, so foreman is there in every repo. For one repo only, add "at project scope": both commands then take `--scope project`, and the plugin is declared in that repo's `.claude/settings.json`.

Then **open a new session**: a plugin loads when a session starts.

**From a terminal**, the same two commands:

```bash
claude plugin marketplace add andrey342/foreman
```

```bash
claude plugin install foreman@foreman
```

**To uninstall**, say "Uninstall the foreman plugin" (add "at project scope" in a repo where it was installed that way), or run the two commands with the scope you installed it at:

```bash
claude plugin uninstall foreman@foreman --scope user
```

```bash
claude plugin marketplace remove foreman --scope user
```

With `--scope project` instead, from inside the repo, for a project install.

foreman runs function hooks: it starts `claude` processes, reads their transcripts and writes its files under `.git/foreman/`. If Claude Code asks you to trust the plugin's code, that is what it is asking about.

## From the app, step by step

1. **Install** it, as above, and open a new session.
2. **Open the repo.** Start a session in the project's folder, in **auto** permission mode. foreman starts with your first message in the session.
3. **Set it up (optional).** `/foreman setup`, or say "foreman, set up this repo". It says what it finds and asks at most three things (see [Setup](#setup)).
4. **Write the plan.** Write it with Claude in the chat and save it as a file, for example from the template (see [The plan](#the-plan)).
5. **Run it.** Say "foreman, run docs/plans/my-plan.md". A dialog shows the parts, where they will work and how the work will be delivered: **Run them**. The pane opens by itself.
6. **Follow it.** The pane shows one status line, which says what is happening or what waits for you, and the parts: ✓ ready, ● at work, ○ to do. **Pause** stops before the next part: the line reads "Paused · part A finishes first" while the part at work finishes, then "Paused"; **Continue** goes on. A new worktree first shows "Preparing the worktree (npm ci)".
7. **When something needs you**, the status line says what waits ("Waiting for your answer on part B", "Waiting for you before part C") and a **Needs you** box says what to do: type the answer and **Send**; **Open its chat** for a permission dialog in the thread; **Continue** where the plan asks for a pause. With push on (see [Notices](#notices)), your phone hears about it too.
8. **Reviews and decisions** happen on their own. The pane shows one line per supervisor decision (**Why** shows its reason), and the review's findings only when it says NO (**Show**).
9. **Delivery.** When the last part is ready, foreman delivers the work the way the repo asks: the branch as it is, a pull request, or a merge.
10. **Report.** The pane says **Done ✓**, **Show report** opens `report.md`, and the chat gets a short summary.
11. **Reopening.** Closing the app does not stop the threads: they are background sessions. When you open the session again, **send any message** (even "hi"): foreman picks up from there. `/foreman` shows in the command autocomplete after that first message too.

## Permissions

- **The coordinator** (your chat) runs in **auto** mode, and so do the **threads** (`--permission-mode auto`). A thread that still hits a permission dialog shows in **Needs you** with **Open its chat**: foreman never answers a dialog for you.
- **Threads inherit the repo's `permissions.allow`**, plus a rule for each gate and foreman's own short list, `FOREMAN_ALLOW`:

  ```text
  Read
  Grep
  Glob
  Bash(git status:*)
  Bash(git diff:*)
  Bash(git log:*)
  Bash(git show:*)
  Bash(git add:*)
  Bash(git commit:*)
  Bash(git rev-parse:*)
  ```

- **The reviewer and the supervisor** run in `dontAsk` mode: whatever is not allowed is refused, with no dialog. The reviewer gets read-only tools and the gates; **the repo's `permissions.allow` applies there too**, since the process runs in the repo with its settings. A gate the reviewer's permissions refuse leaves the round as "could not run", which does not count as a round.

## Notices

foreman shows every notice in the pane and the status line, and as a toast. A question, a dialog, a failure and a finished plan are also sent as a **push notification**, which the app delivers only when push is on and you are away from the session.

To turn push on: type `/config` in a chat of the app and switch on **Push when Claude decides**: foreman's notices are pushes the session sends itself. **Push when actions required** is the app's own push for a session that waits on you. These are your own settings, for every session: foreman never changes them.

## The plan

A plan is a Markdown file. foreman reads its parts from the headings:

````markdown
# Fix login

The button does nothing on Safari.

## Part A — Reproduce the bug in a test

What to do, in plain words: the files, the behaviour, what is already decided.

**Acceptance**
- `npm test` fails on the new test before the fix.

## Part B — Fix the handler

**Acceptance**
- `npm test` passes.

## Pause before part C

## Part C — Document it
````

- **Parts** are headings named like "Part A", "Parte B", "Phase 2", "Step 3" (in several languages). A plan with no such headings is one part.
- **Acceptance** criteria are the list after a heading, a bold line or a label ending in a colon that says "Acceptance", "Criteria", "Done when" or "Verification". The reviewer checks each one.
- **A pause** is a heading or a line that starts with "Pause", "Stop here" or "Human decision": the plan waits there, and the pane shows **Continue**.
- What the plan already decides is what the supervisor answers from. Anything it leaves open comes to you.

[`docs/plan-template.md`](docs/plan-template.md) is the template; `/foreman setup` offers to add it to a repo as `docs/plans/TEMPLATE.md`.

## Setup

`/foreman setup` (or "foreman, set up this repo") reads the repo and says what it finds:

- the stack, the gates (`npm test`, `dotnet test`…) and the install command for a fresh worktree;
- the repo's own rules (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/rules`, skills, agents, hooks, `.mcp.json`);
- submodules and compose files;
- the branch prefix the rules ask for (`fix/`, `feat/`…);
- how the rules want work delivered.

Then it asks at most three things: the delivery (only when the rules ask for pull requests), where a plan works (only with submodules or compose files), and whether to write. It writes `.claude/foreman.json` with **only the keys that differ from the defaults**, and offers the plan template. Without a profile foreman works the same: `go` makes the same reading in memory.

- `/foreman setup --show` shows what it finds and the profile in effect, with its warnings, and writes nothing.
- `/foreman setup --claude-exe <path>` sets the `claude` executable foreman runs, for every session (empty, `""`, goes back to the plugin setting, else `claude` from PATH).

## Where the work happens, and how it is delivered

**Isolation** (`isolation` in the profile):

| Value | What a plan gets |
|---|---|
| `worktree` (default) | Its own worktree, `.claude/worktrees/foreman-<plan>`, on a new branch `<prefix><plan>` from your current branch. The install command (`npm ci`…) runs there first. Your checkout is not touched. `/.claude/worktrees/` is added to `.git/info/exclude`. |
| `branch` | A new branch in your checkout (`git switch -c`), which must be clean. What `go` proposes in a repo with submodules or compose files. |
| `none` | Your checkout as it is, on its current branch. Nothing is delivered. |

**Delivery** (`delivery.mode`), when the last part is ready:

| Value | What foreman does |
|---|---|
| `branch` (default) | Leaves the branch as it is, with `report.md`. Nothing is published. |
| `pr` | `git push -u origin <branch>`, then `gh pr create` with the report as its body. Never merges. |
| `merge` | `git merge --no-ff <branch>` into your checkout's branch, locally, when your checkout is clean and on the plan's base branch. A merge that does not go clean is aborted: your checkout stays as it was. No push. |
| `none` | Nothing. |

- A `pr` with no `origin` remote, or with `gh` missing or not signed in, falls back to `branch`, and `go` says so. So does a repo whose rules ask a person before publishing.
- A step that fails leaves **Done, not delivered** in the pane, with **Retry delivery**. foreman never builds `--force`, `--delete` or `--mirror`.
- A delivered plan's worktree is removed; its branch stays.

**A stopped plan keeps its work.** After **Stop**, or a delivery that failed, the branch and the worktree stay; the pane's Details names them. To remove them yourself, from the repo's main folder (or ask Claude in the chat):

```bash
git worktree remove .claude/worktrees/foreman-<plan>
```

```bash
git branch -D <branch>
```

`git branch -D` deletes the branch even if its commits were never merged: keep it if you want the work.

## Commands and tools

| Command | What it does |
|---|---|
| `/foreman` | Open or close the pane. |
| `/foreman go <plan.md> [--parts A,B] [--model m] [--yes]` | Run the plan's parts in order, each in its own thread, reviewed until OK. `--parts` runs only the parts named, and `--yes` all of them, without the dialog. |
| `/foreman setup [--show] [--claude-exe <path>]` | See [Setup](#setup). |
| `/foreman status` | Plans, parts, threads and reviews. |
| `/foreman pause [plan]` / `resume [plan]` | Stop chaining the parts, or go on (also past a pause the plan asks for). |
| `/foreman stop [plan]` | Stop the plan and its thread. The branch, the worktree and the work stay. |
| `/foreman review [--part A] [--base <ref>] [--run <id>]` | A fresh read-only review of `<base>..HEAD`. |
| `/foreman help` | The command list. |

In the chat, Claude has five tools for the same things, so plain sentences work: "foreman, run docs/plans/x.md" (`foreman_go`), "foreman, how is it going?" (`foreman_status`), "foreman, reply: keep the old route" (`foreman_reply`), "foreman, open it" (`foreman_open`), "foreman, set up this repo" (`foreman_setup`).

The 0.1 commands (`launch`, `tell`, `open`, `log`, `close`, `init`, `profile`, `cycle`, `night`, `critic`, `next`) are gone; during 0.2.x each one answers with what replaces it.

## Files

foreman writes its files under `.git/foreman/<plan>/`, outside the work tree, so `git status` stays clean:

- `foreman.json`: the run's history (transitions, reviews, decisions, button presses, notices);
- `brief-<part>.md`: what each thread was asked;
- `review-<part>-r<n>.md`: each review, its first line `Verdict: OK|NO|BLOCKED`;
- `decisions.jsonl`: each supervisor decision, with its reason;
- `progress.md` and `report.md`.

A repo can name another folder with `runsDir`. In the work tree foreman writes only the profile and the template (from `setup`), and the plan's worktree.

## Profile reference

`.claude/foreman.json`, version 2. **Every key is optional.** A wrong key gets a warning and its default, and never blocks a command; `/foreman setup --show` lists the warnings. A 0.1 profile still works: each retired key gets a warning.

| Key | Default | Meaning |
|---|---|---|
| `version` | `2` | Profile format. |
| `isolation` | `"worktree"` | `"worktree"`, `"branch"` or `"none"` (above). |
| `delivery.mode` | `"branch"` | `"branch"`, `"pr"`, `"merge"` or `"none"` (above). |
| `delivery.handoffToApp` | `false` | Ask the chat to have the app watch the pull request. |
| `roles.implementer.model` / `.effort` | `opus` / `high` | The threads. |
| `roles.reviewer.model` / `.effort` | `fable` / `high` | The reviewer process. |
| `roles.supervisor.model` / `.effort` | `opus` / `high` | The supervisor process. |
| `roles.<role>.skills` | `[]` | Skills the brief asks the role to use. One the session does not list is left out, with a note. |
| `roles.<role>.extra` | `""` | Repo notes appended to the role's brief. |
| `gates` | found by `setup` | `{ "<name>": ["<command>", …] }`: the commands the thread must run and report, and the reviewer runs. |
| `guards` | `{ "scope": "threads", "rules": [] }` | Rules on tool calls (below). |
| `limits.maxParallelThreads` | `1` | Busy foreman threads at once in the repo. |
| `limits.reviewRounds` | `3` | Review rounds per part before the supervisor replans (once, 3 more rounds) or passes it to you. |
| `notify.toast` | `true` | Toasts. |
| `notify.quiet` | `false` | Hold back the toasts of routine moves (a part started or ready). |
| `runsDir` | under `.git/foreman` | A folder of the repo for foreman's files instead. |

Retired in 0.2, with a warning: `mode` (one mode: parts chain by themselves), `repos`, `hooks`, `injectHandoff`, `roles.*.kind`, `.contract`, `.byLevel`, `.tools`, `limits.serialBuilds`; `limits.maxReviewCycles` is read as `reviewRounds`. `claudeExe` and `notify.command` run programs nobody typed, so a repo cannot set them.

### Guards

```json
{
  "guards": {
    "scope": "threads",
    "rules": [
      { "when": { "tool": "Bash|PowerShell", "commandRegex": "\\bgit(?:\\s+-C\\s+\\S+)*\\s+add\\s+(?:-A|--all|\\.)(?:\\s|$)" }, "mode": "deny", "reason": "Explicit paths, never git add -A" }
    ]
  }
}
```

- `scope: "threads"` (the default) applies the rules in foreman's threads only; `"everywhere"` in every session that loads foreman, your own chats included.
- `when.tool` is a name or a regex; `pathGlob` is matched against the path relative to the repo (`/` separators, `**` spans folders); `commandRegex` against the shell command. `requireToolCalledBefore` applies the rule only until that tool has been called in the session.
- `mode: "warn"` lets the call run and says so; `mode: "deny"` refuses it. Guards fail closed: a call foreman cannot judge is refused.
- In a plan's worktree the guards come from your main checkout's profile, committed or not.

## Limitations

- Threads, the watcher and the delivery run only while your machine is awake and a session with foreman is open in the repo; they pick up again when one opens (send a message).
- **Open its chat** is verified on Windows; on macOS and Linux it is untested.
- The app's phone view draws no text field in the pane: answer from the chat there ("foreman, reply: …").
- A plugin setting cannot be changed from a chat (`/config` does not list it), hence `/foreman setup --claude-exe`.
- The eval suite (`evals/review`) checks how a review starts and what is recorded; the reviewer's own verdict is covered by the tests and the live runs, since the eval session ends before the reviewer process answers.

## Troubleshooting

- **`claude --bg failed … Workspace not trusted`.** Open the folder once in the app (or run `claude` there) and accept the trust dialog. Background sessions refuse untrusted folders, and a plan's worktree needs the trust too.
- **A part waits on "a permission in its own chat".** **Open its chat** and answer the dialog there, or allow the command in the repo's `permissions.allow`.
- **Usage limit.** Nothing to do: the thread goes on a minute after the reset.
- **The install command fails in the worktree.** The plan stops with the command's last lines; fix it, then run the plan again.
- **Done, not delivered.** The pane says which step failed and why; fix it (sign in to `gh`, clean your checkout) and press **Retry delivery**.
- **Profile warnings.** `/foreman setup --show` lists them by key; each wrong key falls back to its default.
- **`/foreman` arrives as `C:/Program Files/Git/foreman`.** Git Bash rewrites a leading `/` when you run `claude -p "/foreman …"` from it. Prefix `MSYS_NO_PATHCONV=1`, or type it in the chat.

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

```bash
node scripts/check-prompts.mjs
```

- Every call on `$` lives in `hooks/register.tsx`; `hooks/lib/*` and `hooks/ui/*` are pure.
- Design decisions are in [`docs/DECISIONES.md`](docs/DECISIONES.md).
- To try a change live, run `claude --plugin-dir <this folder>` in a trusted test repo.
- Installed from this folder as a marketplace (`claude plugin marketplace add <this folder>`), the plugin runs from a copy in `~/.claude/plugins/cache/foreman/foreman/<version>/`. With the version unchanged, neither a new session nor `claude plugin update` refreshes that copy. After a change, reinstall it in one repo that has it (`claude plugin uninstall foreman@foreman --scope project`, then `claude plugin install foreman@foreman --scope project`): every install of that version shares the copy. Then start a new session.
- The eval suite: `claude plugin eval . --scaffold --trust-plugin`, from Git Bash on Windows.

## License

MIT, see [LICENSE](LICENSE).

---

## En español

**foreman** ejecuta un plan escrito con Claude Code: cada parte en su propio hilo en segundo plano, revisada hasta OK, desde un solo chat. La coordinación es código; un supervisor (`claude -p`) solo decide cuando un hilo se para, y lo que no está en el plan te llega a ti.

- **Instalar:** pega en un chat «Install the foreman plugin from the marketplace andrey342/foreman» y abre una sesión nueva. Para un solo repo, añade «at project scope». Para quitarlo: «Uninstall the foreman plugin».
- **Usar:** sesión en modo `auto` en la carpeta del repo; «foreman, set up this repo» (opcional); escribe el plan; «foreman, run docs/plans/mi-plan.md» y **Run them**. El panel muestra el estado, las partes y «Needs you» cuando algo te necesita.
- **Al reabrir** la sesión, envía cualquier mensaje para que foreman retome.
- **Push al móvil:** `/config` → «Push when Claude decides».
- **Entrega:** rama (por defecto), PR o merge, según las reglas del repo; al final, `report.md`.

Probado con la app 2.1.295 y la CLI 2.1.296, en Windows 10.
