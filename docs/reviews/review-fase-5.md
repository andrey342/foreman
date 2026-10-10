Veredicto: OK

# Revisión independiente · Fase 5 de `foreman` (guards del perfil, modo hilo, perfil MSG)

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commit revisado: `762115d`. Diff: `38a2dd1..762115d` (14 archivos, +779 −38).
- Gates:
  - `claude plugin validate .` ✔ (hooks nuevos: `prompt.compose`; `tool.call` con `.catch`);
  - `npx tsc -p .` exit 0;
  - `claude plugin test .` 155 pass / 0 fail;
  - `node scripts/check-profiles.mjs`: `default.json` y `msg.json` sin avisos.

## Criterios de aceptación

En `C:\MSG` no se ha tocado nada, como se pidió. La aceptación se hizo con su equivalente en `foreman-demo`, y los pasos en MSG están en `docs/PENDING.md` para el usuario.

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 5.1 | `guards.ts` (§8) con tests | Cumplido | `requireToolCalledBefore` en `warn` (la llamada se ejecuta; toast más una nota al modelo con `session.append`) y en `deny`; `pathGlob` y `commandRegex` con `deny`. `guards-profile.test.ts`. Un único `tool.call` junta el guard del revisor y los del perfil, porque el engine solo admite uno sin matcher por módulo. El `.catch` deniega si el perfil declara guards (§8) |
| 5.2 | `profiles/msg.json` | Cumplido | Sigue §6: `runsDir .agents/runs`, los 3 repos con las rutas reales de los submódulos, roles con sus skills, gates, 3 guards (aviso de GitNexus antes de editar `.cs`, aviso de `detect_changes` antes de un commit, `deny` de `git add -A`), `onRunCreate` con `new-run.ps1` e `injectHandoff: false`. No guarda secretos |
| 5.3 | `onRunCreate`, primero con `-DryRun` | Cumplido en el demo | Argv sin shell, `{{runId}}`, 2 min de tope, una sola vez por run y registrado. Si el script no existe se omite con aviso; si sale con error, el launch se para. En vivo, con un script falso: `DRY RUN: would create run p5c`. Queda pendiente con el `new-run.ps1` real en MSG |
| 5.4 | Un hilo de MSG carga las skills `msg-*`, GitNexus y `run-state-hook.ps1` | Pendiente (usuario) | Exige ejecutar en MSG. N-03 sigue abierto |
| 5.5 | **Aceptación:** el hilo implementer N1 respeta el guard de rutas, escribe `report.md`, devuelve `foreman-result`, y `git add -A` se deniega | Cumplido en `foreman-demo`; pendiente en MSG | Lo verifiqué en el transcript del propio hilo `b40a89b5…jsonl`. A las 23:46:49Z: `foreman guard: test.js is the acceptance; it is not edited by threads: Edit on test.js`. A las 23:46:55Z: `foreman guard: Explicit paths, never git add -A`. Después escribe `report.md` y hace el commit `2f7234c` con rutas explícitas (4 archivos). Su `foreman-result` cita las dos denegaciones («Neither worked around») y `node test.js` exit 0 |

## El requisito de la r4: modo hilo

- **Funciona.** El `env` de `--settings` llega al hilo (spike). En modo hilo, `session.start` solo pone la línea de estado: ni vigilante, ni `/foreman`, ni registro, ni adopciones. `command.run` responde con una nota.
- **Lo comprobé con los jobs reales.** `~/.claude/jobs/b40a89b5/state.json` y `c777c53e` guardan entre sus `respawnFlags` tanto `--plugin-dir` como `--settings` con `FOREMAN_THREAD`. Por tanto, un hilo reanudado con `--bg --resume` sin flags (un `tell`, o el apply del ciclo) **conserva** foreman y sus guards.
- **La sección de sesión** (`prompt.compose`) no lleva horas ni antigüedades: solo cambia cuando cambia una fase o un estado, así que no rompe la caché en cada turno (§11). En un hilo depende de `injectHandoff`, y MSG lo pone a `false` porque su hook PS1 ya inyecta el handoff.

Los dos incidentes en vivo (un hilo lanzado sin guards, que se paró y se borró; y la escritura por `sed -i`, que llevó a D-52) están contados con honestidad y corregidos.

## Observaciones (P3, no bloquean)

- **P5-01 · los guards del perfil actúan en todas las sesiones que carguen foreman.** Una vez instalado en scope `user`, eso incluye los chats normales de MSG, no solo los hilos. Y como fallan cerrados (§8), si el hook falla se deniega esa llamada. Es lo que pide el plan (sustituye a `gitnexus-guard.js`), pero el README y `PENDING.md` deben decirlo con claridad para que el usuario no se lleve una sorpresa.
- **P5-02 · hooks/register.tsx:1378-1380.** `loadProfile` convierte un perfil ilegible en los valores por defecto (sin guards). Si el perfil no se puede leer en una llamada, los guards desaparecen solo para esa llamada (falla abierto). Con `guardsDeclared` ya en `true`, conviene denegar en lugar de seguir sin guards.
- **P5-03 · profiles/msg.json, guard `git add -A`.** La regex no cubre `git -C <dir> add -A`, que en MSG, con submódulos, es una forma realista. Propuesta: `git(?:\s+-C\s+\S+)*\s+add\s+(?:-A|--all|\.)(?:\s|$)`. El aviso de `commit` (`\bgit\b[\s\S]*\bcommit\b`) también salta con `git log --grep commit`; es ruido, pero solo un aviso.
- **P5-04 · D-52.** Detectar escrituras por shell para los `pathGlob` es heurístico y está documentado como tal. Es correcto no venderlo como garantía.

## Autorización y condiciones para la Fase 6

**La Fase 5 queda cerrada. Se autoriza la Fase 6**, con estas condiciones mientras el usuario duerme:

1. **No instalar foreman en el perfil real del usuario en scope `user`.** Cargaría foreman en todas sus sesiones, con los chats de MSG en marcha. La prueba de instalación desde GitHub se hace aislada: con `CLAUDE_CONFIG_DIR` apuntando a una carpeta temporal, si `plugin marketplace add`/`install` funcionan sin credenciales; sin introducir ninguna credencial. Si no se puede aislar, se deja en `PENDING.md`.
2. **Release `v0.1.0`.** Está autorizada en §0. Pero varios criterios de la Fase 6 dependen del usuario (instalar en un perfil limpio y que funcione en `C:\MSG`). Recomendación: publicarla solo si la instalación aislada desde GitHub funciona; si no, crearla como **borrador** (`gh release create v0.1.0 --draft`) y dejar en `PENDING.md` el paso de publicarla.
3. **Antes de la aceptación, limpiar `foreman-demo`:** el perfil temporal y `scripts/fake-new-run.ps1` (D-50).
4. **Lo que queda del README y el perfil:**
   - P4-02: `notify.command` con `-File script.ps1 {{message}}`;
   - P5-01: los guards actúan en todas las sesiones;
   - C-13: `claudeExe` pasa a `userConfig` (D-23);
   - la versión de Claude Code con la que se ha probado (2.1.296);
   - Troubleshooting: comillas en PowerShell 5.1 (D-22), workspace sin confianza, un hilo `blocked` por un diálogo.
5. **`claude plugin eval`** con 3 casos y modelos baratos.
6. **`--deep`** solo si `Workflow` está disponible.
