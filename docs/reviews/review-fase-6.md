Veredicto: OK

# Revisión final · Fase 6 de `foreman` (pulido y publicación)

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commits revisados: `089756b` y `1c19234` (tag `v0.1.0`). Diff: `762115d..1c19234` (36 archivos, +840 −52).
- Gates:
  - `claude plugin validate .` ✔;
  - `npx tsc -p .` exit 0;
  - `claude plugin test .` 162 pass / 0 fail;
  - `check-profiles` sin avisos.

## Lo que comprobé yo

| Qué | Resultado |
|---|---|
| Release y repositorio (`gh`, solo lectura) | `v0.1.0` publicada (`isDraft: false`) a las 2026-10-10T00:29:22Z. El repo `andrey342/foreman` es público, con la descripción del plan, los topics `agents`, `claude-code`, `claude-code-plugin` y `workflow`, y licencia MIT |
| **Instalación desde GitHub en un perfil limpio** (con `CLAUDE_CONFIG_DIR` apuntando a una carpeta vacía en mi scratchpad, sin credenciales) | `claude plugin install foreman --marketplace andrey342/foreman` clonó el repo, validó el marketplace e instaló `foreman@foreman` 0.1.0 en scope user (exit 0). Avisa de que hay 2 opciones de `userConfig` sin poner. `claude plugin list` lo muestra activo. La copia instalada (`plugins/cache/foreman/foreman/0.1.0`) pasa `claude plugin validate` |
| Perfil real del usuario | `claude plugin list`, sin el `CLAUDE_CONFIG_DIR` temporal: foreman **no** está instalado. Se respetó la condición |
| Los comandos que da el README existen en 2.1.296 | `claude plugin install --marketplace <owner/repo>` y `--scope` (por defecto `user`), y `claude plugin configure <plugin>` |
| Secretos y datos personales en el repo público | No hay tokens, claves ni el email del usuario. Sí hay rutas locales y el nombre de usuario (`javi-`, `C:\MSG`) en `docs/PLAN.md`, `SPIKE.md`, `PENDING.md` y `reviews/` (ver F-03) |

## Criterios de aceptación de la Fase 6

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 6.1 | Panel: tokens por hilo, última línea del log, botones Abrir, Revisar y Responder | Cumplido (kit) | D-60, con tests. No lo vi en una superficie real |
| 6.2 | `/foreman review --deep` con el workflow, solo si `Workflow` está disponible | Cumplido con desviación anotada | D-58: no se escribe `.claude/workflows/` en el repo del usuario, y hay tests con y sin Workflow. No se ejecutó en vivo porque lanza muchos agentes y nada autorizaba esa escala; es razonable |
| 6.3 | `marketplace.json`, `LICENSE` (MIT), `DECISIONES.md` y README público con la estructura de §9 | Cumplido | Comprobado: el README tiene una frase y la captura del panel (en texto), Why (comparación con Projects, sin exagerar), Install en 3 pasos con la versión probada, Quick start, The cycle con el contrato `foreman-result`, Commands, Profile reference, Models & cost, How it works, Limitations, Troubleshooting, Contributing, License y «En español». Recoge P4-02 (`-File … {{message}}`), P5-01 (los guards actúan en todas las sesiones y fallan cerrados, en un recuadro) y C-13 (`claudeExe` y `notifyCommand` en `userConfig`; un perfil de repo que los ponga se ignora con aviso, D-57) |
| 6.4 | `claude plugin eval` con 3 casos (launch, review, cycle con NO→OK) | Cumplido en parte (anotado) | Hay 3 casos y el implementador informa de 1.00 en los tres con Haiku. El sandbox del eval no es una carpeta de confianza, así que no arranca hilos `--bg`: los casos `launch` y `cycle` prueban que foreman informa del rechazo sin inventar nada, no el recorrido NO→OK. Ese recorrido lo cubren `cycle-e2e.test.ts` y la ejecución en vivo de la Fase 4 (D-59, y en Limitations del README). Ver F-04 |
| 6.5 | Repo público con descripción y topics; release `v0.1.0` con tag | Cumplido | Ver la tabla de comprobaciones |
| 6.6 | **Aceptación:** instalado en scope user desde GitHub en un perfil limpio; funciona en `C:\MSG` y en `foreman-demo` sin cambios; alguien que solo lea el README puede instalarlo y lanzar su primer hilo | Cumplido salvo MSG (pendiente del usuario) | La instalación en perfil limpio la verifiqué yo (arriba). `foreman-demo` sin perfil: el implementador cargó la copia descargada de GitHub y `profile` dio «defaults», `launch free` terminó con un `foreman-result` válido, `status`, `log` y `open` respondieron, y `review` escribió `Verdict: OK`. No lo volví a ejecutar porque lanzaría hilos. `C:\MSG` está pendiente para el usuario (`docs/PENDING.md` §1–7). README: los pasos de instalación y de inicio rápido están completos y sus comandos existen. No lo ha probado una persona ajena |

## Observaciones (P3, para decidir el usuario)

- **F-01 · lo que falta en MSG.** El plan entero queda cerrado salvo los pasos que dependen de `C:\MSG`, que no se tocó por los chats activos en ese checkout. Están en `docs/PENDING.md`:
  - copiar el perfil;
  - `new-run.ps1 -DryRun`;
  - la aceptación de las fases 5 y 3 sobre el run;
  - N-03 (skills que solo invoca el modelo);
  - retirar `gitnexus-guard.js`;
  - §7: decidir si se quieren los guards de MSG en los chats abiertos a mano.
- **F-02 · instalar en el perfil real.** Cuando el usuario instale foreman en scope user, se cargará en **todos** sus chats: un vigilante cada 30 s por chat (que ejecuta `claude agents --json --all`) y los guards del perfil del repo donde los haya. Conviene instalarlo con el resto de chats de MSG cerrados o en pausa, y revisar §7 de `PENDING.md` antes.
- **F-03 · privacidad.** El repo público tiene rutas locales, el nombre de usuario de Windows, nombres internos de MSG, de sus skills y de sus sesiones, en `docs/PLAN.md` (copia del plan, como pide §3), `SPIKE.md`, `PENDING.md` y `docs/reviews/`. No hay secretos. Si al usuario no le conviene, puede sustituir esas rutas por ejemplos genéricos y dejar las revisiones fuera del repo público.
- **F-04 · eval.** El caso `cycle` del eval no ejecuta NO→OK por la limitación del sandbox (D-59). Cuando `claude plugin eval` permita confiar en el workspace del sandbox, conviene volver a ese caso.
- **F-05 · claves sin efecto.** `roles.*.kind`, `roles.*.contract` y `limits.serialBuilds` se leen pero no hacen nada en 0.1.0. Están documentadas en el README (D-64). Lo correcto es implementarlas o quitarlas en 0.2.0.

## Cierre del plan

Las fases 0 a 6 están revisadas. Sus informes, `review-fase-2.md` a `review-fase-6.md`, incluyen las rondas r2 de las fases 2 y 3. **La implementación del plan queda cerrada**, con los pasos en `C:\MSG` pendientes del usuario.
