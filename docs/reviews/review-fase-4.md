Veredicto: OK

# Revisión independiente · Fase 4 de `foreman` (el ciclo)

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commit revisado: `38a2dd1`. Diff: `0cb913d..38a2dd1` (18 archivos, +1407 −113).
- Gates: `claude plugin validate .` ✔ (`prompt.submit` y `tool.call` con `.catch`) · `npx tsc -p .` exit 0 · `claude plugin test .` 136 pass / 0 fail.

## Criterios de aceptación

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 4.1 | `cycle.ts` con la máquina de §5, guardada en `$.store` y en `foreman.json`, que se reanuda tras cerrar y abrir el chat | Cumplido | `hooks/lib/cycle.ts` es puro: la tabla está en la cabecera y `stepCycle` devuelve la siguiente fase y los efectos. `register.tsx` solo ejecuta los efectos. El e2e «a reload keeps the cycle: a new session start restores it and the watcher goes on» lo cubre |
| 4.2 | `/foreman cycle`, `/foreman night` y el límite de uso con reintento programado | Cumplido | El límite se detecta por la forma de la fila de error del CLI (`isApiErrorMessage`, `error: rate_limit`, `quotaLimits.resetsAt`; transcript.ts:71-168), no por lo que escribe el modelo (C-15 resuelto). `retryAt` va en el registro y `scheduleRetries` lo reprograma. En modo noche se añade una ronda, se encadena la parte siguiente salvo que el plan pida pausa, y los avisos quedan guardados |
| 4.3 | Notificaciones: toast + `notify.command` | Cumplido | `notify()`: argv sin shell, `{{message}}`, 15 s de tope y los fallos al log de depuración |
| 4.4 | Tests: tabla completa de transiciones, reanudación tras recarga, un solo implementador vivo | Cumplido | `cycle.test.ts` recorre fila a fila: done/ready, OK, NO con rondas, NO en la última ronda, BLOCKED, sin veredicto, question/blocked/failed/stopped (siempre a `waiting`, nunca se responden), limit, terminales y modo noche. `cycle-e2e.test.ts`: el ciclo completo sin nadie tecleando, la recarga, el dueño único, la adopción sin repetir la revisión ni el resume, y un ciclo por run |
| 4.5 | **Aceptación:** ciclo de prueba en `foreman-demo`: implementa → revisa (NO) → aplica → revisa (OK) → `ready`, sin intervención | Cumplido | Lo comprobé en solo lectura en `foreman-demo/.claude/runs/c1/foreman.json`. Las transiciones con su hora, de 23:20:43Z a 23:22:24Z, solas: implementing → reviewing → (r1 empezada) → applying → implementing («implementer resumed on .claude/runs/c1/review-A-r1.md», solo la ruta) → reviewing → (r2 empezada) → ready. `review-A-r1.md` dice `Verdict: NO` y `review-A-r2.md`, `Verdict: OK`. En `git log` están los commits del hilo `de6e7c0` (off-by-one) y `9e5a683` (JSDoc), y `src/sum.js` ya está corregido. Nada se publicó: la sugerencia «push it» del engine no se envió y el demo no tiene remoto |

Fixture: D-50 explica el perfil temporal sin trackear de `foreman-demo`, con una regla de la casa que solo conoce el revisor. Es un forma razonable de forzar un NO determinista. Hay que quitarlo antes de la Fase 6.

## Invariantes de §5 que comprobé en el código

- **Un solo dueño actúa** (`advanceCycles`: `standing()`). Un huérfano primero se reclama y se mueve en la siguiente vuelta.
- **La revisión no se repite.** `pendingRequest` y `requestBound` enlazan la revisión que el dueño anterior ya había empezado.
- **El resume no se repite.** No se reenvía si `thread.sentAt ≥ phaseAt` (register.tsx:1028-1047).
- **Si el resume falla**, el ciclo pasa a `waiting` con el motivo; con «the thread is working», se reintenta en la siguiente vuelta.
- **Si la revisión no arranca**, el ciclo pasa a `waiting` con el motivo.
- **Al reanudar solo se envía la ruta** (`applyMessage`).
- **Rondas agotadas:** NO con `used == maxCycles` deja el ciclo en `waiting`, a la espera del usuario.
- **Toda transición se registra con hora** (`recordCycle`).

## Observaciones (P3, no bloquean)

- **P4-01 · hooks/register.tsx:1236-1244 (D-47).** El hook de `prompt.submit` se basa en `origin.handback` y `origin.senderTaskId`, que el d.ts de 2.1.296 no declara (`SessionReceiveOrigin` solo trae `kind` y `plugin`). Por eso el código hace un cast. Falla de forma segura: si esos campos faltan, no se retiene nada y solo se gasta un turno del modelo. El d.ts además avisa de que no se confíe en las afirmaciones de `origin`. Hay que anotar en D-47 que son campos observados en ejecución, no declarados, para volver a comprobarlos con cada build, y añadir un test de que un prompt `composer` con la misma forma nunca se retiene.
- **P4-02 · hooks/register.tsx:870-872.** `{{message}}` mete en un argumento texto que en parte escribe el modelo (`waitingFor`, motivos). Sin shell no hay inyección. Pero si el usuario configura `notify.command` como `powershell.exe -Command "… {{message}}"`, es él quien crea el shell. El README de la Fase 6 debe recomendar `-File script.ps1 {{message}}`.

## Requisito para la Fase 5 (importante)

**foreman dentro de sus propios hilos.** Con foreman instalado en scope `user` (D5, Fase 6), cada sesión `claude --bg` que lance cargará foreman también, y ese foreman correrá su `session.start` completo:
- vigilante de 30 s;
- `pullThreads`/`putThreads` del registro del repo;
- `advanceCycles`, que puede adoptar un ciclo huérfano, porque un hilo en segundo plano aparece vivo en `claude agents`;
- `settleLost` y `retryLimits`.

Un implementador podría acabar lanzando revisores dentro de su propia sesión, o tomando ciclos de otro. Al mismo tiempo, los guards de §8 (Fase 5) **tienen** que actuar dentro del hilo, que es donde edita el implementador.

Lo que hace falta:
1. Que foreman sepa que está dentro de un hilo suyo. Por ejemplo, añadiendo `"env": {"FOREMAN_THREAD": "<id>"}` al `--settings` del launch (el resume conserva las opciones guardadas) y leyéndolo con `$.env.get`. Verificarlo en el spike.
2. En modo hilo: guards activos, y sin vigilante, sin comando `/foreman`, sin adopciones y sin escribir en el registro.
3. Probarlo en vivo cargando el plugin en el hilo (`--plugin-dir` en el launch del demo, o instalado en un perfil de prueba).

## Autorización

La Fase 4 queda cerrada. **Se autoriza la Fase 5, sin tocar `C:\MSG` esta noche.**
- Se puede hacer ahora:
  - `guards.ts` (§8) con sus tests y el modo hilo de arriba;
  - `profiles/msg.json` en el repo de foreman;
  - `onRunCreate` probado en `foreman-demo` con un script falso en modo dry-run;
  - la aceptación equivalente en `foreman-demo`: un guard de ruta, `git add -A` denegado, `report.md` y `foreman-result`.
- Queda para el usuario en `docs/PENDING.md`:
  - copiar el perfil a `C:\MSG\.claude\foreman.json`;
  - `new-run.ps1 -DryRun`;
  - la aceptación en MSG;
  - N-03 con las skills `msg-*`;
  - retirar `gitnexus-guard.js` de `settings.local.json`.
