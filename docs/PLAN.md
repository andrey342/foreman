# Plan: `foreman` — mi propio "Projects" como mod de Claude Code

Fecha: 2026-10-09. Autor del plan: Fable 5.1 (chat revisor de MSG). Estado: **LISTO PARA IMPLEMENTAR** en un chat nuevo.

> Objetivo en una frase: que el ciclo que hoy hago a mano entre chats (planificar → pedir prompt → implementar en otro chat → revisar con Fable en el original → volver a implementar) lo coordine un plugin de Claude Code que funcione en **cualquier repo**, usando **mi máquina** (GitNexus, Docker, hooks) y **mi suscripción Max 5x (100 $)** sin dispararla.

---

## 0. Instrucciones para el chat que lo implemente

| Qué | Valor |
|---|---|
| Modelo implementador | **Opus 5.5, effort `high`** (xhigh solo en la fase 4, la máquina de estados). Es TypeScript contra una API nueva y extensa (`claude-code.d.ts`, ~21.000 líneas): hace falta leer tipos con cuidado e iterar con `claude plugin validate`; Sonnet se pierde en la API, Fable es caro para picar código. |
| Modelo revisor | **Fable 5.1, effort `high`**, chat aparte (el patrón de siempre), al cerrar las fases 2, 4 y 6. |
| Dónde abrir el chat | Carpeta **nueva** `C:\Users\javi-\source\repos\foreman` (repo git propio, público en GitHub como `andrey342/foreman`; **no** es un repo de MSG, así que la regla de «no usar rutas a `source\repos`» de `C:\MSG\CLAUDE.md` no aplica). Segundo terminal en `C:\MSG` para probarlo con `claude --plugin-dir C:\Users\javi-\source\repos\foreman`. |
| Primer mensaje del chat | «Lee `C:\MSG\docs\plans\plan-foreman-mod-claude-2026-10-09.md` y ejecútalo fase a fase. Carga la skill `plugin-authoring` antes de escribir el primer archivo. Nivel N1 directo: paradas cerradas (§10), sin matrices ni ledgers. Al cerrar cada fase, commit y una línea de evidencia por criterio de aceptación.» |
| Skills a cargar en ese chat | `plugin-authoring` (obligatoria, trae los tipos del build), `claude-api` solo si toca `$.model.complete`. |
| Idioma | El plugin se publica para terceros: **comandos, UI, código, README y `DECISIONES.md` en inglés** (`/foreman cycle`, `/foreman review`…). El README lleva además una sección «En español» con el resumen y la instalación. Este plan y la comunicación conmigo, en español. |
| Publicación | Repo **público** `andrey342/foreman` con descripción («Coordinate long-running Claude Code work as background threads: implement → review → apply, from one chat»), topics (`claude-code`, `claude-code-plugin`, `agents`, `workflow`), licencia MIT y el README de §9 Fase 6. **Autorización ya concedida (2026-10-09):** crear el repo público `andrey342/foreman` con `gh repo create --public`, hacer `git push -u origin main` al cerrar la Fase 2 y un push por cada fase cerrada, y publicar el tag/release `v0.1.0` en la Fase 6. No pedir confirmación para nada de esto. Siguen prohibidos sin orden explícita: force-push, borrar el repo y tocar cualquier repo de MSG. |

Reglas del plan: el `claude-code.d.ts` del build manda sobre este documento. Si un detalle de la API aquí escrito no coincide con los tipos, gana el `.d.ts`, se anota en `docs/DECISIONES.md` del plugin y se sigue. No se reabre el diseño salvo que una fase quede inconstruible.

---

## 1. Análisis: qué hago hoy y dónde pierdo el tiempo

Flujo real de los últimos runs de MSG (`.agents/runs/20261006-fase2-p4-p5-duplicacion`, memoria del puente Codex↔Claude, skills `msg-*`):

1. **Planifico** en un chat (`msg-planning`, plan grounded + `verify-grounding.mjs`, revisión del plan por un Critic).
2. **Pido un prompt** (`msg-codex-create-prompt`) y lo **copio a otro chat** implementador (Opus 5.5 xhigh / Sonnet).
3. El implementador trabaja horas; escribe `handoff.md`, `report.md`, `parada-1-A.md`.
4. Vuelvo al chat original y **pido la revisión** (Fable 5.1 high) → `review-parte-A.md` con hallazgos C-01…C-13 y veredicto.
5. **Copio** la revisión al implementador → aplica → otra vez al revisor.
6. Entre medias: el agente se **para y espera** (Codex no sondeaba el buzón: «el usuario debe decirle lee X y continúa»); yo tengo que **darme cuenta** de que terminó; tras compactar, el contexto se pierde (lo mitiga el hook `run-state-hook.ps1`).

Dolores concretos que el mod elimina:

| Dolor | Qué lo resuelve |
|---|---|
| Copiar prompts y revisiones entre chats | El mod lanza el hilo implementador con el prompt compuesto y le reenvía la revisión él solo. |
| No enterarme de que un hilo acabó o se bloqueó | Panel con estados (`Trabajando / Listo para revisar / Esperando tu respuesta / Cerrado`) + toast + línea de estado. |
| El agente parado sin que nadie lo despierte | El mod vigila `claude agents --json` y reanuda el hilo con el siguiente paso del ciclo. |
| Repetir el mismo contexto en cada chat | Perfil por repo (`.claude/foreman.json`) + brief por rol: se escribe una vez. |
| Decidir modelo/effort cada vez | El perfil fija modelo y effort por rol y por nivel N1/N2/N3. |
| Perder el estado al compactar o cerrar el chat | Estado en `$.store` + `foreman.json` del run; los hilos son procesos aparte y siguen vivos. |
| Gastar de más | Coordinador sin modelo, un implementador a la vez, Opus `high` (no xhigh) por defecto, Sonnet para N1/QA, Fable solo para revisar. |

Lo que **no** cambia: las reglas de los repos, las skills `msg-*`, el run (`handoff.md` + `report.md`), las paradas cerradas y que el push/PR lo autorizo yo.

---

## 2. Decisiones de diseño (con el porqué)

### D1. Hilos = sesiones `claude --bg`, no subagentes ni procesos propios
`claude --bg "<prompt>"` arranca una sesión en segundo plano y devuelve un id; `claude agents --json` la lista con `state` (`done` / `blocked` / `stopped`), `status` (`waiting` / `idle`), `waitingFor`, `name`, `sessionId`, `cwd`; `claude attach <id>` la abre en un terminal para dirigirla; `claude logs <id>` imprime su salida; `claude stop <id>` la para y `--resume <sessionId>` la continúa. **Es exactamente la primitiva de hilo de Projects, ya hecha por Anthropic**, y corre en mi máquina (GitNexus, Docker, hooks y `.claude/settings.json` del repo aplican).

Un subagente (`$.agent.spawn`) muere con el turno, no se puede abrir a mitad y vive dentro del contexto del chat. Un proceso `claude -p` lanzado por el mod muere al recargar el módulo. Las sesiones `--bg` no tienen ninguno de los dos problemas.

### D2. Subagentes solo para roles cortos y frescos
Revisor, Critic, triage y resúmenes: `$.agent.register` + `$.agent.spawn`, con modelo/effort propios, **sin contexto del chat** (es lo que exige `msg-independent-acceptance`: la independencia viene de arrancar fresco), de solo lectura, y su respuesta cae en el chat principal vía `turn.complete`. Opción `--hilo` para hacerlos como sesión `--bg` si la revisión es muy larga.

### D3. Coordinador determinista (0 tokens)
En Projects el coordinador es un modelo que cobra por enrutar. Aquí el enrutado son comandos `/foreman …` y una máquina de estados en TypeScript. El modelo solo se paga cuando trabaja. `$.model.complete` con Haiku `low` queda como opción (apagada por defecto) para resumir el log de un hilo en una línea del panel.

### D4. Modelos y effort para una Max 5x (100 $)

| Rol | Modelo | Effort | Por qué |
|---|---|---|---|
| Planificador | Opus 5.5 | high | Planes grounded; Fable solo si pido «audita el plan». |
| Implementador N2/N3 | Opus 5.5 | **high** | xhigh solo a petición: el coste sube mucho y el ciclo con revisor compensa. |
| Implementador N1 / docs / tests | Sonnet 5.5 | high | Más barato en el límite del plan; paquetes correctivos con el «cómo» decidido. |
| Revisor / Critic | Fable 5.1 | high | Es el más capaz y el patrón que ya me funciona; solo lectura, diff acotado → corto. |
| QA | Sonnet 5.5 | medium | Recorridos Playwright, matriz cerrada. |
| Resumen de panel (opcional) | Haiku 4.5 | low | Una línea por hilo. |

Reglas de presupuesto en el perfil: `maxParallelThreads: 1` por defecto (serie; además la VM de 8 GB no soporta builds paralelos), `maxReviewCycles: 2`, y el panel muestra tokens por hilo leídos del transcript (`usage` de cada `result`). Si un hilo choca con el límite de uso, el mod lo marca `Límite` y reintenta al reset con `$.clock.after`.

### D5. Reutilizable en cualquier repo
El plugin es genérico; lo específico va en **`.claude/foreman.json`** del repo (perfil). Sin perfil, `/foreman init` genera uno por defecto detectando el repo (git root, `package.json` / `*.sln` / `pyproject`) y lo deja para editar. El perfil de MSG referencia sus scripts (`new-run.ps1`, gates) y sus skills por rol. Instalación: `/plugin install foreman --marketplace andrey342/foreman` (scope `user`), así vale en todos los repos.

### D6. Estado y archivos
- Estado del mod: `$.state` (UI, por sesión) y `$.store` (persistente, 4 MiB): registro de hilos, ciclo activo, contadores.
- Por run: `<runsDir>/<runId>/foreman.json` (registro legible por humanos y por otros chats) + los archivos que ya existen (`handoff.md`, `report.md`, `review-<parte>-r<n>.md`).
- Nunca se guardan secretos ni se escribe fuera de `runsDir` y `$.store`.

### D7. Nombre
Plugin **`foreman`** (el capataz: reparte el trabajo, vigila y avisa); comando `/foreman`; perfil `.claude/foreman.json`; sesiones `foreman:<run>:<role>-<part>`. Elegido el 2026-10-09 frente a `hilos`, `loom`, `relay`, `dispatch`, `conductor`: describe el rol del mod, es corto y no choca con proyectos OSS conocidos. (Evito «projects» para no confundirlo con los Projects de claude.ai.)

### D8. Todo opcional, con default: nunca falla en un repo sin configurar
Regla dura: **cada clave del perfil es opcional y tiene un valor por defecto**; el mod debe funcionar en un repo sin `.claude/foreman.json` exactamente igual que con el perfil por defecto. Sin perfil: roles con los modelos de D4 y sin skills, `runsDir = .claude/runs` (se crea al primer uso), sin guards, sin `onRunCreate`, `injectHandoff: true`, `claude` resuelto del PATH, `repos = [.]`. Un perfil inválido (JSON roto, clave desconocida, modelo no válido) produce **un aviso** con la clave y cae al default de esa clave; nunca bloquea un comando. Una skill listada que no existe en el repo se omite con aviso. Un script de `hooks`/`gates` que no existe se omite con aviso. Esto se cubre con tests en la Fase 1 (perfil ausente, vacío, roto, con claves desconocidas) y se comprueba en la Fase 6 en `foreman-demo`.

---

## 3. Arquitectura

```
C:\Users\javi-\source\repos\foreman\
├── .claude-plugin\plugin.json          name=foreman, version, userConfig (globales), types
├── .claude-plugin\marketplace.json     { plugins:[{name:"foreman", source:"./"}] }
├── hooks\hooks.json                    { "modules": ["./register.tsx"] }
├── hooks\register.tsx                  registra comandos, hooks y timers (entrada)
├── hooks\lib\profile.ts                carga/valida .claude/foreman.json + defaults
├── hooks\lib\threads.ts                wrapper de `claude --bg/agents/logs/stop/--resume`
├── hooks\lib\transcript.ts             lee ~/.claude/projects/<cwd>/<sessionId>.jsonl, extrae fence de resultado y usage
├── hooks\lib\cycle.ts                  máquina de estados implementar→revisar→aplicar
├── hooks\lib\roles.ts                  compone el brief por rol desde prompts/ + perfil
├── hooks\lib\guards.ts                 tool.call genéricos (requiere-herramienta-antes-de-editar, rutas prohibidas)
├── hooks\ui\pane.tsx                   panel Overview
├── hooks\ui\band.tsx                   banda sobre el prompt (1 línea: ciclo activo / esperando)
├── hooks\*.test.ts                     claude plugin test
├── agents\reviewer.md  critic.md  triage.md  qa.md   (tipos foreman:<role>; modelo/effort los sobreescribe el perfil)
├── prompts\implementer.md  reviewer.md  critic.md  planner.md  (plantillas con {{placeholders}})
├── profiles\default.json  msg.json     perfiles de ejemplo
├── types\index.d.ts                    contrato PluginState (hilos, ciclo)
├── docs\PLAN.md (copia de este)  DECISIONES.md  SPIKE.md
└── README.md                           instalación, comandos, perfil
```

### Hooks que usa y para qué

| Hook / API | Uso |
|---|---|
| `session.start` | registra `/foreman`, carga el perfil, restaura el registro desde `$.store`, arranca `$.clock.every(30 s)` del vigilante, actualiza la línea de estado. |
| `command.run { command:'foreman' }` | parsea subcomando y despacha. |
| `$.process.run([claudeExe, '--bg', …])` | lanzar/reanudar/parar hilos, `claude agents --json`, `claude logs`. Sin shell: argv. `claudeExe` se resuelve en el spike (en Windows es un `.cmd`/exe; usar ruta completa). Para scripts del perfil: `['powershell.exe','-NoProfile','-File', …]`. |
| `$.agent.register` + `$.agent.spawn` + `turn.complete` | roles subagente; la respuesta se espera por `agentId` (`got[e.agentId](e.answer)`). |
| `$.fs` | leer/escribir `foreman.json`, reviews, transcripts (≤ 4 MiB: leer solo la cola del jsonl si es grande → spike). |
| `$.state` / `$.store` | estado de UI / persistente. |
| `ui.render Pane` + `$.ui.open` | panel. `AbovePrompt` para la banda. `$.ui.status` para la línea de estado. `$.ui.toast` avisos. `$.ui.copy` para copiar `claude attach <id>`. |
| `prompt.compose` | inyecta una sección `session` corta: run activo, hilos en espera (desactivable en el perfil; MSG ya inyecta el handoff con su hook PS1, así que `injectHandoff:false`). |
| `tool.call` (+ `.catch`) | guards genéricos del perfil (D8). |
| `$.prompt.submit` | solo para `/foreman review --deep`: encola «ejecuta el workflow foreman-review» en el chat principal (fase 6). |

### Modelo de datos (`types/index.d.ts` y `foreman.json`)

```ts
type Role = 'planner'|'implementer'|'reviewer'|'critic'|'qa'|'triage'|'free'
type ThreadState = 'working'|'ready'|'waiting'|'blocked'|'limit'|'done'|'stopped'|'failed'
type Thread = { id: string; sessionId: string; name: string; role: Role; runId?: string; part?: string;
  cwd: string; model: string; effort: string; startedAt: string; updatedAt: string; state: ThreadState;
  waitingFor?: string; lastResult?: ThreadResult; usage?: { input: number; output: number; cacheRead: number; turns: number } }
type ThreadResult = { status: 'done'|'blocked'|'question'|'failed'; summary: string; commits?: string[];
  gates?: { cmd: string; exit: number }[]; question?: string; files?: string[] }
type Cycle = { runId: string; part: string; plan: string; level: 'N1'|'N2'|'N3'; implThread: string;
  reviews: { n: number; file: string; verdict: 'OK'|'NO'|'BLOCKED'; findings: number }[];
  phase: 'implementing'|'reviewing'|'applying'|'ready'|'waiting'|'closed'; maxCycles: number }
interface PluginState { foreman: { threads: Thread[]; cycle?: Cycle; paneOpen: boolean } }
```

**Contrato de resultado de un hilo** (lo exige el brief, lo parsea `transcript.ts`): el hilo termina su turno con un bloque

````
```foreman-result
{ "status": "done", "summary": "…", "commits": ["3dfb3199"], "gates": [{"cmd":"dotnet test …","exit":0}] }
```
````

Si falta el bloque, el estado se infiere de `claude agents --json` y se marca `sinResultado` (nunca se inventa un `done`).

---

## 4. Comandos

| Comando | Qué hace |
|---|---|
Comandos y flags en inglés (producto público). Roles: `planner`, `implementer`, `reviewer`, `critic`, `qa`, `triage`, `free`.

| Comando | Qué hace |
|---|---|
| `/foreman` | abre/cierra el panel. |
| `/foreman init` | crea `.claude/foreman.json` por defecto (detecta repo) o valida el existente. |
| `/foreman status` | tabla en el transcript: hilo · rol · estado · desde · tokens · siguiente acción. |
| `/foreman launch <role> "<task>" [--run <id>] [--part A] [--model m] [--effort e] [--level N2]` | compone el brief del rol y arranca `claude --bg --name "foreman:<run>:<role>-<part>" --model … --effort … --permission-mode <perfil> "<brief>"`. |
| `/foreman cycle <plan.md> --part A [--level N2] [--cycles 2]` | el flujo completo de §5. |
| `/foreman review [--part A] [--base <ref>] [--thread] [--deep]` | revisor fresco (subagente; `--thread` como sesión bg; `--deep` vía workflow). Escribe `review-<part>-r<n>.md` en el run. |
| `/foreman critic [--plan <md>]` | `msg-independent-acceptance`-style: Critic fresco, veredicto PASS/FAIL/BLOCKED. |
| `/foreman tell <thread> "<message>"` | reanuda el hilo con un mensaje (respuesta a una pregunta, nueva orden). |
| `/foreman open <thread>` | imprime y copia `claude attach <id>`; en desktop abre `claude --desktop --resume <sid>` si existe. |
| `/foreman log <thread> [n]` | últimas n líneas de `claude logs`. |
| `/foreman stop <thread>` / `/foreman close <thread>` | `claude stop` / marcar `done` y retirar del panel (no borra la sesión). |
| `/foreman night on|off` | modo noche: encadena partes sin pausa si el plan no la exige, ciclos máximos ↑, notificaciones acumuladas. Las paradas cerradas siguen parando. |
| `/foreman profile` | muestra el perfil efectivo (defaults + repo). |

---

## 5. El ciclo (`cycle.ts`)

```
lanza(implementador, plan, parte)
   │
   ▼
[implementing] ── vigilante cada 30 s: claude agents --json + fence del transcript ──┐
   │ done                                   │ blocked/question           │ limit
   ▼                                        ▼                            ▼
[reviewing] spawn revisor fresco      [waiting] toast + panel        [limit] reintento al reset
   │ escribe review-<parte>-r<n>.md   usuario: /foreman tell …           ($.clock.after)
   ▼
veredicto OK ──────────────► [ready] toast «Parte A lista»; en modo noche → siguiente parte
veredicto NO y n < maxCycles ► [applying] resume implementador: «aplica review-<parte>-r<n>.md: corrige o refuta con evidencia; termina con foreman-result» → [implementing]
veredicto NO y n == maxCycles ► [waiting] «ciclos agotados: decide tú»
veredicto BLOCKED ───────────► [waiting]
```

Invariantes:
- Un solo ciclo activo por run; un solo implementador vivo si `maxParallelThreads = 1`.
- El mod **no escribe código ni docs de producto**: escribe `foreman.json` y la review que devuelve el revisor. El run (`handoff.md`, `report.md`) lo mantiene el hilo, como hoy.
- Paradas cerradas del hilo (las de `msg-implement-plan` §2) se respetan: `blocked`/`question` ⇒ `waiting`, nunca se auto-responde.
- Al reanudar un hilo se reenvía solo la **ruta** de la review (no su texto) para no inflar el contexto.
- Toda transición se registra en `foreman.json` con hora, y el panel la refleja.

---

## 6. Perfil `.claude/foreman.json`

```jsonc
{
  "version": 1,
  "runsDir": ".claude/runs",                 // MSG: ".agents/runs"
  "claudeExe": null,                          // null = resolver del PATH
  "repos": [{ "name": "root", "path": "." }], // MSG: raíz + 2 submódulos
  "roles": {
    "implementer": { "model": "opus", "effort": "high", "permissionMode": "auto",
                     "byLevel": { "N1": { "model": "sonnet" } },
                     "skills": ["msg-implement-plan", "msg-run-state"],
                     "extra": "Raíz canónica C:\\MSG. Backend: gitnexus_impact antes de tocar .cs." },
    "reviewer": { "model": "fable", "effort": "high", "kind": "subagent", "tools": ["Read","Grep","Glob","Bash"],
                  "skills": ["msg-back-review", "msg-front-code-review"], "contract": "prompts/reviewer.md" },
    "critic":   { "model": "fable", "effort": "high", "kind": "subagent", "skills": ["msg-independent-acceptance"] },
    "qa":       { "model": "sonnet", "effort": "medium", "skills": ["msg-qa-tester"] },
    "planner":  { "model": "opus", "effort": "high", "skills": ["msg-planning"] }
  },
  "gates": { "backend": ["powershell.exe -NoProfile -File scripts/test-backend-conventions.ps1"], "frontend": ["npm run lint"] },
  "guards": [
    { "when": { "tool": "Edit|Write", "pathGlob": "**/*.cs" }, "requireToolCalledBefore": "mcp__gitnexus__impact", "mode": "warn" },
    { "when": { "tool": "Bash", "commandRegex": "git\\s+add\\s+-A" }, "mode": "deny", "reason": "Rutas explícitas, nunca git add -A" }
  ],
  "limits": { "maxParallelThreads": 1, "maxReviewCycles": 2, "serialBuilds": true },
  "hooks": { "onRunCreate": "powershell.exe -NoProfile -File .agents/skills/msg-run-state/scripts/new-run.ps1 -RunId {{runId}} -Repos MSG,Backend,Frontend -JoinBranch" },
  "injectHandoff": false,                     // MSG ya lo inyecta con run-state-hook.ps1
  "notify": { "toast": true, "command": null } // p. ej. un script de notificación de Windows
}
```

`profiles/default.json` trae: `runsDir .claude/runs`, roles con los modelos de D4 sin skills, sin guards, `injectHandoff: true`. `profiles/msg.json` es el de arriba completo; en la fase 5 se copia a `C:\MSG\.claude\foreman.json`.

---

## 7. Briefs por rol (`prompts/*.md`)

Plantillas cortas con placeholders `{{plan}}`, `{{parte}}`, `{{nivel}}`, `{{runId}}`, `{{runsDir}}`, `{{extra}}`, `{{skills}}`, `{{reviewFile}}`. Principios: decir **qué** y **cómo se verifica**, no repetir las reglas del repo (las carga el CLAUDE.md del repo y las skills).

**implementer.md** (núcleo):
- Encargo: ejecutar `{{plan}}` parte `{{parte}}` a nivel `{{nivel}}` con las skills `{{skills}}`.
- Run `{{runId}}` en `{{runsDir}}`: mantener `handoff.md` y `report.md`.
- Paradas cerradas (las 4 de `msg-implement-plan` §2); todo lo demás se resuelve y se anota.
- Nada de push/PR/merge sin autorización escrita en el encargo.
- Al terminar o parar: bloque `foreman-result` (§3) como último contenido del turno.
- Si llega un mensaje «aplica `{{reviewFile}}`»: corregir o refutar cada hallazgo con evidencia (`archivo:línea`, comando y exit), repetir los gates afectados, actualizar `report.md`, terminar con `foreman-result`.

**reviewer.md**: contrato de `msg-independent-acceptance/references/review-contract.md` adaptado: diff `{{base}}..HEAD` de los repos del perfil, solo lectura, sin ejecutar gates que muten, hallazgos `C-nn · P1/P2/P3 · archivo:línea · escenario · corrección · verificación`, **veredicto `OK`/`NO`/`BLOCKED` en la primera línea** y JSON final `{"verdict":"NO","findings":13,"file":"<ruta escrita>"}`. Escribe el archivo él mismo (`Write` permitido solo en `runsDir`; lo vigila un guard).

**critic.md**, **planner.md**: análogos; el planificador termina con la ruta del plan y el resultado de `verify-grounding` si el perfil lo define.

---

## 8. Guards genéricos (D8)

`guards.ts` implementa dos tipos a partir del perfil:
1. `requireToolCalledBefore`: lleva en `$.state` las herramientas llamadas en la sesión (hook `tool.call` con `next` y registro); al editar una ruta que casa con `pathGlob` sin haber llamado la requerida, `mode: warn` ⇒ `$.ui.toast` + `session.append` de una nota al modelo; `mode: deny` ⇒ `{ deny }`. Siempre con `.catch(($,e,next)=> next.called ? next(e) : { deny })`.
2. `commandRegex` / `pathGlob` con `deny`: bloqueo directo con motivo.

Esto sustituye al `gitnexus-guard.js` actual de forma declarativa; el de MSG se mantiene hasta que el perfil lo cubra (fase 5), y entonces se retira de `settings.local.json`.

---

## 9. Fases, criterios de aceptación y tests

Cada fase = un commit (o varios por hito) en `C:\Users\javi-\source\repos\foreman`, `claude plugin validate .` y `tsc -p .` en verde, tests de la fase con `claude plugin test .`.

### Fase 0 · Spike (medio día) — sin esta fase no se escribe el mod
Comprobar con comandos reales y anotar en `docs/SPIKE.md` exactamente lo que funcionó:
1. `claude --bg --name "foreman:spike" --model sonnet --effort low --permission-mode auto -p "escribe hola en spike.txt"`: qué imprime (id), qué aparece en `claude agents --json` y en qué `state` termina.
2. Cómo se **envía un mensaje** a una sesión bg terminada/parada: probar `claude --bg --resume <sessionId> "<texto>"`; si no entrega el texto, probar `claude stop <id>` + `claude -p --resume <sessionId> --output-format json "<texto>"`. Documentar la que funciona; es la primitiva de `/foreman tell` y de `applying`.
3. Ruta del transcript: confirmar `~/.claude/projects/C--MSG/<sessionId>.jsonl` (cwd con separadores → `-`) y la forma de los mensajes `result` (campo `usage`) y del último texto del asistente (para el fence).
4. En un mod mínimo: `$.process.run` con el ejecutable de `claude` en Windows (ruta completa; `where claude`), `$.agent.spawn` de un tipo registrado + espera por `turn.complete`, `$.ui.open` de un panel con un botón, `$.store` tras recargar.
5. Qué pasa con `--permission-mode auto` ante una herramienta no permitida (¿`blocked` + `waitingFor: "dialog open"`?) y cómo se ve en el JSON.

Aceptación: `docs/SPIKE.md` con los 5 puntos y los comandos literales; decisión escrita de la primitiva de «mensaje a hilo».

### Fase 1 · Esqueleto, perfil y panel de solo lectura
- `plugin.json`, `hooks.json`, `register.tsx`, `types/index.d.ts`, `profile.ts` (defaults + validación + `/foreman init|perfil`).
- Panel (`pane.tsx`) que lista `claude agents --json` filtrado por `cwd` del repo, agrupado por estado; botón «Actualizar»; `$.ui.status("foreman: 2 trabajando · 1 espera")`.
- Tests: perfil (defaults, inválido, merge por nivel), render del panel en `terminal` y `desktop` con `$.process.run` mockeado.
Aceptación: `claude --plugin-dir C:\Users\javi-\source\repos\foreman` en `C:\MSG` muestra en el panel las sesiones bg existentes con su estado.

### Fase 2 · Hilos
- `threads.ts`: `launch(role, brief, opts)`, `send(thread, text)`, `stop`, `logs`, `list()`; nombres `foreman:<run>:<role>-<part>`.
- `transcript.ts`: lectura de la cola del jsonl (chunks, ≤ 4 MiB), parse del fence, suma de `usage`.
- Comandos `lanza`, `di`, `abre`, `log`, `para`, `cierra`, `estado`. Registro en `$.store` + `foreman.json` del run si hay run.
- Vigilante `$.clock.every(30 s)`: sincroniza estados, detecta fence, toast en cambios `working→ready/waiting`.
- Tests: parse del fence (con y sin bloque, JSON roto), máquina de sincronización con JSON de `agents` simulado, `send` según la primitiva del spike.
Aceptación: desde `C:\MSG`, `/foreman launch free "lista los archivos de docs/plans"` crea la sesión, el panel la ve pasar a `done`, `/foreman log` la muestra, `/foreman tell` la reanuda y responde. **Revisión Fable al cerrar.**

### Fase 3 · Roles como subagentes
- `agents/*.md` + `$.agent.register` con modelo/effort/tools del perfil (el perfil sobreescribe el frontmatter).
- `roles.ts`: composición del brief desde `prompts/` + perfil; `/foreman review` y `/foreman critic`: spawn, espera por `agentId`, parse del JSON final, comprobación de que el archivo existe en `runsDir`, registro en `foreman.json`.
- Guard: el revisor solo puede `Write` dentro de `runsDir` (guard `pathGlob` + `deny`).
- Tests: composición de briefs, espera por `turn.complete` (mock), parse de veredicto.
Aceptación: `/foreman review --part A --base origin/develop` sobre el run actual de MSG produce `review-A-r2.md` con veredicto en la primera línea, sin tocar código.

### Fase 4 · Ciclo (effort xhigh recomendado)
- `cycle.ts` con la máquina de §5, persistida en `$.store`/`foreman.json`, reanudable tras cerrar y abrir el chat (`session.start` la recupera y el vigilante continúa).
- `/foreman cycle`, `/foreman night`, transiciones `limit` (detección en logs de «usage limit»/«rate limit» + reintento programado).
- Notificaciones: toast + `notify.command` del perfil.
- Tests: tabla de transiciones completa (done/NO/OK/BLOCKED/blocked/limit/ciclos agotados), reanudación tras recarga, un solo implementador vivo.
Aceptación: ciclo de prueba en un repo de juguete (`C:\Users\javi-\source\repos\foreman-demo`, un repo con un bug sembrado y un plan de 3 líneas): implementa → revisa (NO) → aplica → revisa (OK) → `ready`, sin intervención. **Revisión Fable al cerrar.**

### Fase 5 · Perfil MSG y guards
- `guards.ts` (§8) + tests.
- `profiles/msg.json` → `C:\MSG\.claude\foreman.json`; `onRunCreate` con `new-run.ps1 -DryRun` primero.
- Comprobar que un hilo lanzado desde `C:\MSG` carga las skills `msg-*`, GitNexus y el hook `run-state-hook.ps1` (están en el repo: deben aplicar).
Aceptación: en MSG, `/foreman launch implementer "N1: añade una línea a docs/shared/business/08-known-limitations.md (prueba) y termina"` respeta el guard de rutas, escribe `report.md` y devuelve `foreman-result`; el guard `git add -A` deniega.

### Fase 6 · Pulido y publicación
- Panel: tokens por hilo, última línea del log, botones `Abrir` (copia `claude attach`), `Revisar`, `Responder`.
- `/foreman review --deep`: workflow guardado `.claude/workflows/foreman-review.js` (N revisores por dimensión + verificación adversarial), lanzado con `$.prompt.submit`. Solo si el usuario tiene `Workflow` disponible.
- `marketplace.json`, `LICENSE` (MIT), `docs/DECISIONES.md`, y el **README público** con esta estructura (en inglés, con sección final «En español»):
  1. Una frase + GIF/captura del panel (grabar con `claude --bg` real).
  2. *Why*: el problema (coordinar chats a mano) en 4 líneas y cómo se compara con Claude Code Projects, sin exagerar: Projects también puede ejecutar hilos en tu máquina vía Remote Control («Work locally»), pero su coordinador es un modelo que cobra por enrutar, el ciclo implementar→revisar no es determinista y los hilos locales solo corren con el PC despierto; `foreman` es 100 % local, coordina con código (0 tokens) y fija el ciclo, los modelos y el coste por perfil.
  3. *Install* en 3 pasos copiables: `/plugin install foreman --marketplace andrey342/foreman` → `y` → scope `user`; versión mínima de Claude Code probada; Windows/macOS/Linux.
  4. *Quick start* (5 minutos): `/foreman init`, `/foreman launch implementer "..."`, `/foreman status`, `/foreman open`.
  5. *The cycle*: diagrama de §5 y el contrato `foreman-result`.
  6. *Commands*: la tabla de §4.
  7. *Profile reference*: cada clave, su default y un ejemplo mínimo + el ejemplo completo de MSG como «advanced».
  8. *Models & cost*: la tabla de D4 y los límites (`maxParallelThreads`, `maxReviewCycles`).
  9. *How it works* (para curiosos): sesiones `--bg`, subagentes frescos, estado en `$.store`.
  10. *Limitations*, *Troubleshooting* (hilo `blocked` por diálogo, límite de uso, perfil inválido), *Contributing*, *License*.
- `claude plugin eval` con 3 casos (launch, review, cycle con NO→OK).
- Repo público en GitHub con descripción y topics (ver §0 «Publicación»); release `v0.1.0` con tag.
Aceptación: instalado en scope `user` desde el repo GitHub **en una máquina/perfil limpio** (o `claude --safe-mode` + solo este plugin); funciona en `C:\MSG` y en `C:\Users\javi-\source\repos\foreman-demo` sin cambios; una persona que solo lea el README puede instalarlo y lanzar su primer hilo. **Revisión Fable final.**

---

## 10. Paradas cerradas del chat implementador

Solo se para por: (1) el spike demuestra que no hay forma de enviar un mensaje a una sesión bg (entonces se propone la alternativa `claude -p --resume` y se espera OK); (2) una llamada de `$` que el `.d.ts` del build no expone (anotar y buscar equivalente; parar solo si no lo hay); (3) algo que requiera credenciales nuevas o una escritura externa distinta de las ya autorizadas en §0 «Publicación» (crear el repo, push por fase, release). Todo lo demás se decide, se anota en `DECISIONES.md` y se sigue.

---

## 11. Riesgos y gotchas conocidos de la API

- `$.agent.spawn` resuelve **al arrancar**, no al terminar: la respuesta llega por `turn.complete` con `agentId`.
- Un hook tiene presupuesto de tiempo: nada de esperas largas dentro de un hook; las esperas van en `$.clock.every/after` desde `session.start`.
- Variables de módulo se pierden al recargar: todo en `$.state` (UI) y `$.store` (persistente).
- `$.process.run`: sin shell, 10 min máximo, salida ≤ 4 MiB; `claude logs` con `n` acotado.
- `$.fs.read` ≤ 4 MiB: los transcripts crecen; leer la cola.
- Guards siempre con `.catch`; un hook que falla sin `.catch` se salta y el guard no guarda.
- `ui.render` nunca escribe estado; los botones escriben con `update($, ref, fn)`.
- `prompt.compose`: sección `session`, corta, estable (si cambia en cada turno rompe la caché).
- La API es *early access*: fijar la versión de Claude Code probada en el README y re-validar al actualizar.
- Sesiones `--bg` con `permission-mode auto` pueden quedar `blocked` por un diálogo: el panel lo muestra con `waitingFor` y `/foreman open` es la salida.
- Windows: PS 5.1 sin `&&`; usar argv y `powershell.exe -NoProfile -File`.

---

## 12. Fuera de alcance (posibles extensiones)
- Hilos en la nube (`create_session`/Remote Control): el mod podría añadir `--nube` más adelante; hoy todo es local a propósito.
- Vigilar PRs y arreglar CI solo (lo hace Projects): aquí el push sigue siendo manual.
- App móvil / notificaciones push: solo toast + comando de notificación del perfil.
- Un coordinador con modelo que entienda texto libre («pega aquí el stack trace»): si hace falta, `/foreman triage "<texto>"` lanza el rol triage; no se enruta texto libre.

## 13. Decisiones registradas
D1–D8 de §2 y §8. Cualquier cambio se anota en `docs/DECISIONES.md` del plugin con fecha y motivo.
