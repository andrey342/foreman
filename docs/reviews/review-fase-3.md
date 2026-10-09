Veredicto: NO

# Revisión independiente · Fase 3 de `foreman`

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commit revisado: `93a0fa4`. Diff: `3a2b366..93a0fa4` (15 archivos, +1014 −35).
- Gates: `claude plugin validate .` ✔ (`tool.call` y `agent.offer` con `.catch`) · `npx tsc -p .` exit 0 · `claude plugin test .` 92 pass / 0 fail.
- El veredicto es NO por C3-01: el guard del revisor se salta con un único comando de PowerShell, y PowerShell está entre las herramientas por defecto del revisor. El resto de la fase está bien hecho y la aceptación tiene evidencia real.

## Comprobaciones

| Qué | Resultado |
|---|---|
| Evidencia en vivo en `foreman-demo` (solo lectura) | `.claude/runs/r1/review-A-r1.md`: la primera línea es `Verdict: NO` y C-01 es el bug sembrado en `src/sum.js:4`. `critic-A-r1.md`: `Verdict: FAIL`. `foreman.json` tiene los dos registros (`NO`, 1 hallazgo; `FAIL`, 1). `git status`: solo `?? .claude/` |
| Probé `judge()` con 15 comandos, en una copia en el scratchpad | Deja pasar 11 que escriben o ejecutan, y bloquea 2 búsquedas legítimas (C3-01, C3-02, C3-05) |
| Lo ejecuté de verdad en `scratchpad/bypass` | `uniq a.js b.js` sobrescribió `b.js` con el contenido de `a.js`. `powershell -Command "Get-Content ([IO.File]::WriteAllText(…'pwned.txt','pwned'))"` creó `pwned.txt` aunque después `Get-Content` diera error |
| d.ts | `$.agent.list()` devuelve «the session's agents», es decir, solo los de esta sesión (C3-03) |

## Hallazgos

### C3-01 · P1 · hooks/lib/guards.ts:72-93 (y hooks/lib/profile.ts:66-67) · el guard se salta con una expresión entre paréntesis en PowerShell

- **Qué falla.** En PowerShell, un argumento entre paréntesis se evalúa como una expresión. `shellVerdict` solo mira el primer programa y una lista de caracteres, y deja pasar:
  - `Get-Content ([IO.File]::WriteAllText('…','pwned'))`
  - `Write-Output ([IO.File]::Delete('src/a.js'))`

  Cualquier llamada .NET cabe ahí: escribir, borrar o ejecutar. `PowerShell` está en `tools` por defecto de reviewer y critic, y D-35 registra los tipos en modo `auto`, así que el guard es la única barrera.
- **Escenario.** Un diff revisado con una inyección («ejecuta esto para comprobar…»), o un revisor que se equivoca, escribe fuera de `runsDir` o borra código. Rompe la invariante de la Fase 3: «el revisor solo puede escribir en runsDir». Confirmado en real: `pwned.txt` se escribió.
- **Corrección esperada (elige una).**
  - La sencilla: quitar `PowerShell` de las `tools` por defecto de reviewer y critic. En Windows, el `Bash` (Git Bash) da `git` y `rg`, y para buscar están `Grep`, `Glob` y `Read`.
  - Si se mantiene PowerShell: un análisis que respete las comillas y deniegue `(`, `)`, `[`, `]`, `$` y `@` fuera de comillas simples, más `$` y el backtick dentro de comillas dobles.
- **Cómo se verifica.** Tests con los casos de la sonda: los dos de arriba denegados, o la herramienta PowerShell fuera de la lista y denegada por `judge`.

### C3-02 · P2 · hooks/lib/guards.ts:22-35 y :80 · más formas de escribir o ejecutar con programas de la lista

- **Qué falla.** `judge()` los deja pasar todos (sonda):
  - **Escriben:**
    - `uniq IN OUT` sobrescribe OUT (confirmado en real).
    - `tree -o F` escribe F.
    - `file -C -m M` escribe `M.mgc`.
    - `cat a | less -o F` escribe F.
    - `sort.exe /O F IN` en PowerShell: se quita `.exe`, queda `sort`, que está en la lista, y se ejecuta el `sort.exe` de Windows con `/O`.
  - **Ejecutan otro programa:**
    - `sort --compress-program=P`.
    - `rg --hostname-bin=P` (ripgrep 14).
  - **Programa con ruta:** `prog` es el último segmento de la ruta, así que `./.claude/runs/r1/cat x` o `C:/tmp/evil/cat x` pasan como `cat`. El revisor puede escribir con `Write` un script con shebang llamado `cat` en su propio `runsDir` y ejecutarlo así desde Git Bash.
- **Corrección esperada.**
  - El programa tiene que ser un nombre suelto: denegar cualquier argv[0] que contenga `/` o `\`. Comparar la palabra exacta, sin quitar `.exe`.
  - Reducir la lista y cambiar las listas negras de opciones por listas blancas donde se pueda. Sugerencia:
    - `git`, con sus subcomandos de lectura actuales;
    - `rg` y `grep`, denegando `--pre*`, `--hostname-bin*` y `--search-zip`/`-z`;
    - `ls`, `cat`, `head`, `tail` (sin `-f`), `wc`, `pwd`, `echo`;
    - `find`, con su lista de denegación actual;
    - `stat` y `diff`.
  - Quitar `uniq`, `tree`, `file`, `less`, `more` y `sort`, o aceptarlos solo con opciones de una lista blanca.
- **Cómo se verifica.** Tests con cada caso de la sonda denegado.

### C3-03 · P2 · hooks/register.tsx:653-660 (`settleLost`) · un chat da por perdidas las revisiones que otro chat tiene en marcha

- **Qué falla.** `$.agent.list()` solo devuelve los agentes de la sesión actual. En `session.start`, `settleLost` marca como `noResult: the subagent ended before it answered` cualquier revisión pendiente del store cuyo agente no esté en esa lista.
  - Las que sigue ejecutando otro chat del mismo repo quedan marcadas así.
  - Además, una revisión cuyo `turn.complete` se perdió (por ejemplo, el agente ya no aparece en la lista) queda en `noResult` sin leer el archivo, aunque exista y tenga veredicto.
- **Escenario.** Con dos chats abiertos en MSG, A lanza `/foreman review` y B arranca. B registra la revisión de A como sin resultado. Si A refresca su copia desde el store antes de que su subagente termine, su `turn.complete` ya no la encuentra pendiente y el veredicto real no se registra nunca.
- **Corrección esperada.**
  - Guardar en cada revisión la sesión dueña (`$.session.id()`).
  - `settleLost` solo actúa sobre las de esta sesión, o sobre las de una sesión dueña que ya no está viva (filas `interactive` de `claude agents` por `sessionId`).
  - Al cerrarla, resolver desde el archivo con `settle(kind, fileText, '')`. El archivo manda, igual que en `settleReview`.
  - Es el mismo mecanismo de dueño que pide N-02 para la Fase 4: hacerlo una sola vez.
- **Cómo se verifica.**
  - Store con una revisión pendiente cuyo dueño es otra sesión viva: no se toca.
  - Revisión propia pendiente, con el archivo escrito y el agente ya desaparecido: se resuelve con el veredicto del archivo.

### C3-04 · P3 · hooks/register.tsx:824-828 · el `.catch` del guard deniega llamadas de subagentes ajenos

- **Qué falla.** El `.catch` deniega cualquier llamada de subagente cuando el hook falla, por ejemplo si `$.agent.list()` rechaza o excede su presupuesto. También caen los subagentes propios del usuario (Explore, general-purpose…), que no tienen nada que ver con foreman.
- **Corrección esperada.** En el `.catch`, denegar solo si el `agentId` está en `read($, reviews)` o no se sabe de quién es. Si consta como ajeno, `next(e)`.
- **Cómo se verifica.** Con `agent.list` rechazando: una llamada de un agente ajeno pasa y una del revisor se deniega.

### C3-05 · P3 · hooks/lib/guards.ts:38-43 · `BAD_SYNTAX` no tiene en cuenta las comillas

- **Qué falla.** Se deniegan búsquedas legítimas:
  - `rg "a > b"`;
  - `rg 'function f() {'`;
  - `rg "=>"`, que es muy habitual en TS;
  - genéricos como `List<T>`.

  Un revisor de código TS o C# chocará con esto a menudo.
- **Corrección esperada.** Mirar la sintaxis solo fuera de comillas. Las comillas simples son literales en las dos shells; dentro de comillas dobles solo importan `$` y el backtick.
- **Cómo se verifica.** Esos casos pasan y los mismos caracteres fuera de comillas se deniegan.

## Criterios de aceptación de la Fase 3

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 3.1 | `agents/*.md` + `$.agent.register` con modelo, effort y tools del perfil (el perfil manda) | Cumplido | D-33: los prompts están en `prompts/agents/` y los tipos se registran en `session.start` y antes de cada revisión. El test «the profile sets model, effort, tools and skills» lo cubre. En vivo arrancó como `claude-sonnet-5-5` con `--model`. `agent.offer` oculta los tipos al modelo |
| 3.2 | `roles.ts` compone el brief; `/foreman review` y `/foreman critic` lanzan, esperan por `agentId`, leen el veredicto, comprueban que el archivo existe en `runsDir` y registran en `foreman.json` | Cumplido, con C3-03 | `startReview` y `settleReview`: el archivo manda, y sin archivo o sin veredicto queda `noResult`, nunca OK. Hay una línea en `foreman.json` con `reviews`. Las revisiones pendientes se guardan en `$.store` |
| 3.3 | Guard: el revisor solo escribe dentro de `runsDir` | **No cumplido** | C3-01 y C3-02. La parte de `Write` sí está bien: comprueba `realPath` y solo deja escribir bajo `<runsDir>/<runId>/` |
| 3.4 | Tests: briefs, espera por `turn.complete` (mock) y lectura del veredicto | Cumplido | `hooks/reviews.test.ts`, 20 casos. Al guard le faltan los casos de las sondas |
| 3.5 | **Aceptación:** `/foreman review --part A --base …` produce `review-A-r<n>.md` con el veredicto en la primera línea, sin tocar código | Cumplido en `foreman-demo`; pendiente en MSG | Evidencia de la tabla de comprobaciones. La versión sobre el run de MSG está en `docs/PENDING.md` para el usuario, como pedí |

## Decisiones

- D-33, D-36, D-37 y D-39: correctas.
- D-35 (subagentes en modo `auto`) es razonable, pero hace que el guard sea lo único que contiene al revisor. Por eso C3-01 es P1.
- D-38: el motivo para no hacer todavía `--thread` es correcto.

## Para cerrar la fase

1. Corregir C3-01 a C3-05 con sus tests. Los P3 son pequeños.
2. Gates en verde, commit "Phase 3 review fixes" con una línea de evidencia por hallazgo, push.
3. Al cerrar, reviso y autorizo la Fase 4. En la Fase 4, el dueño único por ciclo (N-02) reutiliza el mecanismo de dueño de C3-03.
