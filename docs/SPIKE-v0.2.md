# Spike v0.2 (Fase 0)

Fecha: 2026-10-16. Builds: CLI 2.1.296 (`claude --version` → `2.1.296 (Claude Code)`; `$.session.version()` en `-p` → `{"version":"2.1.296","base":"2.1.296","builtAt":"2026-10-09T01:31:52Z"}`) y **la app de escritorio corre su propio Claude Code 2.1.295** (`$.session.version()` en una sesión de la app → `{"version":"2.1.295","base":"2.1.295","builtAt":"2026-10-08T16:50:59Z"}`). Implementador: Opus 5.5. Plan: `docs/plans/plan-foreman-v0.2.md` §9 Fase 0.

Estado del documento: **completo**. Todos los spikes ejecutados (F0-1 a F0-10). Lo único no verificado se dice en su sitio: `stop_session` por `$.mcp.call` (no hubo sesión creada por el plugin a la que pararla) y la vía (c) de F0-1 en un turno abierto por `$.prompt.submit`. La tabla de decisión está en §9.

Sesiones de escritorio usadas (todas en `foreman-lab`, abiertas por el usuario): ronda 1 `0096aec5-1733-442b-ba0a-d8013c97c23d` («Hola», `local_3906b776-…` en la app); ronda 2 `1dbed825-2c1e-42ad-965f-cfe9fa04681c` («Hola», `local_7da4ce7a-…`); dos intermedias que no dispararon el flujo por un fallo mío (§F0-2) y que el usuario borró (`767e16db…`, `bf6078cf…`). Resultados en `foreman-lab/.git/foreman-spike/results-desktop1.json` (ronda 1) y `results.json` (ronda 2), más un `log-<sessionId>.json` por sesión.

Cómo se carga el mod en una sesión de escritorio (respuesta del revisor a la duda, 2026-10-16): instalación en scope `project` de `foreman-lab` desde la carpeta del spike (§0.3); descartados `~/.claude/dev-mods` y `CLAUDE_CODE_PLUGIN_DIRS` porque escriben en el perfil del usuario.

Todas las órdenes se ejecutaron desde Git Bash con `MSYS_NO_PATHCONV=1` (si no, Git Bash reescribe el `/` inicial de `/fspike`, ver SPIKE.md v0.1).

---

## 0. Preparación

### 0.1 `foreman-lab`

```bash
gh auth status
#   ✓ Logged in to github.com account andrey342 (keyring)
#   - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
gh repo view andrey342/foreman-lab
#   GraphQL: Could not resolve to a Repository with the name 'andrey342/foreman-lab'. (repository)
cd C:/Users/you/source/repos
gh repo create andrey342/foreman-lab --private --description "Disposable test repo for foreman v0.2 (deleted after Phase 5)" --clone
#   https://github.com/andrey342/foreman-lab
```

Siembra (rama `main`, commit `35e557c chore: seed foreman-lab (stats module with a known bug, rules, skill, hook)`, empujado a `origin/main`; `gh repo view` → `{"defaultBranchRef":{"name":"main"},"url":"https://github.com/andrey342/foreman-lab","visibility":"PRIVATE"}`):

| Archivo | Para qué |
|---|---|
| `package.json` (`"test": "node --test"`), `package-lock.json` | gate `npm test`; el lockfile permite `npm ci` (F4-1) |
| `src/stats.js`, `test/stats.test.js` | `sum`, `mean`, `median`; **bug conocido**: `median` de una lista de longitud par devuelve el valor central superior; los 4 tests no lo cubren (`npm test` → `ℹ pass 4 ℹ fail 0`) |
| `CLAUDE.md` | reglas propias: rama `fix/<slug>`/`feat/<slug>` por tarea, `npm test` antes de cada commit, entrega por PR a `main` con `gh pr create`, nunca merge/force/borrar ramas, mensajes `<type>: <summary>` |
| `.claude/skills/lab-conventions/SKILL.md` | skill propia (convenciones de código y tests) |
| `.claude/settings.json` + `.claude/hooks/session-start.mjs` | hook propio `SessionStart` (`node .claude/hooks/session-start.mjs`, solo imprime un recordatorio) |

Nota para la Fase 5: el token de `gh` no tiene el scope `delete_repo`; `gh repo delete` exigirá `gh auth refresh -s delete_repo` (un inicio de sesión: regla de parada).

### 0.2 El mod de spike (`spike/v02`)

Plugin `foreman-spike` 0.2.0 (`spike/v02/.claude-plugin/plugin.json`, con `marketplace.json` propio para poder instalarlo en scope `project`), un solo módulo `spike/v02/hooks/register.tsx`:

- `session.start`: registra el comando `/fspike <sonda> [arg]`, el agente `foreman-spike:reviewer` (Read/Write/Bash, haiku, `permissionMode: auto`) y dos herramientas: `mcp__foreman-spike__status` (F0-8) y `mcp__foreman-spike__spike` (`{ probe, arg }`, para que el modelo de una sesión de escritorio ejecute las sondas). Si el `$.store` tiene `v02:armed`, abre el panel y lanza `$.ui.ask` al arrancar (F0-7), una sola vez.
- `session.attach`: anota cada superficie que se conecta.
- Sondas: `env`, `tools`, `notify`, `push` (`$.tool.call` de `PushNotification`), `ask`, `askcmd` (`$.command.run` → `ask` dentro de `command.run`), `pane`, `panes`, `start` (F0-1: `$.tool.call` y `$.mcp.call` de `start_session`), `send` (F0-3), `gitdir`, `review` / `reviewcwd` / `agent` (F0-10), `arm`/`disarm`, `dump`.
- Panel `fspike`: `Markdown`, `Button` (cuenta pulsaciones), `Input` (onSubmit), `Select` (onSelect); cada interacción se registra con su `e.surface`.
- Registro: cada sonda escribe en `$.store` (`v02:log:<sessionId>`) y en `<git-common-dir>/foreman-spike/log-<sessionId>.json` (que es además una prueba de F0-10: el plugin escribe bajo `.git/` con `$.fs.write`).

Gates del mod:

```bash
claude plugin validate spike/v02
#   ❯ ./register.tsx hooks: session.start, session.attach, command.run{command=fspike}, tool.call{tool=mcp__foreman-spike__status}, tool.call{tool=mcp__foreman-spike__spike}, turn.complete, ui.render{component=Pane, requestId=fspike}
#   ✔ Validation passed with warnings        (warning: no author)
npx tsc -p <scratchpad>/tsconfig.spike.json   # extends ./tsconfig.json; include .claude-plugin/types + spike/v02/{hooks,types}
#   (sin salida) exit 0
claude plugin test spike/v02
#   (pass) the pane takes a press, a typed reply and a pick on terminal and desktop
#    1 pass  0 fail
```

Al cerrar la fase el test se renombró a `spike/v02/hooks/pane.spike.tsx` (como `spike/mod` en la v0.1): `claude plugin test .` desde la raíz recorre todo `*.test.tsx` del repo y lo ejecutaba bajo el plugin `foreman` (`HooksError: $.ui.mount: no implementation for ui.render`).

Primer intento de validación: `✘ … $ itself is passed as an argument (bound, passed, spread, returned or read)` por leer `$.tool.call` como valor para tiparlo; se resolvió con `$.tool.call({ tool: 'PushNotification', … } as never)`. Lo mismo valdrá en `register.tsx` de foreman: nunca leer un método de `$` como valor.

### 0.3 El mod en `foreman-lab` (scope `project`) y el flujo armado

Worktree de prueba en `foreman-lab` (sirve a la vez para F0-6 y para repetir F0-10b desde escritorio):

```bash
cd C:/repos/foreman-lab
git worktree add -b foreman/spike-x .claude/worktrees/foreman-spike-x HEAD
#   Preparing worktree (new branch 'foreman/spike-x')
#   HEAD is now at 35e557c chore: seed foreman-lab (stats module with a known bug, rules, skill, hook)
git status --short
#   ?? .claude/worktrees/
printf '\n# foreman v0.2 spike\n.claude/worktrees/\n' >> .git/info/exclude
git status --short
#   (vacío)
```

Es la regla de D-71: en un repo que no ignora `.claude/` (aquí `.claude/` está versionado: settings, skill y hook), el worktree del plan aparece como no rastreado hasta que su ruta va a `.git/info/exclude`; con la línea añadida, `git status` queda limpio.

Instalación (desde `foreman-lab`):

```bash
claude plugin marketplace add 'C:\repos\foreman\spike\v02' --scope project
#   Adding marketplace…✔ Successfully added marketplace: foreman-spike (declared in project settings)
claude plugin install foreman-spike@foreman-spike --scope project
#   Installing plugin "foreman-spike@foreman-spike"...✔ Successfully installed plugin: foreman-spike@foreman-spike (scope: project)
claude plugin list
#     ❯ foreman-spike@foreman-spike
#       Version: 0.2.0
#       Read from: C:\repos\foreman\spike\v02
#       Scope: project
#       Status: ✔ enabled
git status --short
#    M .claude/settings.json      (añade extraKnownMarketplaces.foreman-spike {source: directory, path: …\spike\v02} y enabledPlugins["foreman-spike@foreman-spike"]: true)
```

El plugin se lee de la carpeta del spike (no de una copia): cada sesión nueva en `foreman-lab` carga el código actual.

Flujo armado: `flow` corre desde `session.start` (sin esperar: `session.start` no se queda esperando a la persona) cuando `.git/foreman-spike/armed` dice `armed`; la sesión que lo consume escribe `used by <sessionId>`. Pasos: `env`, `tools`, `notify`, `push`, `mcpCall` (`$.mcp.call("ccd_session", "list_start_targets")`, de solo lectura), `sendToImplementer` (F0-3 a esta sesión por `sessionId`), `ownRow` (F0-5), `spawnCwd` y `spawnEnterWorktree` (F0-10b desde escritorio), espera a que se conecte una superficie, `pane`, `askFromSessionStart`, `askFromCommandRun` (`$.command.run` → `/fspike ask`), `startSession` (F0-1 a: `$.tool.call` de `mcp__ccd_session__start_session` con título `foreman:spike:test`, `cwd` foreman-lab, `permission_mode: auto`), `startedRow` + `sendToStarted` (F0-3 a la sesión creada), `desktopCli` (`claude --desktop --name foreman:spike:b "Reply with PONG"`) y, 2 minutos después, `latePush`/`lateNotify` (M1 con la persona fuera). Todo va a `.git/foreman-spike/results.json`.

Prueba headless del flujo en `foreman-lab` (`claude -p "/fspike flow headless"`, que salta la espera de superficie, el `command.run` encolado y `claude --desktop`), guardada como `results-headless.json`:

```text
tools: {"count":71,"startSession":false,"stopSession":false,"pushNotification":true,"ccd":[],"matches":["EnterWorktree","SendMessage","mcp__foreman-spike__spike","mcp__foreman-spike__status"]}
notify: {"isSent":false,"reason":"no-surface"}
push: {"result":{…,"pushSent":false,"localSent":false,"disabledReason":"user_present",…}}
mcpCall: {"error":"foreman-spike: $.mcp.call: no connected MCP tool \"list_start_targets\" on a server named \"ccd_session\""}
sendToImplementer: {"isDelivered":true}
ownRow: [{"pid":143556,"cwd":"C:\\repos\\foreman-lab","kind":"interactive","startedAt":1792159857188,"sessionId":"f08b7d3d-401b-4e1c-97f1-974f05471337","name":"foreman-lab-9c","status":"busy"}]
pane: {"opened":{"isPlaced":true},"panes":[{"id":"fspike","title":"foreman spike v0.2","isShown":true,"isFocused":false,"isPlaced":true}]}
askFromSessionStart: {"error":"foreman-spike: $.tool.call: no tool named \"AskUserQuestion\" in this session"}
startSession: {"error":"foreman-spike: $.tool.call: no tool named \"mcp__ccd_session__start_session\" in this session"}
```

Dos datos nuevos: una sesión `claude -p` aparece en `claude agents --json --all` como fila **`interactive`** con un `name` generado (`foreman-lab-9c`) y `status: busy`; y `$.mcp.call` no ve un servidor `ccd_session` desde la CLI (se repite en escritorio).

---

## F0-7 · Avisos y diálogo (parte sin superficie)

Sesión `claude -p` (sin superficie: `surfaces: []`, `surface: null`, `isInteractive: false` en `session.start`):

```bash
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike tools"
#   foreman-spike: tools: {"count":71,"ccd":[],"matches":["PushNotification","SendMessage","mcp__foreman-spike__spike","mcp__foreman-spike__status"]}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike notify"
#   foreman-spike: notify: {"isSent":false,"reason":"no-surface"}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike push"
#   foreman-spike: push: {"result":{"message":"foreman-spike: PushNotification probe (F0-7, command.run (origin sdk))","pushSent":false,"localSent":false,"disabledReason":"user_present","sentAt":"2026-10-16T13:56:53.134Z"},"text":"Not sent — this terminal is active, so your output here already reaches the user; a separate notification would be redundant."}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike ask"
#   foreman-spike: ask: {"error":"foreman-spike: $.tool.call: no tool named \"AskUserQuestion\" in this session"}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike panes"
#   foreman-spike: panes: []
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike pane"
#   foreman-spike: pane: {"opened":{"isPlaced":true},"panes":[{"id":"fspike","title":"foreman spike v0.2","isShown":true,"isFocused":false,"isPlaced":true}]}
```

Lectura:

- `$.ui.notify` → `no-surface` sin terminal, como dice el `.d.ts` (2456-2471). Esperado.
- **`PushNotification` está en `$.tool.list()` y el plugin la puede llamar con `$.tool.call`** (resultado con `pushSent`, `localSent`, `disabledReason`). En `-p` no envía nada (`user_present`). Falta ver qué hace en una sesión de escritorio con el usuario fuera (parte de escritorio de F0-7).
- `$.ui.ask` en `-p` rechaza (`no tool named "AskUserQuestion"`), como dice el `.d.ts` (2427).
- `isPlaced: true` en `-p` no prueba nada («a -p run places all», `.d.ts` 2493). F0-2 necesita una sesión de escritorio.
- En una sesión de la CLI no hay ninguna herramienta `mcp__ccd_*` (`"ccd":[]`): `start_session` y compañía solo pueden existir en sesiones de la app (F0-1 se prueba allí).

Pendiente (escritorio): `$.ui.notify`, `PushNotification` con el usuario fuera, `$.ui.ask` desde `session.start` y desde `command.run`.

---

## F0-8 · Herramienta del plugin

Intento 1 (herramienta registrada sin `isDeferred`):

```bash
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' --model haiku --output-format json "foreman, ¿cómo va?"
#   session_id b94de275-a0a9-4e3d-900f-8f424fa75207, num_turns 3, permission_denials []
#   result: "Hola. Foreman está bien encaminado, pero la versión 0.2 aún no ha empezado a implementarse. …" (respuesta a partir de git y docs)
grep -o '"type":"tool_use","id":"[^"]*","name":"[^"]*"' ~/.claude/projects/C--repos-foreman/b94de275-a0a9-4e3d-900f-8f424fa75207.jsonl
#   "type":"tool_use","id":"toolu_01LuTfSH4c1Mq2scWWVJjxUs","name":"Bash"
#   "type":"tool_use","id":"toolu_01LnMtwHo6etBiCK7EEdfUFw","name":"Bash"
```

El modelo no llamó a la herramienta: sin `isDeferred`, una herramienta de plugin espera detrás de ToolSearch como las de un servidor MCP (`.d.ts`, `ToolSpec.isDeferred`: «Left out, the engine's rule places it: behind ToolSearch, as it places an MCP server's tool»), y el transcript solo la nombra en el aviso de herramientas diferidas.

Intento 2, con `isDeferred: false` en `$.tool.register`:

```bash
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' --model haiku --output-format json "foreman, ¿cómo va?"
#   haiku {"session_id":"7e92f80b-a6f0-4671-b5c9-af35eb393c41","num_turns":2,"permission_denials":[],"cost":0.0092,"result":"Foreman no tiene ningún plan en marcha en este repo: 0 threads y 0 reviews. …"}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' --model sonnet --output-format json "foreman, ¿cómo va?"
#   sonnet {"session_id":"fe95b682-1e1d-469a-97be-b8a1fda09ab0","num_turns":2,"permission_denials":[],"cost":0.1768,"result":"Ahora mismo foreman no tiene nada en marcha en este repo: no hay ningún plan ejecutándose, hay 0 hilos y 0 revisiones. …"}
```

Transcripts (`~/.claude/projects/C--repos-foreman/<id>.jsonl`):

```text
== 7e92f80b-a6f0-4671-b5c9-af35eb393c41.jsonl
"type":"tool_use","id":"toolu_01WTu1mwHWYDGNTopCYEoKf6","name":"mcp__foreman-spike__status"
"tool_use_id":"toolu_01WTu1mwHWYDGNTopCYEoKf6","type":"tool_result","content":"foreman (spike): no plan is running in this repo; 0 threads, 0 reviews."
== fe95b682-1e1d-469a-97be-b8a1fda09ab0.jsonl
"type":"tool_use","id":"toolu_01QwgBtMUWetc3KddtrRvjJ1","name":"mcp__foreman-spike__status"
"tool_use_id":"toolu_01QwgBtMUWetc3KddtrRvjJ1","type":"tool_result","content":"foreman (spike): no plan is running in this repo; 0 threads, 0 reviews."
```

**F0-8 cumplido** (fila `tool_use` de la herramienta del plugin en el transcript, sin diálogo de permisos en `-p`). El nombre es `mcp__<plugin>__<name>`: con el plugin `foreman` será `mcp__foreman__status`. Implicación para la Fase 2 (M2): las cinco herramientas `foreman_*` se registran con `isDeferred: false` (esquemas pequeños) para que el modelo las tenga a un paso.

---

## F0-10 · Escritura bajo `.git/`

Worktree de prueba en este repo (`.claude/` está en el `.gitignore` de foreman, así que no aparece en `git status`; en un repo cualquiera D-71 añade la ruta a `.git/info/exclude`):

```bash
git worktree add -b foreman/spike-x .claude/worktrees/foreman-spike-x HEAD
#   Preparing worktree (new branch 'foreman/spike-x')
#   HEAD is now at 8a47838 Phase 6 final review
git rev-parse --path-format=absolute --git-common-dir --git-dir --show-toplevel            # árbol principal
#   C:/repos/foreman/.git
#   C:/repos/foreman/.git
#   C:/repos/foreman
git -C .claude/worktrees/foreman-spike-x rev-parse --path-format=absolute --git-common-dir --git-dir --show-toplevel
#   C:/repos/foreman/.git
#   C:/repos/foreman/.git/worktrees/foreman-spike-x
#   C:/repos/foreman/.claude/worktrees/foreman-spike-x
```

`--git-common-dir` da la misma ruta absoluta desde los dos sitios (con `/`; D-70 la normaliza a los separadores del sistema).

**Subagente revisor** (`$.agent.spawn` de `foreman-spike:reviewer`, `permissionMode: auto`), desde el árbol principal y con `cwd` en el worktree:

```bash
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike review"
#   foreman-spike: review: {"target":"C:/repos/foreman/.git/foreman/spike-x/review-x-main.md","spawn":{"model":"claude-haiku-5-5","agentId":"a2c3b0b5f93765970"}}
#   log: {"probe":"subagent.answer","agentId":"a2c3b0b5f93765970","answer":"DONE. The file was written at `C:/repos/foreman/.git/foreman/spike-x/review-x-main.md` …"}
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike review C:/repos/foreman/.claude/worktrees/foreman-spike-x"
#   foreman-spike: review: {"target":"C:/repos/foreman/.git/foreman/spike-x/review-x-worktree.md","spawn":{"model":"claude-haiku-5-5","agentId":"add64e77bb87895cd"}}
#   log: {"probe":"subagent.answer","agentId":"add64e77bb87895cd","answer":"DONE. The file was written at `C:/repos/foreman/.git/foreman/spike-x/review-x-worktree.md` …"}
```

**Hilo** `claude --bg` lanzado dentro del worktree (`bgIsolation: none`):

```bash
cd C:/repos/foreman/.claude/worktrees/foreman-spike-x
claude --bg --name "foreman:spike-f010" --model haiku --effort low --permission-mode auto --settings '{"worktree":{"bgIsolation":"none"}}' -p '…'
#   --bg and --print conflict: --print never starts the interactive session that `claude agents` attaches to, so the job would be unattachable. The prompt is the positional — drop --print: `claude --bg '<task>'`.
claude --bg --name "foreman:spike-f010" --model haiku --effort low --permission-mode auto --settings '{"worktree":{"bgIsolation":"none"}}' 'Do these steps with your tools, nothing else: 1) Run with the Bash tool: pwd && git rev-parse --path-format=absolute --git-common-dir 2) With the Write tool, create the file C:/repos/foreman/.git/foreman/spike-x/thread.md whose content is the line "written by the foreman:spike-f010 thread" followed by the two output lines of step 1. 3) Answer DONE, or the exact error.'
#   backgrounded · 897a947d · foreman:spike-f010
claude agents --json --all     # su fila al terminar
#   {"pid":145828,"id":"897a947d","cwd":"C:\\repos\\foreman\\.claude\\worktrees\\foreman-spike-x","kind":"background","startedAt":1792159226148,"sessionId":"897a947d-f471-4f6d-9ed5-69047e277570","name":"foreman:spike-f010","status":"idle","state":"done"}
cat .git/foreman/spike-x/thread.md
#   written by the foreman:spike-f010 thread
#   /c/repos/foreman/.claude/worktrees/foreman-spike-x
#   C:/repos/foreman/.git
```

Transcript del hilo: `~/.claude/projects/C--repos-foreman--claude-worktrees-foreman-spike-x/897a947d-f471-4f6d-9ed5-69047e277570.jsonl` (la carpeta del proyecto es la del **worktree**, no la del repo). `tool_use`: `Bash`, `Write`; 0 `is_error`; última fila `assistant` `["DONE"]` con `stop_reason: end_turn`; una fila `system:turn_duration` (`durationMs: 13999`). El hilo arrancó en el worktree sin pedir confianza (cuelga de una carpeta ya de confianza).

`git status --short` del checkout principal tras todo lo anterior: solo `M .gitignore` (cambio mío: `spike/*/.claude-plugin/types/`) y los no rastreados previos (`docs/PENDING.es.md`, `docs/plans/`, `spike/v02/`); nada de foreman. `git -C .claude/worktrees/foreman-spike-x status --short`: vacío.

**F0-10 cumplido:** el subagente (desde el árbol principal y con `cwd` en el worktree), el hilo (desde el worktree) y el propio plugin (`$.fs.write` del registro en `.git/foreman-spike/`) escriben bajo `<git-common-dir>/`; `git status` limpio; ruta absoluta igual en ambos casos. No hace falta el respaldo `.claude/foreman/`.

### Hallazgo F0-10b · `$.agent.spawn({ cwd })` no mueve al subagente

El `.d.ts` (`AgentSpawnInput.cwd`) dice «The directory the subagent runs in when the call set one». Comprobado con el worktree y un archivo que solo existe allí:

```bash
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike reviewcwd C:/repos/foreman/.claude/worktrees/foreman-spike-x"
#   log: {"probe":"subagent.answer","agentId":"aa40433b7257384ee","answer":"```\n/c/repos/foreman\nC:/repos/foreman\nmain\n```"}
echo "only in the worktree" > .claude/worktrees/foreman-spike-x/WT_MARKER.txt
claude -p --plugin-dir 'C:\repos\foreman\spike\v02' "/fspike agent C:/repos/foreman/.claude/worktrees/foreman-spike-x 1) Use the Read tool on the relative path WT_MARKER.txt. 2) Use the Glob tool with pattern WT_MARKER.txt. 3) Run with Bash: pwd. Answer with the three results verbatim, errors included."
#   answer: "1. Read `WT_MARKER.txt` (relative path): `File does not exist. Note: your current working directory is C:\\repos\\foreman.` … 3. Bash `pwd`: `/c/repos/foreman`"
```

En `-p`, el subagente trabaja en el directorio de la sesión que lo lanza (`pwd`, `--show-toplevel`, rama `main`, rutas relativas), aunque el spawn pase `cwd`. Las filas de su transcript (`…/<parent>/subagents/agent-add64e77bb87895cd.jsonl`) llevan `"cwd":"C:\\repos\\foreman"`. Consecuencia: A-01 no se corrige solo con «`cwd` del spawn» (D-73).

Las dos pruebas que pidió el revisor:

1. **`EnterWorktree({ path })` desde el subagente** (tipo registrado con `EnterWorktree` en `tools`), sin `cwd` y con `cwd` en el worktree:

   ```bash
   claude -p --plugin-dir '…\spike\v02' "/fspike agentwt C:/repos/foreman/.claude/worktrees/foreman-spike-x"
   #   1. EnterWorktree …: error: `Cannot enter worktree: the current working directory C:\repos\foreman is the repository root, not an isolated worktree — switching is only available to sessions whose working directory is inside a worktree of this repository.`
   #   2. Read (`WT_MARKER.txt`): error: `File does not exist. Note: your current working directory is C:\repos\foreman.`
   #   3. Bash: `/c/repos/foreman` then `main`.
   claude -p --plugin-dir '…\spike\v02' "/fspike agent C:/repos/foreman/.claude/worktrees/foreman-spike-x 1) Call the EnterWorktree tool with path … 2) Read WT_MARKER.txt 3) pwd && git branch --show-current …"
   #   (las tres respuestas iguales: el mismo error de EnterWorktree, Read fallido, pwd en la raíz y rama main)
   ```

   Lo mismo desde `foreman-lab` (flujo headless, worktree `foreman-lab/.claude/worktrees/foreman-spike-x`): `Cannot enter worktree: the current working directory C:\repos\foreman-lab is the repository root, not an isolated worktree — …`.

2. **Variante con `AgentSpec.isolation: 'worktree'`** (tipo `foreman-spike:isoreviewer`, que la descripción de `EnterWorktree` nombra como «pinned at launch»):

   ```bash
   claude -p --plugin-dir '…\spike\v02' "/fspike agentiso C:/repos/foreman/.claude/worktrees/foreman-spike-x"
   #   0) pwd && git branch --show-current: /c/repos/foreman/.claude/worktrees/agent-a03378d3548a2a011 · worktree-agent-a03378d3548a2a011
   #   1) EnterWorktree: "Entering C:\repos\foreman\.claude\worktrees\foreman-spike-x would not give this agent write access there, so the switch was not made. This agent is isolated in the worktree C:\repos\foreman\.claude\worktrees\agent-a03378d3548a2a011, so its writes are limited to that folder. …"
   #   2) Read WT_MARKER.txt: File does not exist. Note: your current working directory is …\agent-a03378d3548a2a011.
   git worktree list
   #   C:/repos/foreman                                            8a47838 [main]
   #   C:/repos/foreman/.claude/worktrees/agent-a03378d3548a2a011  8a47838 [worktree-agent-a03378d3548a2a011]
   #   C:/repos/foreman/.claude/worktrees/foreman-spike-x          8a47838 [foreman/spike-x]
   ```

   El aislamiento sí fija el directorio (un worktree nuevo desde `HEAD`, rama `worktree-agent-<id>`), pero no deja pasar al worktree del plan; y el worktree aislado **queda en disco con su rama** al terminar el subagente (lo retiré con `git worktree remove` + `git branch -D`).

Decisión del revisor sobre esto (D-83): **(A)**: el brief del revisor lleva la ruta absoluta del worktree; Read/Grep/Glob con rutas absolutas bajo él; el guard de solo lectura admite `git -C <wt>`; los gates se comparan literalmente como la línea completa `cd "<wt>" && <gate>`, y esa comparación va antes del análisis por segmentos.

La repetición desde la app (pasos `spawnCwd` y `spawnEnterWorktree` del flujo de la ronda 1) no llegó a lanzar el subagente: `{"spawn":{"deny":"The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. …"}}`. Eso deja al subagente fuera también por otra razón (hallazgo transversal, más abajo) y lleva a la propuesta D-84: revisor y supervisor como procesos `claude -p` con `cwd` en el worktree, que hacen innecesaria la variante (A).

---

## F0-3 · Mensaje de un plugin a una sesión de escritorio (desde la CLI)

En el flujo headless de `foreman-lab` el paso `sendToImplementer` hizo `$.session.send({ to: { sessionId: "08c56a72-0277-4b54-be0f-324158a97f21" }, text: … })` (el `sessionId` de esta sesión implementadora, de escritorio, según `claude agents --json --all`) → `{"isDelivered":true}`. En esta sesión llegó como:

```text
<cross-session-message from="uds:\\.\pipe\LOCAL\cc-<session pipe>" from-name="foreman-lab-9c" from-mode="prompting" from-plugin="foreman-spike">
foreman-spike F0-3: a plugin message by sessionId from f08b7d3d-401b-4e1c-97f1-974f05471337
</cross-session-message>
```

Es decir: `$.session.send({ to: { sessionId } })` acepta el `sessionId` del transcript (no hace falta el `local_<id>` de la app) y entrega a una sesión de escritorio viva; el receptor ve el plugin de origen (`from-plugin`). Desde una sesión de la app en modo `auto` la misma llamada la deniega el clasificador, y `$.mcp.call("ccd_session_mgmt","send_message")` sí entrega: §F0-1/F0-3 en la app.

## F0-6 · Hilo en el worktree del plan

- Del hilo `foreman:spike-f010` de F0-10: un `claude --bg` lanzado con `cwd` en un worktree bajo `.claude/worktrees/` del repo y `--settings '{"worktree":{"bgIsolation":"none"}}'` trabaja en ese worktree (su `pwd` es el worktree), **no pide confianza** (la carpeta cuelga de una de confianza; en `~/.claude.json` solo constaban `C:/repos/foreman` y `…/foreman-demo` con `hasTrustDialogAccepted: true`) y no crea otro worktree (`git worktree list` sin entradas nuevas).
- `.git/info/exclude` con `.claude/worktrees/` deja limpio el `git status` de un repo que versiona `.claude/` (§0.3).
- En `foreman-lab` (ya de confianza tras la primera visita del usuario: `C:/repos/foreman-lab {"trust":true}`), un hilo que arregla el bug y hace commit en la rama del worktree:

```bash
cd C:/repos/foreman-lab/.claude/worktrees/foreman-spike-x
claude --bg --name "foreman:spike:f06" --model sonnet --effort low --permission-mode auto --settings '{"worktree":{"bgIsolation":"none"}}' 'You are in a git worktree on branch foreman/spike-x. Stay on this branch: do not create or switch branches, do not push. Task: src/stats.js median() is wrong for an even number of values (it must return the mean of the two middle values). Add a failing test for it in test/stats.test.js, fix median, run npm test, and commit both files on this branch with the message "fix: median of an even-length list". Then answer with the commit hash and the npm test summary.'
#   backgrounded · f508837d · foreman:spike:f06
claude agents --json --all     # al terminar
#   {"pid":159384,"id":"f508837d","cwd":"C:\\repos\\foreman-lab\\.claude\\worktrees\\foreman-spike-x","kind":"background","startedAt":1792161517874,"sessionId":"f508837d-8309-425e-a811-d37616a40398","name":"foreman:spike:f06","status":"idle","state":"done"}
git log --oneline --all -5
#   81c07bb fix: median of an even-length list
#   35e557c chore: seed foreman-lab (stats module with a known bug, rules, skill, hook)
git status --short             # checkout principal
#    M .claude/settings.json   (la instalación del spike, §0.3; nada del hilo)
git worktree list
#   C:/repos/foreman-lab                                    35e557c [main]
#   C:/repos/foreman-lab/.claude/worktrees/foreman-spike-x  81c07bb [foreman/spike-x]
```

Transcript `~/.claude/projects/C--repos-foreman-lab--claude-worktrees-foreman-spike-x/f508837d-8309-425e-a811-d37616a40398.jsonl`: `tool_use` `Skill {"skill":"lab-conventions"}` (la skill propia del repo), `Read`, `Edit`, `Bash npm test` (falla primero: «actual 3 and expected 2.5»), `Edit`, `Bash npm test && git add src/stats.js test/stats.test.js && git commit …`; 0 `is_error`; el hook propio `SessionStart` del repo inyectó «foreman-lab hook: tests run with `npm test`; deliver by PR from a fix/ or feat/ branch.»; una fila `turn_duration` (`durationMs: 28925`). Respuesta: «committed on `foreman/spike-x` as `81c07bb83759f477a1c23cb4f8e018926a587963` … tests 5, suites 1, pass 5, fail 0». Siguió la orden de quedarse en la rama aunque `CLAUDE.md` pida ramas `fix/<slug>`: el brief de foreman manda sobre la convención de ramas del repo (lo dirá el brief en la Fase 4).

`start_session` con `cwd` en el worktree no se probó: el plugin no puede crear sesiones (F0-1).

**F0-6 cumplido.**

---

## F0-1 · ¿Puede el plugin crear una sesión de escritorio?

Las tres vías del plan, desde las sesiones de la app con el mod cargado (modo de permisos `auto`, el de las sesiones del usuario: `get_session("self")` → `"permissionMode": "auto"`):

| Vía | Llamada | Resultado literal |
|---|---|---|
| (a) `$.tool.call` | `{ tool: "mcp__ccd_session__start_session", title: "foreman:spike:test", prompt: "Reply with the word PONG and nothing else", initiation: "user_asked", context: "fresh", cwd: "C:\\…\\foreman-lab", permission_mode: "auto", use_worktree: false }`, desde el flujo (ronda 1) | `{"deny":"The server-side auto mode classifier gave no verdict for mcp__ccd_session__start_session: the request that produced this action did not ask for one. Issue the action again once, as-is; …"}` |
| (a) desde un comando que teclea el usuario | `/fspike start` (ronda 2, `command.run (origin composer, command fspike)`) | el mismo `deny` del clasificador |
| (b) `$.mcp.call` | `$.mcp.call("ccd_session", "start_session", { …, title: "foreman:spike:mcp" })` (ronda 2) | `{"error":"foreman-spike: $.mcp.call(ccd_session, start_session) refused: The server-side auto mode classifier gave no verdict for mcp__ccd_session__start_session: the request that produced this action did not ask for one. …"}` |
| `claude --desktop` con prompt | `$.process.run(["claude","--desktop","--name","foreman:spike:b","Reply with PONG"])` (ronda 1) | `exitCode 1`, stderr `--desktop opens the Claude Desktop app and can't run non-interactively (--print, --sdk-url, --init-only, or redirected output).` (y `claude --help`: `--desktop … (with --continue or --resume <id> to pick the session)`: no crea una conversación nueva con prompt) |
| (c) el modelo del chat | mi propio `mcp__ccd_session__start_session(initiation: "user_asked", cwd: foreman-lab, …)` en un turno que abrió el mensaje de otra sesión | `Start sessions only on the user's own words to you here; this turn runs an automated event, another session's message, or the task another session gave you. Propose the session instead (initiation "own_initiative"), or start it once the user asks you here.`; la propuesta con carpeta: `A proposal card cannot carry a host, folder, environment or preset yet` |

No verificado: el reintento «once, as-is» que sugiere el mensaje del clasificador, ni la llamada en un turno con una petición explícita (lo iba a pedir al modelo de la sesión de la ronda 2 con un mensaje, pero el usuario ya la había borrado: `Message not delivered: session local_7da4ce7a-… not found`).

Lectura: el plugin **no** puede crear sesiones de escritorio por sí mismo (ni en un flujo autónomo, ni tras una pulsación en el panel, ni dentro de un comando tecleado por el usuario). El modelo del chat sí puede, pero la app solo lo deja en un turno que abrió el usuario con sus palabras; un turno abierto por otra sesión no vale, y uno abierto por `$.prompt.submit` del plugin no se probó (es, con toda probabilidad, el mismo caso: «an automated event»). En un plan con varias partes y rondas, casi todos los lanzamientos ocurren sin turno del usuario (la parte siguiente, la ronda de aplicar): la vía (c) solo cubriría el primero.

Lo que sí funciona (y no pasa por el clasificador): `$.mcp.call("ccd_session","list_start_targets",{})` (de solo lectura; devolvió `{"thisComputer":{"projectFolder":"C:\\repos\\foreman-lab", …}`) y `$.mcp.call("ccd_session_mgmt","send_message", { session_id: "local_274575e3-…" })` → `Message queued for session local_274575e3-41ae-48b4-aecd-a3e6ada65cee ("Foreman v0.2 plugin implementation"): that session is holding it (a turn is in progress there…) (delivery: queued; message_id: 9cdcf974-…)`.

**F0-1: no** (vías a, b y `--desktop` cerradas; c solo en turnos del usuario). → Driver `background` (§9).

## Hallazgo transversal · el clasificador del modo `auto` y las llamadas del plugin

En una sesión de la app en modo `auto`, toda llamada del plugin que pasa por el clasificador se deniega con «gave no verdict … the request that produced this action did not ask for one», sea cual sea el origen dentro del plugin:

| Llamada del plugin | Origen | Resultado |
|---|---|---|
| `$.agent.spawn` (`foreman-spike:reviewer`) | flujo autónomo (ronda 1, pasos `spawnCwd`/`spawnEnterWorktree`) | `{"deny":"The server-side auto mode classifier gave no verdict for Agent: …"}` |
| `$.agent.spawn` | `onPress` del botón «Spawn test» (`pane press on desktop`, ronda 2, 14:42:46) | el mismo `deny` |
| `$.session.send({ to: { sessionId } })` | flujo (ronda 1) y `onPress` de «Send test» (ronda 2, 14:42:48) | `{"isDelivered":false,"reason":"The server-side auto mode classifier gave no verdict for SendMessage: …"}` |
| `$.tool.call(start_session)` | flujo y `/fspike start` tecleado | `deny` (F0-1) |
| `$.mcp.call(start_session)` | flujo | `refused` (F0-1) |
| `$.tool.call(PushNotification)` | flujo | **pasa** (resultado de la herramienta, F0-7) |
| `$.mcp.call(list_start_targets)`, `$.mcp.call(send_message)` | flujo | **pasan** |
| `$.process.run` (`claude agents`, `claude -p`, `powershell Start-Process claude --desktop …`) | flujo, comando, `-p` | **pasan** (no es una herramienta) |

En la CLI (`claude -p`, modo `default`) `$.agent.spawn` y `$.session.send` funcionaron sin diálogo (F0-10, F0-3). Consecuencia para el diseño: en la app, foreman no puede apoyarse en `$.agent.spawn`, `$.session.send` ni `start_session` para nada que haga solo (revisor, supervisor, mensajes a hilos, lanzar hilos). Sí en `$.process.run`.

### Revisor y supervisor como proceso (`claude -p` en el worktree)

```text
$.process.run(["claude","-p","--model","haiku","--allowedTools","Read,Bash(pwd),Bash(git branch:*)"],
              { cwd: "C:/repos/foreman-lab/.claude/worktrees/foreman-spike-x", stdin: "<prompt>" })
```

(`--allowedTools` toma varios valores y se comía el prompt posicional: `Error: Input must be provided either through stdin or as a prompt argument when using --print`; el prompt va por `stdin`.)

- Desde la CLI (sonda `procreview`): `1. Read WT_MARKER.txt: 1→only in the worktree · 2. pwd: /c/repos/foreman-lab/.claude/worktrees/foreman-spike-x · 3. git branch --show-current: foreman/spike-x · No errors on any of the three.`
- Desde la sesión de la app (ronda 2, paso `procReview`, `exitCode 0`): `pwd` = el worktree, rama `foreman/spike-x` (el marcador ya estaba borrado: `File does not exist. Note: your current working directory is …\foreman-spike-x`). Su transcript queda en la carpeta de proyecto del worktree (`a04159b7-….jsonl`).
- Guard por flags, probado: `claude -p --model haiku --permission-mode dontAsk --allowedTools "Read" "Grep" "Glob" "Bash(npm test)" --output-format json` con cwd en el worktree y la orden de correr `npm test`, `git status --short` y escribir `x.txt` → `npm test` corre (`ℹ pass 5 ℹ fail 0`), `git status` corre (Claude Code admite solo los comandos de solo lectura), `Write` denegado sin diálogo (`"permission_denials":[{"tool_name":"Write",…}]`, «Permission to use Write has been denied because Claude Code is running in don't ask mode»); `x.txt` no existe; la salida JSON trae `usage` y `total_cost_usd` (`0.00394976`).

Es decir: un proceso `claude -p` con `cwd` en el worktree del plan resuelve a la vez A-01 (rutas relativas, `git` y gates en el worktree, sin `git -C` ni `cd`) y el clasificador. `--bare` no sirve (exige `ANTHROPIC_API_KEY`).

### Pruebas de los roles como proceso (las que pidió el revisor, en `foreman-lab`, sin la app)

Resumen de cada `--output-format json` con `pjson.mjs` (scratchpad).

- **(a) Guard del plugin por `FOREMAN_THREAD` inyectado con `--settings`.** El spike añade un `tool.call` sobre `Edit`/`Write` que deniega si `$.env.get("FOREMAN_THREAD")` contiene `:reviewer-` (con `.catch` que deniega si no puede juzgar).
  ```text
  claude -p --plugin-dir …\spike\v02 --model haiku --settings '{"env":{"FOREMAN_THREAD":"foreman:spike:reviewer-A"}}' --permission-mode dontAsk --allowedTools "Read" "Write" --output-format json   (stdin: escribir spike-guard.txt)
  → {"subtype":"success","num_turns":2,"permission_denials":[],"result":"The Write tool returned this error, verbatim: <tool_use_error>foreman-spike guard: foreman:spike:reviewer-A is a reviewer and may not use Write</tool_use_error> …"}; el archivo no existe
  mismo sin el env → "File created successfully at: …\foreman-lab\spike-guard.txt" (borrado después)
  ```
  El `env` de `--settings` llega a `$.env.get` y el plugin hace de guard dentro del proceso.
- **(b) `--allowedTools` como segunda barrera, según el modo.**
  ```text
  dontAsk (arriba): Write fuera de la lista → "permission_denials":["Write"], sigue sin bloquearse
  --permission-mode default --allowedTools "Read" → "permission_denials":["Write"], «Claude requested permissions to write to …\spike-guard.txt, but you haven't granted it yet.»; sigue
  --permission-mode auto    --allowedTools "Read" → "permission_denials":[], «File created successfully at: spike-guard.txt»   ← la lista NO limita en modo auto
  ```
  El proceso de un rol fuerza `--permission-mode dontAsk` (nunca hereda `auto`); entonces `--allowedTools` sí es barrera, además del guard del plugin.
- **(c) `--max-turns` y JSON.** `--max-turns` no sale en `claude --help`, pero funciona: `--max-turns 2` con una tarea de cuatro lecturas → `{"subtype":"error_max_turns","is_error":true,"num_turns":3,"result":""}`. Con `success`, `result` es el texto final (el veredicto del revisor, el JSON del supervisor). `error_max_turns` deja `result` vacío: para el supervisor, escalada.
- **(d) Tiempo y coste frente al subagente** (Haiku, mismo encargo: revisar `git diff 35e557c 81c07bb` y correr `npm test`):

  | | Duración | Turnos | Tokens (entrada / salida / caché leída / caché creada) | Coste |
  |---|---|---|---|---|
  | Proceso `claude -p`, ejecución 1 | 22.977 ms | 4 | 6 / 2.498 / 116.824 / 16.072 | 0,00563 $ |
  | Proceso `claude -p`, ejecución 2 | 15.772 ms | 4 | 4 / 1.746 / 73.429 / 13.504 | 0,00431 $ |
  | Subagente (`$.agent.spawn`, `-p` en modo default) | 12,7 s (spawn 15:02:42,9 → respuesta 15:02:55,6) | — | 6 / 1.354 / 13.973 / 8.701 | — (no lo da) |

  El proceso arrastra el prompt de sistema completo de Claude Code y todas las herramientas (≈5× más contexto, casi todo lectura de caché) y unos segundos de arranque. Con Fable/Opus se nota más; en la Fase 4 se recorta con `--tools` (solo las del rol) y, si hace falta, `--system-prompt-file`. Dato de la ejecución 2: el modelo lanzó `npm test; echo "EXIT=$?"`, no la línea literal, y el `dontAsk` lo denegó (`"denials":[{"command":"npm test; echo \"EXIT=$?\"", …}]`) → «Verdict: NO». Es el caso de D-73 («could not run» ≠ NO): el brief exige la línea exacta del gate y foreman distingue «no pudo correr» de NO. El subagente hizo lo mismo (`npm test; echo "…`), pero allí nadie lo limitaba.
- **(e) Tope de 10 minutos de `$.process.run`.** `$.process.spawn` no tiene tope (el hijo vive mientras dure el bucle o el módulo). Sonda `spawnreview` (`$.process.spawn({ argv: ["claude","-p","--model","haiku","--permission-mode","dontAsk","--allowedTools","Read","Bash(git diff:*)","Bash(npm test)","--output-format","json"], input: <prompt> })`, stdout acumulado y parseado) → `{"wallMs":13471,"subtype":"success","duration_ms":8791,"cost":0.0035092300000000003,"result":"Verdict: OK\npass 4\nfail 0","stderr":""}`. Decisión: revisor por `$.process.spawn` con un tope propio de foreman; supervisor por `$.process.run` (corto; si pasa de 10 min, escala). Si el chat coordinador se cierra a mitad, el proceso muere con el módulo y foreman relanza la revisión al reabrir (es idempotente). No hace falta `claude --bg` para los roles.

---

## F0-2 · Panel en la app

- `$.ui.open({ id: "fspike" })` desde una sesión de la app → `{"opened":{"isPlaced":true},"panes":[{"id":"fspike","title":"foreman spike v0.2","isShown":true,"isFocused":false,"isPlaced":true}]}` (rondas 1 y 2), y 5 minutos después `latePanes` igual.
- Interacciones registradas por el propio panel, todas con `surface: "desktop"`: `pane.input` «hola» (14:27:25) y `pane.select` «review» (14:27:36) en la ronda 1; `onPress` de «Spawn test» (14:42:46) y «Send test» (14:42:48) en la ronda 2 (sus resultados, denegados por el clasificador, están arriba; lo que se prueba aquí es que la pulsación llega). «Press me» no quedó registrado en ninguna de las dos rondas, aunque en la 2 el usuario lo pulsó junto con los otros dos (su captura: `presses: 0`); no hay registro de depuración de esas sesiones. Diferencias con los dos que sí funcionan: es el primer botón del panel, va justo detrás del `Markdown` y su `onPress` escribe `$.state` (`update`) antes de registrar (los otros llaman directamente a la sonda); `update` sí funcionó en el Input y el Select de la ronda 1. Sin explicar: se reverifica con el panel real en la aceptación de la Fase 2. `Button.onPress` llega en escritorio (dos botones de tres).
- El panel aparece **solo después del primer mensaje** (observación del usuario): en la app `session.start` ocurre al enviar el primer prompt, no al crear la sesión. Y llega **sin superficie**: `{"probe":"session.start","surface":null,"isInteractive":false,"surfaces":[]}` a las 14:40:16.842 y `{"probe":"session.attach","surface":"desktop","clientId":"desktop-2","viewport":{"columns":106,"rows":77,"isFullscreen":true}}` a las 14:40:17.352 (0,5 s después; lo mismo en las otras tres sesiones: 0,26 s, 0,72 s, 0,89 s). Por eso las sesiones `767e16db…` y `bf6078cf…` no dispararon la ronda 2: yo había hecho que solo una sesión con superficie `desktop` consumiera el armado y lo comprobaba en `session.start`. Corregido comprobándolo también en `session.attach` (`desktop`); la ronda 2 arrancó «(session.attach)».

**F0-2 cumplido.** Para la Fase 2: abrir el panel o preguntar en `session.attach` (`desktop`) o más tarde, nunca en `session.start`; la detección de modo hilo en `session.start` no puede depender de la superficie.

## F0-3 · Mensajes a una sesión de escritorio (resumen)

- Plugin en la CLI → sesión de la app, `$.session.send({ to: { sessionId } })`: entregado (sección anterior).
- Plugin en la app (modo `auto`) → `$.session.send`: denegado por el clasificador (desde el flujo y desde un botón).
- Plugin en la app → `$.mcp.call("ccd_session_mgmt","send_message", { session_id: "local_…" })`: encolado y entregado a esta sesión. Llegó al terminar mi turno como `<cross-session-message from="local_7da4ce7a-b925-4aa2-a528-47c9f567d673" name="Hola">foreman-spike F0-3: a plugin message through ccd_session_mgmt.send_message from 1dbed825-2c1e-42ad-965f-cfe9fa04681c</cross-session-message>`. Usa el id de la app (`local_…`), no el `sessionId`.
- Hilo `--bg` → mensaje nuevo: `claude --bg --resume <sessionId> "<texto>"` (v0.1), que sigue funcionando incluso con el hilo ya abierto en la app (F0-4).

## F0-4 · Abrir un hilo `--bg` en la app

```bash
claude --desktop --resume f508837d-8309-425e-a811-d37616a40398        # desde Git Bash (salida redirigida)
#   --desktop opens the Claude Desktop app and can't run non-interactively (`--print`, `--sdk-url`, `--init-only`, or redirected output).
cmd /c start "" claude --desktop --resume f508837d-8309-425e-a811-d37616a40398   # consola propia
#   start exit 0
```

`get_session` / `list_sessions` de la app, justo después: `{"sessionId":"local_f508837d-8309-425e-a811-d37616a40398","title":"foreman:spike:f06","cwd":"C:\\…\\foreman-lab\\.claude\\worktrees\\foreman-spike-x","branch":"foreman/spike-x", …}`. Aparece en la barra lateral **con el mismo id** (`local_` + el `sessionId`), su título y la rama. `claude agents`: la fila pierde `pid` y `status` (el proceso del hilo terminó; `state: "done"` se conserva) y el transcript es el mismo archivo.

Desde el plugin (`$.process.run`, sonda `open`):

- `["cmd","/c","start","\"\"","claude","--desktop","--resume",id]` → `exitCode 0` pero la sesión no aparece (`get_session` → «not found»): el título vacío de `start` no sobrevive al paso de argumentos.
- `["powershell.exe","-NoProfile","-NonInteractive","-Command","Start-Process -FilePath claude -ArgumentList '--desktop','--resume','<id>' -WindowStyle Hidden"]` → `exitCode 0` y `get_session("local_85c9176d-…")` → `{"title":"foreman:spike:f09b","cwd":"…\\foreman-spike-x","branch":"foreman/spike-x","model":"claude-haiku-5-5", …}`. **Funciona.**

Después de abrirlo en la app, el hilo se puede seguir mandando como `--bg`:

```bash
claude --bg --resume f508837d-8309-425e-a811-d37616a40398 'Reply with the single word PONG and nothing else.'
#   note: woke session f508837d with its saved options (--name, --effort, --permission-mode, --settings, --model).
#   backgrounded · f508837d · foreman:spike:f06
#   transcript: turno nuevo «PONG» (end_turn, turn_duration 8793 ms) en el mismo archivo
```

Hilo **bloqueado** (`foreman:spike:f04b`, `--permission-mode default`, sin permisos: fila `{"status":"waiting","waitingFor":"permission prompt","state":"blocked"}`): `open` con el proceso vivo **no** lo adopta (25 s después, `get_session` → «not found», fila igual). Con `claude stop dd545479` (`stopped dd545479`) y `open` → `local_dd545479-…` en la app; `list_events` de la app: `[user] Run exactly this with the Bash tool: npm test …` / `[assistant] (called Bash)`. El usuario sigue allí, con los diálogos en la interfaz.

**F0-4 cumplido:** «Open» del driver `background` = (si el hilo está `blocked`, `claude stop`) + `Start-Process claude --desktop --resume <sessionId>`; es la salida GUI para «blocked» (A-07).

## F0-5 · Fin de turno en sesiones de escritorio

`node turns.mjs <transcript>` (scratchpad; cuenta filas y empareja cada prompt con la última fila `assistant`):

```text
0096aec5 (app, ronda 1):  {"rows":40,"counts":{"turn_duration":0,"stop_hook_summary":1,"end_turn":1}}
  {"promptAt":"2026-10-16T14:26:33.211Z","prompt":"hola?","origin":"human","lastAssistant":{"at":"2026-10-16T14:26:37.910Z","stop_reason":"end_turn",…},"stopHook":"2026-10-16T14:26:37.961Z"}
767e16db (app):           {"rows":35,"counts":{"turn_duration":0,"stop_hook_summary":1,"end_turn":1}}
bf6078cf (app):           {"rows":35,"counts":{"turn_duration":0,"stop_hook_summary":1,"end_turn":1}}
897a947d (--bg):          {"rows":53,"counts":{"turn_duration":1,"stop_hook_summary":0,"end_turn":1}}
f508837d (--bg, 2 turnos): {"rows":94,"counts":{"turn_duration":2,"stop_hook_summary":0,"end_turn":2}}
```

Filas de `claude agents --json --all`: app `{"pid":157872,"cwd":"C:\\…\\foreman-lab","kind":"interactive","startedAt":1792160792142,"sessionId":"0096aec5-…","name":"Hola","status":"busy"}` (luego `"status":"idle"`); `-p` `{"kind":"interactive","sessionId":"f08b7d3d-…","name":"foreman-lab-9c","status":"busy"}`; `--bg` `{"kind":"background","id":"f508837d","state":"done","status":"idle",…}`; `--bg` bloqueado `{"status":"waiting","waitingFor":"permission prompt","state":"blocked"}`.

**F0-5 cumplido:** en la app, 0 `turn_duration`; fin de turno = fila `status: idle` + última `assistant` tras el prompt con `end_turn` (coincide con la hora observada); `stop_hook_summary` en cada turno de estas sesiones (las de la app corren hooks Stop), como confirmación. En `--bg`, `turn_duration` siempre presente. El `name` de la fila `interactive` es el título de la app; el `sessionId` de la fila no es el id de la app (`local_3906b776-…` frente a `0096aec5-…`; `get_session` no da el `sessionId`), salvo en un hilo `--bg` abierto en la app (`local_<sessionId>`). Como el driver principal es `background` (§9), A-08 solo afecta a los hilos que el usuario abra en la app.

## F0-7 · Avisos y diálogo en la app

| Prueba | Resultado |
|---|---|
| `$.ui.notify` (al arrancar y 2 min después) | `{"isSent":false,"reason":"no-surface"}` las dos veces |
| `PushNotification` por `$.tool.call`, al arrancar | `{"pushSent":false,"localSent":false,"disabledReason":"user_present"}`, «Not sent — this terminal is active, …» |
| `PushNotification`, 2 min después (el usuario ya no miraba) | `{"pushSent":false,"localSent":false,"disabledReason":"config_off"}`, «Push not sent — mobile push is disabled in /config.» |
| `$.ui.ask` lanzado desde `session.start` (flujo sin esperar) | «Yes, I see it» (14:26:35 → 14:27:54) |
| `$.ui.ask` dentro de `command.run` tecleado por el usuario (`/fspike ask`, `origin composer`) | «Yes, I see it» (14:43:01) |
| `$.ui.ask` dentro de `command.run` lanzado por el propio plugin (`$.command.run`) | no corre: «foreman-spike registered /fspike but no command.run hook answered it» (el `.d.ts`: `$.command.run` «runs through every hook but the calling one»); la fila del transcript lleva `origin {"kind":"plugin","name":"foreman-spike"}` |

El usuario no vio ninguna notificación del sistema. **F0-7:** en la app no hay aviso del sistema sin configurar nada: `$.ui.notify` no tiene superficie y `PushNotification` (que el plugin sí puede llamar y no pasa por el clasificador) solo envía con el push activado en `/config`, al móvil. M1 queda visual (panel, línea de estado, toast) más `PushNotification` en las escaladas, que el propio motor decide si envía. `$.config.list()` expone los interruptores (`/fspike config`): `{"key":"agentPushNotifEnabled","label":"Push when Claude decides","kind":"boolean","value":false}`, `{"key":"inputNeededNotifEnabled","label":"Push when actions required","kind":"boolean","value":false}` y `{"key":"notifChannel","label":"Local notifications","kind":"choice","value":"auto",…}`: `setup` puede ofrecer activar el push con un `$.ui.ask` y `$.config.set` (D-74). `$.ui.ask` funciona en la app desde un flujo y desde un comando del usuario.

## F0-9 · Permisos heredados

`foreman-lab/.claude/settings.local.json` (no versionado, así que el worktree no lo ve) con `{"permissions":{"allow":["Bash(npm test)"]}}`; `/fspike settings` → `{"mergedPermissions":{"allow":["Bash(npm test)"]},"localPermissions":{"allow":["Bash(npm test)"]}}` (antes: `null` y `null`). Dos hilos en el worktree, modo `default`:

```bash
claude --bg --name "foreman:spike:f09a" --model haiku --effort low --permission-mode default --settings '{"worktree":{"bgIsolation":"none"}}' 'Run exactly this with the Bash tool: npm test — then answer with its "pass" and "fail" summary lines only.'
claude --bg --name "foreman:spike:f09b" --model haiku --effort low --permission-mode default --settings '{"worktree":{"bgIsolation":"none"},"permissions":{"allow":["Bash(npm test)"]}}' '…lo mismo…'
claude agents --json --all
#   foreman:spike:f09a cae9ccdf blocked waiting
#   foreman:spike:f09b 85c9176d done idle
```

f09a: `tool_use Bash {"command":"npm test"}` sin `tool_result` (esperando el diálogo; parado después con `claude stop cae9ccdf` → `stopped`). f09b: `Bash npm test` → «ℹ pass 5 ℹ fail 0», `end_turn`, sin diálogo.

**F0-9 cumplido:** el `permissions.allow` efectivo de `$.settings.read()` (que incluye `settings.local.json`) pasado por `--settings` evita el `blocked`. Los hilos en modo `auto` (el de la v0.1) no se bloquearon en ninguna prueba (F0-6, F0-10).

---

## Otros hallazgos

- **`--bg` y `-p` no se combinan** (salida literal en F0-10): ya lo decía D-02 de la v0.1 y el argv de `threads.ts` ya va sin `-p`; el error fue mío en la orden del spike.
- **El transcript de un hilo lanzado en un worktree vive en la carpeta de proyecto del worktree** (`C--repos-foreman-lab--claude-worktrees-foreman-spike-x`): `transcriptOf` debe derivar la carpeta del `cwd` de la fila, no de la raíz del repo.
- **Ids:** una sesión creada en la app tiene `local_<uuid>` distinto de su `sessionId` (el revisor: `local_b56e297a-…` / `f30786dc-…`); un hilo `--bg` abierto en la app conserva el suyo (`local_<sessionId>`). `$.session.send({ to: { sessionId } })` acepta el `sessionId`; `send_message` de `ccd_session_mgmt`, el `local_…`.
- **Las filas `interactive`** de `claude agents --json --all` confirman A-08 (`status: idle|busy`, sin `state` ni `id` corto); una sesión `claude -p` también aparece como `interactive`, con un `name` generado (`foreman-lab-9c`).
- **La app usa otra build** (2.1.295) que la CLI (2.1.296): los hooks deben leer las entradas sin suponer campos nuevos (el spike lee `e.origin?.kind`).
- **`$.command.run` de un plugin no ejecuta sus propios hooks `command.run`**: foreman no puede usarlo para llamarse a sí mismo.
- **`isolation: 'worktree'` en un subagente deja su worktree y su rama** (`worktree-agent-<id>`) al terminar.
- **Desinstalar en scope `project`:** `claude plugin uninstall foreman-spike@foreman-spike` (en `foreman-lab`) → `✘ Failed to uninstall plugin "foreman-spike@foreman-spike": Plugin "foreman-spike@foreman-spike" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: claude plugin disable foreman-spike@foreman-spike --scope local`. Lo que sí lo quita: `claude plugin marketplace remove foreman-spike --scope project` («The removal also deletes their saved options, secrets and data where it can»), tras lo cual `claude plugin list` ya no lo lista. Vale para la limpieza de la Fase 5 y para la sección de desinstalación del README.
- **`claude agents --json --all` puede salir en varias líneas**: nunca filtrarlo con `grep` por línea (un vigilante mío con `grep` no terminó nunca).

---

## 9. Tabla de decisión

| Tema | Evidencia | Decisión | Implica para |
|---|---|---|---|
| Driver principal de los hilos (D-69) | F0-1: (a), (b) y `--desktop` cerradas; (c) solo en un turno que abre el usuario con sus palabras. F0-6/F0-9: `claude --bg` en el worktree funciona (commit, skill y hook del repo, sin confianza nueva) | **`background`** (`claude --bg`, argv sin `-p`, `--settings` con `bgIsolation: none`, `FOREMAN_THREAD` y los permisos heredados). Sin driver `desktop` para lanzar. La preferencia del usuario por (c) (Anexo C, respuesta 3) no es aplicable: cubriría solo el primer lanzamiento de cada plan → **pendiente de OK del revisor** | F2: `drivers/desktop.ts` pasa a ser la acción «Open» del driver `background`, no un driver |
| Hilos visibles en la app | F0-4: `Start-Process claude --desktop --resume <id>` desde el plugin los pone en la barra lateral con el mismo id; siguen aceptando `--bg --resume` | Botón **Open** por hilo = `Start-Process` (si está `blocked`, `claude stop` antes). Reply = `claude --bg --resume <id> "<texto>"` | F2: aceptación 3 (blocked desde la app) se cumple con Open |
| Revisor y supervisor (D-68, D-73) | Clasificador: `$.agent.spawn` denegado en la app en modo `auto` (flujo, botón); `spawn({ cwd })` no mueve al subagente (F0-10b); `EnterWorktree` e `isolation` no llegan al worktree del plan. Proceso `claude -p` con `cwd` en el worktree: funciona desde la CLI y desde la app; `dontAsk` + `--allowedTools` deniega el resto sin bloquear; JSON con `usage` | **Procesos `claude -p`** (`cwd` = worktree del plan; `--permission-mode dontAsk` siempre, porque en `auto` la lista no limita; `--allowedTools` de solo lectura + las líneas exactas de los gates; `--settings` con `FOREMAN_THREAD` para que el guard del plugin actúe dentro; `--max-turns`; prompt por `stdin`; `--output-format json`). Revisor por `$.process.spawn` (sin tope de 10 min), supervisor por `$.process.run`; foreman escribe el archivo de la revisión con la salida. Sustituye a `$.agent.register`/`$.agent.spawn` y a la variante (A) de D-83 → **pendiente de OK del revisor** | F3 (supervisor), F4 (revisor, gates, A-01) |
| Mensajes del plugin | F0-3: `$.session.send` sí desde la CLI, denegado en la app en `auto`; `$.mcp.call(send_message)` sí en la app | A hilos: `claude --bg --resume`. A sesiones de la app (avisos al chat coordinador, si hiciera falta): `$.mcp.call("ccd_session_mgmt","send_message")`. `$.session.send` solo como respaldo en la CLI | F2 |
| Avisos (M1) | F0-7: `$.ui.notify` → `no-surface` en la app; `PushNotification` llamable pero `user_present` / `config_off`; `$.config.list()` tiene `agentPushNotifEnabled` | Visual (panel, `$.ui.status`, toast) + `PushNotification` en escaladas y plan terminado (el motor decide si envía; con el push activado llega al móvil). `setup` ofrece activar `agentPushNotifEnabled` (`$.ui.ask` + `$.config.set`). `$.ui.notify` solo para usuarios de terminal | F2 (M1), F5 (README) |
| Panel (F0-2) | `isPlaced: true`; Button, Input y Select llegan desde `desktop` | Panel v2 como vista principal. Abrirlo y preguntar en `session.attach` (`desktop`) o más tarde, nunca en `session.start` (en la app llega sin superficie) | F2 |
| `$.ui.ask` | Funciona en la app desde un flujo y dentro de `command.run` tecleado; `$.command.run` propio no ejecuta el hook | `setup` y `go` preguntan dentro de su `command.run` (como prevé el plan); nunca encadenar el propio comando con `$.command.run` | F1, F5 |
| Herramientas `mcp__foreman__*` (M2) | F0-8: con `isDeferred: false` el modelo las llama (Haiku y Sonnet) | Registrar las cinco con `isDeferred: false` | F2 |
| Almacenamiento (D-70) | F0-10: plugin, subagente e hilo escriben bajo `<git-common-dir>/foreman/`; `git status` limpio; misma ruta desde el worktree | `<gitdir>/foreman/<plan>/` confirmado; no hace falta el respaldo `.claude/foreman/` | F1 |
| Fin de turno (A-08) | F0-5 | `background`: `turn_duration`. Hilo abierto en la app: `status: idle` + `end_turn` | F2 |
| Worktree (D-71) | F0-6, §0.3 | Confirmado tal cual: worktree en `.claude/worktrees/foreman-<slug>`, `.git/info/exclude`, `bgIsolation: none`; el transcript del hilo vive en la carpeta de proyecto del worktree | F4 |
| Permisos del hilo (M7) | F0-9 | Confirmado: `--settings` con el `permissions.allow` de `$.settings.read()` | F2 |

Lo que se propone al revisor como decisiones nuevas (en `docs/DECISIONES.md`, D-83 a D-88): D-83 (`cwd` del subagente), D-84 (revisor y supervisor como procesos, **pide OK**), D-85 (driver `background` + Open, **pide OK** por la respuesta 3 del Anexo C), D-86 (avisos), D-87 (`session.start` sin superficie en la app), D-88 (datos de API menores).
