Veredicto: OK

# Revisión de las correcciones de la Fase 2 (r2)

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commit revisado: `3a2b366` "Phase 2 review fixes". Diff: `d6324f0..3a2b366` (14 archivos, +1234 −374).
- Gates: `claude plugin validate .` ✔ · `npx tsc -p .` exit 0 · `claude plugin test .` 72 pass / 0 fail.
- Contraprueba independiente: mis reproducciones R1–R5 de la r1, ejecutadas sobre una copia del código nuevo en el scratchpad, **pasan todas**. Solo adapté los mocks: `session.root` y `command.list` son nuevos, y el reloj se avanza entre pasos.
  - **R1:** en la ventana posterior a `tell` el hilo sale `Working`. Al llegar el turno nuevo pasa a `Done` con 2 in · 20 out, así que se contó el turno 2.
  - **R2:** `failed` libera el hueco y el siguiente `launch` se acepta.
  - **R3:** `--run ..` se rechaza y el perfil queda intacto.
  - **R4:** el store conserva `bbbb0002` y `aaaa0001`.
  - **R5:** 1006 tokens, no 2012.

## Hallazgos de la r1

| # | Estado | Evidencia |
|---|---|---|
| C-01 P1 | Resuelto | `threads.ts` `turnOver`: exige un prompt con fecha ≥ `sentAt` y un `turn_duration` después. `sentAt` se toma **antes** de llamar al CLI (register.tsx:350 y :403), así que el prompt nunca queda por delante de la marca. `lastText` sale solo de las filas posteriores al último prompt (transcript.ts). Si el mensaje no llega en 3 min, el hilo pasa a `waiting` con su motivo. R1 pasa |
| C-02 P2 | Resuelto | `putThreads` y `pullThreads` releen el store y fusionan por id, y gana el `updatedAt` mayor. Eso también cierra la carrera entre un comando y una sync en curso, que yo no había señalado: un `close` o un `tell` tienen un `updatedAt` posterior al `nowIso` de la sync. `busyIds` cuenta las filas vivas `foreman:*` bajo el repo. `recordRun` no repite la última transición. R4 pasa. D-25 anota que la fusión entre procesos no es atómica (aceptable) |
| C-03 P2 | Resuelto | `row.state === 'failed'` da un hilo `failed` con su motivo. El panel tiene grupo Failed. `blocked` sin pid va a «Stopped / exited». Ya no se escanea el directorio de proyectos para sesiones muertas. R2 pasa |
| C-04 P2 | Resuelto | `isSafeId` para `--run` y `--part`, `isRelativeInside` para `runsDir` y comprobación con `realPath` del directorio del run. R3 pasa |
| C-05 P2 | Resuelto | `prompts/_rules.md` se añade a todos los roles (incluye tag y release) y `TELL_SUFFIX` repite la regla. El test recorre `ROLES` |
| C-06 P2 | Resuelto | `usageLastId` se arrastra entre lecturas. R5 pasa |
| C-07 P2 | Resuelto | `hooks/watcher.test.ts`: 15 e2e con rutas `\`, transcript simulado y un tick de 30 s de `mock.clock` |
| C-08 P3 | Resuelto | La ruta viaja en `FOREMAN_TAIL_PATH` y el script es fijo. Prueba real con un transcript de 4,5 MB (SPIKE, addendum) |
| C-09 P3 | Resuelto | Una sola sync en curso, compartida. `status` y el panel esperan a esa y después lanzan otra (D-28) |
| C-10 P3 | Resuelto | Addendum de SPIKE con los comandos literales del resume que crea una copia |
| C-11 P3 | Resuelto | D-30: las skills se comprueban con `$.command.list()`. El d.ts confirma que la fuente `plugin` incluye skills y que `user` incluye los archivos del usuario y del proyecto. Ver N-03 |
| C-12 P3 | Resuelto | D-32: los errores de los comandos vuelven como texto, un resume fallido deja el hilo en `stopped` y hay un límite de 30.000 caracteres |
| C-13 P3 | Aplazado con motivo | D-23: se resuelve en la Fase 6 con `userConfig` |
| C-14 P3 | Resuelto | D-27: recortes, poda de cerrados a los 14 días y `.broken-<ts>` |
| C-15 P3 | Aplazado a la Fase 4 | D-23 |
| C-16 P3 | Resuelto | D-29: hay un `work` root (el worktree) y un `repo` root. Test C-16 |
| C-17 P3 | Para la Fase 3 | D-23 |

## Observaciones nuevas (no bloquean)

- **N-01 · P3 · hooks/lib/agents.ts:51.** `groupOf` manda a «Stopped / exited» una fila `working` sin pid. El job de `7075eb6d` nació con `state: working` y `detail: starting…`, así que es probable que una sesión que está arrancando aparezca unos segundos como «exited» en el panel. Es cosmético. Corrección: considerar `working` sin pid como «Working» durante los primeros N segundos desde `startedAt`.
- **N-02 · Requisito para la Fase 4.** Cada chat del repo tiene su propio vigilante. Hoy solo se duplican los toasts. En la Fase 4 se duplicarían acciones: dos chats lanzarían un revisor o reanudarían el implementador ante la misma transición. Antes de la máquina de estados hace falta un único dueño por ciclo, por ejemplo una concesión en `$.store` con `owner` (id de sesión) y caducidad, que renueve el dueño y que otro chat pueda tomar cuando caduque. Necesita test.
- **N-03 · Comprobar en la Fase 5.** D-30 da por hecho que `$.command.list()` incluye todas las skills. Las skills que solo puede invocar el modelo (`user-invocable: false`) podrían no salir como comandos, y entonces foreman las quitaría del brief en MSG. Hay que comprobarlo con las `msg-*` reales antes de dar la Fase 5 por buena.

## Autorización

Las fases 1 y 2 quedan cerradas. **Se autoriza la Fase 3**, con estas reglas para la noche:
- Nada en `C:\MSG`.
- La aceptación en vivo se hace en `foreman-demo`.
- La aceptación sobre el run de MSG queda pendiente para el usuario.
