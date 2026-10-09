Veredicto: NO

# Revisión independiente · Fases 1 y 2 de `foreman`

- Fecha: 2026-10-09. Revisor: Opus 5.5 (chat aparte, sin participar en la implementación).
- Commits revisados: `d9afcb6` (Fase 1) y `d6324f0` (Fase 2). Diff: `a8832b9..d6324f0`.
- Autoridades: `docs/PLAN.md` (idéntico a `C:\MSG\docs\plans\plan-foreman-mod-claude-2026-10-09.md`, comprobado con `diff`) para el comportamiento; `.claude-plugin/types/claude-code/index.d.ts` (escrito por Claude Code 2.1.296) para la API.
- El veredicto es NO por el P1 (C-01). Los criterios de aceptación tienen evidencia real: ver la corrección de la sección de criterios.
- **Corrección (2026-10-10).** En la primera versión de este informe di por no evidenciados el panel en vivo (1.4, 2.6) y el vigilante (2.4). Sí están: el chat implementador abrió un `claude --plugin-dir` interactivo en el panel de terminal y leyó la pantalla. Las capturas están en `~/.claude/projects/C--Users-javi--source-repos-foreman/d9b71730…jsonl`, en las llamadas `mcp__terminal__read_terminal`. Yo no las había visto porque solo leí los transcripts de las sesiones y los commits.

## Comprobaciones ejecutadas

| Comando | Resultado |
|---|---|
| `claude plugin validate .` | `✔ Validation passed`. Hooks: `session.start`, `command.run{command=foreman}`, `ui.render{component=Pane, requestId=foreman}`. State: `foreman.view/threads/warnings`. Env: `CLAUDE_CONFIG_DIR, HOME, OS, USERPROFILE` |
| `npx tsc -p .` | exit 0 |
| `claude plugin test .` | 48 pass, 0 fail (3 archivos) |
| `claude agents --json --all` (solo lectura) | 15 sesiones; en `C:\MSG`: `22801afb` done, `fafcb4f5` done y **`7075eb6d` `state: "failed"`**, los tres llamados `foreman:adhoc:free` |
| Lectura de transcripts de `~/.claude/projects/C--MSG` y `C--Users-javi--source-repos-foreman` | Las ejecuciones reales de `/foreman` de la Fase 2 (ver los criterios) |
| Lectura de `~/.claude/jobs/{22801afb,7075eb6d,fafcb4f5}/state.json` y `timeline.jsonl` | Estado del job tras un `tell` (C-01) y del job fallido (C-03) |
| Transcript del chat implementador (`C--Users-javi--source-repos-foreman/d9b71730…jsonl`), lecturas `read_terminal` | Capturas del panel interactivo en `C:\MSG` (20:49:35Z y 21:04:35Z) y de la línea de estado del vigilante (21:06:21Z → 21:06:37Z) |
| `ls C:\MSG\.claude` | No hay `runs/` ni `foreman.json`: foreman no escribió en `C:\MSG` |
| Tests de reproducción con el kit **en una copia en el scratchpad** (el repo no se tocó) | R1 (C-01), R2 (C-03), R3 (C-04), R4 (C-02) y R5 (C-06) se reproducen. R6 dibuja el panel con la salida real de `claude agents` (criterio 1.4, C-03) |

No ejecuté `claude -p` en `C:\MSG`, no lancé hilos y no hice push.

## Hallazgos

Por severidad: P1 = rompe una invariante dura del plan o bloquea la fase siguiente; P2 = fallo real con un escenario plausible; P3 = robustez, documentación o algo que importará en una fase posterior.

### C-01 · P1 · hooks/register.tsx:201 (y hooks/lib/transcript.ts:81-96, hooks/register.tsx:329-337) · después de un `tell`, el `foreman-result` del turno anterior se toma como resultado del nuevo

- **Qué falla.** `turnOver` exige `row.state !== 'working'`, `row.status !== 'busy'` y `facts.turnEnded`. Ninguna de las dos fuentes cambia en el momento en que se reanuda un hilo:
  - El `state` del job no pasa a `working` al reanudar. `~/.claude/jobs/22801afb/timeline.jsonl` va de `done` (21:02:52.840Z) a `done` (21:03:31.633Z) sin ningún `working` entre medias.
  - La fila del nuevo prompt llega al transcript unos 2,3 s después de que `tell` devuelva el control. La salida del comando local está a 21:03:24.214Z (`C--MSG/59ac5253…jsonl`) y la fila USER a 21:03:26.487Z (`C--MSG/22801afb…jsonl`).
  - En esa ventana `turnEnded` es true por el turno anterior y `lastText` es el texto anterior.
  - Además, `readTranscript` no limita `lastText` a las filas posteriores al último prompt (transcript.ts:85-96).
  - D-17 dice que esta protección existe, pero no cubre esta ventana.
- **Escenario.** Se ejecuta `/foreman tell 1 "…"` y enseguida `/foreman status`, se pulsa Refresh en el panel, o un tick del vigilante cae dentro de la ventana:
  - Un hilo `free` pasa a `done` con el summary anterior. Como `sync` se salta los `done` (register.tsx:195), la respuesta nueva no se lee nunca.
  - Un `implementer` pasa a `ready` con el resultado del turno anterior y se lanza un toast «→ ready». En la Fase 4 eso lanzaría el revisor sobre un trabajo que todavía se está aplicando.
  - Reproducido en el kit (R1). Durante la ventana: `Done`, `1 in · 10 out` (solo el turno 1). Después, con el turno nuevo ya escrito («NEW answer: 5»), sigue en `Done` con el resultado anterior.
- **Corrección esperada.**
  - Al lanzar y en cada `tell`, guardar en el hilo una marca (`sentAt = $.clock.now()`).
  - Leer el fence solo si el transcript tiene un prompt posterior a esa marca y un `turn_duration` posterior a ese prompt.
  - Limitar `lastText` a las filas assistant posteriores al último prompt.
  - Corregir D-17 en `DECISIONES.md`.
- **Cómo se verifica.**
  - Test de kit con transcript mockeado y rutas normalizadas (ver C-07): hilo `free` con el turno 1 cerrado, luego `tell`, fila `{pid, status:'idle', state:'done'}` y transcript todavía sin el prompt nuevo. `status` debe decir `Working`. Al añadir el turno nuevo, `status` debe mostrar el summary nuevo.
  - Test puro: `readTranscript` devuelve `lastText` vacío cuando no hay ninguna fila assistant después del último prompt.

### C-02 · P2 · hooks/register.tsx:85-104 (y :270) · cada sesión guarda su propia copia del registro y pisa la de las demás en `$.store`

- **Qué falla.**
  - `restoreThreads` solo lee `$.store` al arrancar, cuando el estado está vacío.
  - `putThreads` escribe en `$.store` la lista completa de *esta* sesión.
  - Con foreman en scope `user` (D5), cada chat abierto en el repo tiene su propio vigilante y su propia copia. Ahora mismo hay 4 interactivos en `C:\MSG` según `claude agents`.
- **Escenario.**
  - El chat A lanza un hilo. El chat B, abierto antes, escribe su lista en la siguiente sync que tenga cambios, y el hilo de A desaparece de `$.store`. Una sesión nueva ya no lo ve.
  - B nunca ve los hilos de A.
  - Los dos chats lanzan el toast de la misma transición y la añaden dos veces a `foreman.json`.
  - `maxParallelThreads` se cuenta por sesión, así que dos chats pueden tener un implementador vivo cada uno. Eso rompe «un solo implementador vivo», que importa en la VM de 8 GB.
  - Kit (R4): store sembrado con `bbbb0002` y `launch` en una sesión con el estado vacío. El store queda `["aaaa0001"]`.
- **Corrección esperada.**
  - Usar `$.store` como fuente de verdad: en cada `putThreads` y al empezar cada sync, releerlo y fusionar por id (gana el `updatedAt` mayor).
  - Contar `maxParallelThreads` sobre las filas vivas de `claude agents` con nombre `foreman:*` bajo el root.
  - Dar un único dueño a las transiciones (un `owner` por hilo) o deduplicarlas por `(thread, from, to, at)`.
  - Tiene que estar resuelto antes de la Fase 4: con dos máquinas de estado sobre el mismo ciclo sería un P1.
- **Cómo se verifica.**
  - Kit: store sembrado y `launch`; el store conserva los dos hilos.
  - Dos syncs que ven la misma transición dejan una sola entrada en `foreman.json`.
  - Con una sesión que ya tiene un hilo `working` en el store, otra sesión no puede lanzar un segundo.

### C-03 · P2 · hooks/lib/threads.ts:84-111 y hooks/lib/agents.ts:48-53 · el estado `failed` del CLI no está contemplado

- **Qué falla.** `claude agents` devuelve `state: "failed"`, un valor que no aparece en SPIKE §1.
  - Caso real: `7075eb6d`, `foreman:adhoc:free`, lanzado por foreman a las 21:05:33Z. Su `~/.claude/jobs/7075eb6d/state.json` se quedó en `"detail": "starting…"` y no tiene transcript.
  - `syncThread` no tiene rama para `failed`. Sin transcript no hay fence, así que el hilo se queda en `working` para siempre y ocupa el único hueco de `maxParallelThreads`.
  - `findTranscript` recorre todo `~/.claude/projects/*` cada 30 s buscándolo.
  - En el panel, `groupOf` manda `failed` al grupo «Done» y un `blocked` ya terminado (`fcd4c1b7`, sin pid, de hace 3 días) a «Waiting for you».
- **Escenario.**
  - Un `--bg` que no llega a arrancar hace que el siguiente `/foreman launch` responda «maxParallelThreads is 1 and … is still busy», y `/foreman status` muestra `Working` (kit R2).
  - El panel dibujado con la salida real de esta máquina (R6) mete `7075eb6d` en «Done (6)»: muestra como terminada una sesión que falló.
- **Corrección esperada.**
  - `row.state === 'failed'` pasa a hilo `failed`, con un motivo en `waitingFor`.
  - El panel tiene un grupo propio «Failed». Las filas `blocked` sin pid van a «Stopped/Exited».
  - No escanear proyectos para filas sin pid y sin transcript.
  - Añadir el valor `failed` al SPIKE y a DECISIONES.
- **Cómo se verifica.**
  - Test de `syncThread` con `{state:'failed'}` y sin facts: el resultado es `failed`.
  - Test de `groupOf` para `failed` y para `blocked` sin pid.
  - Kit: después de un `failed`, `launch` se acepta.

### C-04 · P2 · hooks/register.tsx:264 (→ :109) · `--run ..` escribe fuera de runsDir y sobrescribe el perfil

- **Qué falla.**
  - La regex `^[A-Za-z0-9._-]+$` admite `..`.
  - Con eso, `recordRun` escribe en `<root>/<runsDir>/../foreman.json`. Con el runsDir por defecto, ese archivo es `<root>/.claude/foreman.json`, es decir, el perfil.
  - Con un runsDir `.agents/runs`, escribe `.agents/foreman.json`.
- **Escenario.**
  - Kit (R3): `/foreman launch free "x" --run ..` deja en el perfil `{runId, updatedAt, threads, transitions}`. El engine normaliza la ruta a `C:\demo\.claude\foreman.json`.
  - A partir de ahí `/foreman profile` muestra 4 avisos de clave desconocida y vuelve todo a los defaults.
- **Corrección esperada.**
  - Usar `^[A-Za-z0-9][A-Za-z0-9._-]*$` y rechazar `.` y `..`.
  - Además, comprobar que el directorio resuelto (`$.fs.stat(dir, { resolve: true })`) queda bajo `<root>/<runsDir>`.
  - Aplicar lo mismo a `--part` antes de usarla en nombres de archivo (`review-<part>-r<n>.md`, Fase 4).
- **Cómo se verifica.** Test de kit: `launch free "x" --run ..` se rechaza y no hay ningún `fs.write`.

### C-05 · P2 · prompts/_result.md:1 (y prompts/free.md, prompts/qa.md, prompts/planner.md) · solo el brief del implementador prohíbe push/PR

- **Qué falla.**
  - La frase «No push, pull request or merge unless this assignment says so in writing» solo está en `prompts/implementer.md`.
  - Los briefs de `free`, `qa` y `planner` no la llevan, y esos roles se lanzan con `--permission-mode auto` por defecto.
  - Tampoco la lleva la coletilla que añade `/foreman tell` (register.tsx:329).
  - El brief real de `22801afb` (primera fila USER del transcript) no la contiene.
- **Escenario.** Con `/foreman launch free "arregla el typo del README"`, el hilo puede hacer commit y push por su cuenta, y nada en el encargo lo impide. Eso choca con «nunca hace push/PR sin autorización escrita en el encargo».
- **Corrección esperada.** Poner la regla en una parte común que `composeBrief` añada a todos los roles (`_result.md` o un `_rules.md`) y también en la coletilla de `tell`.
- **Cómo se verifica.** Test de `composeBrief` para cada rol de `ROLES`: el brief contiene la regla.

### C-06 · P2 · hooks/lib/transcript.ts:100-114 (fixture en hooks/threads.test.ts:38-39) · los tokens se cuentan dos veces

- **Qué falla.**
  - La deduplicación por `message.id` solo funciona dentro de una misma lectura. Entre lecturas, el código filtra por `timestamp > usageSince`.
  - En los transcripts reales, las filas de un mismo mensaje tienen timestamps distintos. En `C--MSG/c0f2ffa4…jsonl`, 89 de 103 ids ocupan varias filas separadas entre 1 y 3 s, con la misma `usage`.
  - Si una sync cae entre dos de esas filas, el mensaje se cuenta dos veces.
  - El fixture del test pone el mismo timestamp a las dos filas de `m1`, y por eso el test no lo detecta.
- **Escenario.** En un hilo largo con el vigilante cada 30 s, los tokens del panel y de `status` salen inflados: cada doble cuenta suma unos 90k de cache read. D4 usa esa cifra para controlar el presupuesto.
- **Corrección esperada.** Guardar en el hilo el último `message.id` contado y saltarse las filas con ese id aunque su timestamp sea mayor. Otra opción: recontar el archivo entero cuando cabe en una sola lectura.
- **Cómo se verifica.** Test con dos filas `msg_1` a 56.673Z y 57.380Z leídas en dos pasadas: el total de output debe ser 1006. Hoy da 2012 (R5).

### C-07 · P2 · hooks/threads.test.ts:203-228 (código en hooks/register.tsx:194-209) · los tests no cubren el funcionamiento del vigilante

- **Qué falla.** Ningún test cubre el código que une las piezas del vigilante: localizar el transcript, `readFacts`, la condición `turnOver`, persistir `usage`/`usageSince`, los toasts y `recordRun` de las transiciones.
  - En el e2e, `fs.exists` solo conoce los archivos que escribe el propio plugin y `env.get` devuelve undefined. Por eso `findTranscript` devuelve siempre undefined y esa rama nunca se recorre.
  - Hay que tener en cuenta que el engine pasa a los hooks las rutas normalizadas con `\` (lo vi en el kit). Un mock que indexe por la ruta con `/` nunca coincide.
  - Los tests de `syncThread` reciben el fence ya decidido, así que se saltan justo la condición donde está C-01.
  - Tampoco hay test para:
    - el tick de `$.clock.every`;
    - la restauración desde `$.store`;
    - `recordRun` con un `foreman.json` roto;
    - `readFacts` con más de 3,5 MB;
    - el estado `failed`.
  - El fixture irreal de C-06 entra en la misma categoría: el test valida su propio mock, no la forma real del transcript.
- **Corrección esperada.** Tests e2e con el transcript mockeado y las rutas normalizadas:
  - launch, luego un fence `done`, y comprobar `ready`/`done`;
  - la ventana de `tell` de C-01;
  - el caso `failed` de C-03;
  - un tick de `mock.clock` (avanzar 30 s) que cambie el estado y lance el toast.
- **Cómo se verifica.** Los tests nuevos fallan con el código actual en C-01 y C-03 y pasan cuando se corrigen.

### C-08 · P3 · hooks/lib/transcript.ts:26-40 · la cola del transcript se lee en Windows con un shell y la ruta interpolada

- **Qué falla.**
  - Se usa `powershell.exe -Command <script>` con la ruta metida dentro del script.
  - El código escapa la `'` ASCII, pero no las comillas tipográficas `‘ ’ ‚ ‛`, que PowerShell también trata como comillas simples.
  - Es un shell, en contra de «sin shell: argv» (§3, §11), y la decisión no está en DECISIONES.
  - Esta rama no se ha ejecutado nunca con datos reales: no se ha leído ningún transcript de más de 3,5 MB.
- **Escenario.** Si `USERPROFILE` o `CLAUDE_CONFIG_DIR` contienen `’`, el script se rompe (o admite inyección) y `readFacts` devuelve undefined para siempre en los hilos grandes.
- **Corrección esperada.** Usar un script fijo y pasar la ruta por `env`, que `ProcessRunInit` admite: `$p = $env:FOREMAN_TAIL_PATH`. Anotar la decisión.
- **Cómo se verifica.**
  - Test de `tailArgv`: la ruta no aparece dentro del script.
  - Una lectura real de un jsonl de más de 3,5 MB.

### C-09 · P3 · hooks/register.tsx:31-32, 174-176, 387-390 · `syncing` es una variable de módulo y hace que `status` devuelva datos viejos

- **Qué falla.** §11 pide no usar variables de módulo. Además, si el vigilante está a mitad de una sync, `sync()` vuelve sin hacer nada, y `/foreman status` y `/foreman` devuelven el estado anterior.
- **Escenario.** En el kit (R1), el primer `status` justo después de `launch` mostró `Working` y `-` en tokens, aunque el transcript ya decía done. La desviación no está en DECISIONES.
- **Corrección esperada.** Hacer que `status` espere a la sync en curso (guardar su promesa; documentarlo como caché aceptable) o usar un candado en `$.state` con `ifVersion`.
- **Cómo se verifica.** Test: `status` inmediatamente después de `launch`, con el transcript ya listo, debe mostrar `Done`.

### C-10 · P3 · docs/DECISIONES.md:11 · D-03 cita un «SPIKE addendum» que no existe

- **Qué falla.** D-03 se apoya en un «SPIKE addendum» para afirmar que cualquier otro flag en la línea de `--resume` arranca una copia. `docs/SPIKE.md` no tiene ningún addendum. Es una regla de la que depende `resumeArgv`.
- **Corrección esperada.** Añadir el addendum con el comando literal y su salida.
- **Cómo se verifica.** Leyendo `docs/SPIKE.md`.

### C-11 · P3 · hooks/lib/roles.ts:48 · no se avisa de las skills que no existen

- **Qué falla.** D8 dice: «Una skill listada que no existe en el repo se omite con aviso». El brief, en cambio, lista todas las skills del perfil con «if they exist here» y no avisa de ninguna. La desviación no está anotada.
- **Corrección esperada.** Comprobar `.claude/skills/<name>/SKILL.md` (y `~/.claude/skills`) y avisar u omitir. Si se decide dejarlo en manos del hilo, anotarlo en DECISIONES con el motivo.
- **Cómo se verifica.** Test con una skill inexistente en el perfil: debe aparecer un aviso.

### C-12 · P3 · hooks/register.tsx:281, 320, 326, 330, 358, 368, 396 · los rechazos de `$.process.run` y `$.fs.read` dentro de los comandos no se capturan

- **Qué falla.** Según el d.ts, `$.process.run` rechaza si el comando no arranca o sigue corriendo cuando vence el timeout. En los comandos no hay `try`, así que el hook falla y el usuario solo ve la línea tenue que pinta el engine.
- **Escenarios.**
  - En `tell`, si el `stop` va bien y el `--resume` vence el timeout, el hilo queda parado y el registro no lo refleja.
  - `init` con un perfil que no se puede leer también lanza la excepción. D8 dice que eso nunca debe bloquear un comando.
  - Un brief de más de 32.767 caracteres (el límite de la línea de comandos en Windows) produciría el mismo rechazo.
- **Corrección esperada.** Capturar los rechazos y devolver un texto accionable. En `tell`, marcar el hilo como `stopped` si el resume falla.
- **Cómo se verifica.** Test en el que `process.run` deniega: el comando devuelve un texto de error y el estado del hilo queda coherente.

### C-13 · P3 · hooks/lib/profile.ts:201-205 → hooks/register.tsx:184, 436 · el `claudeExe` del perfil del repo se ejecuta solo

- **Qué falla.** El `claudeExe` del perfil del repo se ejecuta sin que el usuario haga nada: en `session.start` y después cada 30 s.
- **Escenario.** Un repo clonado con `"claudeExe": "tools/x.cmd"` ejecuta ese binario en cuanto se abre Claude Code en él con foreman instalado en scope user. Es equivalente a un hook de proyecto (después de aceptar la confianza del workspace), pero en un producto público resulta inesperado.
- **Corrección esperada.** Mover `claudeExe` a `userConfig` (D-13 ya prevé añadirlo) en lugar del perfil del repo, o ignorarlo hasta que el usuario ejecute un `/foreman` en esa sesión.
- **Cómo se verifica.** Test con un perfil que define `claudeExe`: `session.start` no lo ejecuta.

### C-14 · P3 · hooks/register.tsx:102, 116 · `$.store` y `foreman.json` pueden perder datos

- **Qué falla.**
  - `$.store` crece sin límite: los hilos cerrados no se podan y `summary`, `waitingFor` y `question` se guardan sin recortar. El tope es de 4 MiB para todo el store; al superarlo, `store.set` rechaza y fallan todos los comandos que escriben.
  - Un `foreman.json` de run que no se puede leer (por ejemplo, una edición humana con una coma de más) se reescribe en silencio y se pierde su historial.
- **Corrección esperada.**
  - Podar los hilos cerrados de más de N días y recortar los textos.
  - Si el JSON no parsea, renombrarlo a `foreman.json.broken-<ts>` y avisar.
- **Cómo se verifica.** Un test para cada caso.

### C-15 · P3 · hooks/lib/transcript.ts:70, 121 · `LIMIT_RE` da falsos positivos

- **Qué falla.** `LIMIT_RE` busca `rate limit|limit reached|resets? at|…` en la última respuesta (si tiene menos de 600 caracteres y no hay fence). Un hilo cuya tarea trataba sobre «rate limit» queda marcado como `limit`.
- **Escenario.** Hoy solo cambia la etiqueta. En la Fase 4, `limit` lleva a un reintento automático, es decir, a reanudar un hilo sin que nadie lo pida.
- **Corrección esperada.** Detectar el límite por la forma de la fila de error de la API y no por el texto del modelo, y comprobarlo en el spike.
- **Cómo se verifica.** Test: «Added rate limit middleware.» sin fence debe quedar en `waiting` con `noResult`.

### C-16 · P3 · hooks/register.tsx:62-65 · en un worktree se usa la raíz del árbol principal

- **Qué falla.** `repoRoot` usa `$.session.repo().root`, que en un worktree es la raíz del árbol principal (doc de `SessionRepo.root` en el d.ts).
- **Escenario.** Desde una sesión en un worktree (el Code tab de desktop los usa), el perfil, el `runsDir` y el `cwd` de los hilos salen del checkout principal y no del worktree de la sesión. D-14 lo documenta solo para el panel.
- **Corrección esperada.** Tomar la decisión y anotarla. Lo más probable es usar `$.session.root()` para launch y perfil, y la raíz del repo solo para agrupar en el panel.
- **Cómo se verifica.** Test con `session.repo.root` distinto de `session.root`.

### C-17 · P3 (para la Fase 3) · hooks/lib/profile.ts:66-67 · el revisor tiene `Bash` y `Write` por defecto

- **Qué falla.** Por defecto, `reviewer` y `critic` tienen `Bash` y `Write`. El guard previsto en la Fase 3 (`pathGlob` + `deny` sobre `Write`) no impide escribir fuera de `runsDir` con `Bash` o `PowerShell` (`echo > x`, `git commit`). Hoy no se cumpliría «el revisor solo puede escribir en runsDir».
- **Corrección esperada.** En la Fase 3:
  - denegar `Edit` y `NotebookEdit`;
  - denegar `Write` fuera de `runsDir`, comprobando con `realPath` (ver el ejemplo de `$.fs.stat` en el d.ts);
  - denegar `Bash`/`PowerShell` salvo una lista de comandos de solo lectura;
  - todo con un `.catch` que deniegue.
- **Cómo se verifica.** Tests de los guards.

## Criterios de aceptación

### Fase 1

| # | Criterio | Estado | Evidencia vista |
|---|---|---|---|
| 1.1 | `plugin.json`, `hooks.json`, `register.tsx`, `types/index.d.ts`, `profile.ts` (defaults, validación, `/foreman init\|profile`) | Cumplido | Los archivos están y `validate` pasa. 11 tests de perfil (sin archivo, vacío, roto, no-objeto, claves desconocidas, valor malo, jsonc, merge por nivel, guards, init). Ejecución real de `/foreman profile` en `C:\MSG` (`C--MSG/295fff4f…`, 20:49:03Z): «No .claude/foreman.json: running on the defaults.» |
| 1.2 | Panel con `claude agents --json` filtrado por el cwd del repo y agrupado; botón «Refresh»; línea de estado | Cumplido en código y kit, con un defecto | `pane.test.ts`: terminal y desktop, grupos, prefijo `C:\MSGX` excluido, Refresh lanza otra llamada a `claude agents`. R6 (kit con la salida real de esta máquina) dibuja las 8 sesiones bg de `C:\MSG`, pero mete `7075eb6d` (failed) en «Done» (C-03) |
| 1.3 | Tests: perfil (defaults, inválido, merge por nivel) y panel en terminal y desktop con `process.run` mockeado | Cumplido | 48/48 en verde. Estos tests prueban la lógica, no el comportamiento en vivo |
| 1.4 | **Aceptación:** `claude --plugin-dir …` en `C:\MSG` muestra en el panel las sesiones bg existentes con su estado | Cumplido | Captura del terminal interactivo (pestaña `c1`, 20:49:35Z, en `d9b71730…jsonl`): panel acoplado con `C:\MSG · listed 22:49:35 [ Refresh ]`, `Waiting for you (1) fcd4c1b7`, `Done (3)` y `Stopped (1) a6639aa7`, que coincide con `claude agents` de ese momento. R6 reproduce el mismo árbol con la salida real de hoy. El defecto de C-03 (failed dentro de «Done») sigue en pie |

### Fase 2

| # | Criterio | Estado | Evidencia vista |
|---|---|---|---|
| 2.1 | `threads.ts`: launch/send/stop/logs/list; nombres `foreman:<run>:<role>-<part>` | Cumplido | Constructores de argv puros más la orquestación en `register.tsx` (D-11). Nombres reales: `foreman:adhoc:free` y `foreman:r-test:free-A` (`C--Users-javi--source-repos-foreman/44a05e4b…`). Las comillas y `$HOME` llegaron literales al hilo (sin shell). `--model haiku --effort low` respetados |
| 2.2 | `transcript.ts`: cola del jsonl (≤ 4 MiB), parse del fence, suma de `usage` | Parcial | El parse del fence está bien, con tests. La suma de usage cuenta dos veces (C-06). La lectura de la cola por encima de 3,5 MB no se ha ejecutado nunca con datos reales y usa un shell (C-08) |
| 2.3 | Comandos launch/tell/open/log/stop/close/status; registro en `$.store` y en el `foreman.json` del run | Cumplido con defectos | Reales en `C:\MSG`: `launch` (`a1d0e85a`, 21:02:34Z → 22801afb), `status` (`8767932a`: `Done`, `30k in · 573 out · 89k cached`), `log` (`c4815feb`, `593da60f`), `tell` (`59ac5253`), `status` tras `tell` (`9ecbb97d`: `32k in · 706 out`). El `$.store` funciona entre procesos: `status`, en otro proceso, vio el hilo lanzado por `launch`. `open`, `stop` y `close` solo están probados en el kit. El `foreman.json` del run solo está probado en el kit: el de `r-test` estaba en `.claude/` del repo foreman y ya no existe. Defectos: C-02, C-04 |
| 2.4 | Vigilante `$.clock.every(30 s)`: sincroniza estados, detecta el fence, toast en `working→ready/waiting` | Cumplido (evidencia indirecta) | Pestaña `c4`. A las 21:06:21Z la línea de estado dice `⚠ foreman: foreman: 1 working` (el doble prefijo se corrigió después, D-21). A las 21:06:37Z ha desaparecido sin que se tecleara ningún comando, y el turno de `fafcb4f5` terminó a las 21:06:26Z. Solo un tick pudo cambiarlo. No se capturó el toast. El kit sigue sin probar el tick (C-07) |
| 2.5 | Tests: fence (con bloque, sin bloque, JSON roto), sync con `agents` simulado, `send` según el spike | Cumplido, con huecos | Están los tres grupos y pasan. Huecos importantes en C-07; el fixture de usage no se parece a la realidad (C-06) |
| 2.6 | **Aceptación:** desde `C:\MSG`, `/foreman launch free "lista los archivos de docs/plans"` crea la sesión, el panel la ve pasar a `done`, `/foreman log` la muestra, `/foreman tell` la reanuda y responde | Cumplido | Crea la sesión: sí. `22801afb`, el transcript contiene el brief y termina con un `foreman-result` válido. Panel en `done`: pestaña `c2`, 21:04:35Z: `Threads (1) · 22801afb foreman:adhoc:free · Done · sonnet/high · 32k in · 706 out · 152k cached · 5`. `log`: sí. `tell`: sí; mismo id `22801afb`, prompt nuevo a 21:03:26Z y respuesta «5» con fence a 21:03:29Z, sin crear una copia. El paso a `done` lo hizo la sync de `status`, no el vigilante; el vigilante está probado en 2.4 |

### Decisiones del plan

- **D1 (hilos = `claude --bg`):** se cumple. Desviaciones anotadas: D-01 (aislamiento `none`), D-02 (sin `-p`) y D-03 (stop + `--resume`).
- **D3 (coordinador sin modelo):** se cumple. No hay ninguna llamada a `$.model` ni a `$.agent`.
- **D4 (modelos y effort por rol):** se cumple. planner opus/high, implementer opus/high con N1→sonnet, reviewer y critic fable/high, qa sonnet/medium. Los roles `free` y `triage` no están en D4 y sus valores son razonables.
- **D8 (todo opcional, perfil roto avisa):** se cumple para el perfil (tests). Desviaciones no anotadas:
  - skills que no existen (C-11);
  - `init` con un perfil que no se puede leer lanza (C-12).
- **§11:**
  - `$.agent.spawn`, `prompt.compose` y guards todavía no existen (fases 3 a 5).
  - Ninguna espera larga con `$.clock.sleep`. El d.ts aclara que las llamadas a `$` no consumen presupuesto del hook.
  - `ui.render` solo lee. Escribe desde `onPress`, que es el patrón del d.ts.
  - Límites de 4 MiB respetados, con matices en C-08 y C-14.
  - Todos los `process.run` tienen timeout. Uno usa shell (C-08).
  - Hay una variable de módulo (C-09).

### Honestidad

- Sin bloque `foreman-result`, el hilo pasa a `waiting` con `noResult`: comprobado en threads.ts:106-110 y en tests.
- Nunca reanuda solo: `resumeArgv` solo se usa en `tell` (register.tsx:330), y `tell` solo lo dispara el usuario. `blocked` y `question` dejan el hilo en `waiting`.
- Pero C-01 atribuye un bloque viejo a un turno nuevo, y eso es un `done` inventado en la práctica (P1).
- La regla de no hacer push solo está en el implementador (C-05).

### Seguridad y alcance

- Escrituras: solo register.tsx:122 (el `foreman.json` del run), :408 (el perfil, en `init`, previsto en §4) y `$.store` (:102). No escribió nada en `C:\MSG`.
- Escape de runsDir: C-04.
- No guarda secretos: el brief no se persiste.
- El revisor subagente todavía no existe; ver C-17 para la Fase 3.

## Lo que no pude verificar, y por qué

- **El toast en vivo.** El tick está probado de forma indirecta (2.4), pero ninguna captura muestra un toast.
- **La lectura de la cola de un transcript de más de 3,5 MB por PowerShell.** Habría que ejecutar el plugin sobre un hilo grande.
- **El `foreman.json` real de un run.** El de `r-test` (lanzado con `--run r-test` en el repo foreman) desapareció junto con `.claude/`. Solo hay evidencia del kit.
- **El valor exacto de `status` en la fila de `claude agents` durante la ventana de C-01.** Lo deduzco del `timeline.jsonl` del job (no hay `working` en el segundo turno) y del hueco de 2,3 s en el transcript, y el mecanismo se reproduce en el kit. No lancé un `tell` real para medirlo.
- **Qué hace `claude stop` con un job `failed`** (afecta a la salida de C-03). Comprobarlo exigía actuar sobre el job.
- **El comportamiento con varias sesiones en vivo** (C-02). Lo reproduje en el kit con un store sembrado, no con dos chats reales.
- **Por qué falló el arranque de `7075eb6d`.** Probablemente lo explica la pestaña `c3`: a las 21:05:25Z se escribió `/foreman launch …` y la herramienta de terminal mandó Ctrl-C a los 2 s, con `claude --bg` a medio arrancar. Su `state.json` se quedó en `starting…`. Es decir, un launch interrumpido deja un job `failed` real, que es el caso de C-03.

Las reproducciones del kit están en el scratchpad de esta sesión, fuera del repo: `scratchpad/fcopy/hooks/review.test.ts` (R1–R5) y `pane-real.test.ts` (R6). Un detalle útil para los tests nuevos: los mocks de `fs.*` reciben las rutas normalizadas con `\`.
