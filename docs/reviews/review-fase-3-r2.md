Veredicto: OK

# Revisión de las correcciones de la Fase 3 (r2)

- Fecha: 2026-10-10. Revisor: Opus 5.5 (independiente).
- Commit revisado: `0cb913d` "Phase 3 review fixes". Diff: `93a0fa4..0cb913d` (8 archivos, +355 −55).
- Gates: `claude plugin validate .` ✔ · `npx tsc -p .` exit 0 · `claude plugin test .` 100 pass / 0 fail.

## Contraprueba del guard

Sonda ampliada, ejecutada sobre una copia del código nuevo: `judge()` con las tools por defecto y también con `PowerShell` añadido, como lo haría un perfil.

- **32 comandos peligrosos, 32 denegados en los dos casos:**
  - las dos expresiones .NET entre paréntesis;
  - `sort.exe /O`;
  - `"$(…)"` y backticks dentro de comillas dobles;
  - `$'\x72\x6d'`;
  - `uniq A B`, `tree -o`, `file -C`, `less -o`;
  - `sort --compress-program`, `rg --pre` y `rg --hostname-bin`;
  - programas dados con ruta;
  - redirecciones (`>`, `2> archivo`), `<(…)`;
  - `git -c`, `git diff --output`, `git log --output x`, `git grep -O…`, `git checkout`;
  - asignaciones de entorno;
  - `find -delete` y `find -exec`, `tail -f`;
  - `;`, `&&` y `xargs` hacia programas que no están en la lista.
- **9 comandos legítimos, ninguno bloqueado:**
  - `rg "a > b"`, `rg 'function f() {'`, `rg "=>"`, `grep 'List<T>'`, `rg '$(…)'` entre comillas simples;
  - `git show HEAD:x | head`, `ls && wc`, `git log … 2>/dev/null`.
- Las tools por defecto de reviewer y critic ahora son `Read, Grep, Glob, Bash, Write`.

## Hallazgos de la r1

| # | Estado | Evidencia |
|---|---|---|
| C3-01 P1 | Resuelto | PowerShell sale de las tools por defecto (D-40). Si un perfil lo vuelve a añadir, `( ) [ ] @ $` fuera de comillas simples se deniegan. La sonda lo confirma |
| C3-02 P2 | Resuelto | El programa tiene que ir como nombre suelto, sin quitar `.exe`. La lista es más corta y rg y tail tienen opciones denegadas. Sonda: 0 fugas |
| C3-03 P2 | Resuelto | `hooks/lib/owner.ts`, `standing()` = `mine`/`other`/`orphan`. Cada revisión guarda su `owner`. `settleLost` no toca las de otra sesión viva y cierra las demás leyendo el archivo. La respuesta del subagente pesa más que el cierre por archivo (`rank`). Lo comprobé con datos reales: `claude agents` lista las sesiones de Desktop con el `sessionId` de su transcript (`d9b71730` para el chat implementador), que es lo que devuelve `$.session.id()` |
| C3-04 P3 | Resuelto, con una desviación anotada (D-42) | Si el guard falla, pasa la llamada de un agente que consta como ajeno y se deniega la de un revisor de foreman o de un agente desconocido. Que un agente que no está en la lista no se trate como revisor en el camino normal (los de un Workflow no se listan) es razonable |
| C3-05 P3 | Resuelto | La sintaxis se lee respetando las comillas. Sonda: los 9 legítimos pasan |

## Para la Fase 4 (sin bloquear)

- **El dueño es una sesión.** Un `claude -p` nunca aparece en `claude agents`, así que todo lo que lance queda huérfano enseguida (`owner.ts` ya lo advierte). Un ciclo lanzado desde `-p` lo adoptaría otro chat del repo. La aceptación de la Fase 4 tiene que hacerse en una sesión interactiva, que además es la única donde corre el vigilante de 30 s.
- **Adoptar un ciclo huérfano** (la concesión que pide N-02) no puede repetir una acción que ya se hizo. Antes de lanzar un revisor o reanudar al implementador, la máquina de estados tiene que mirar lo que ya consta en `foreman.json` y en las revisiones.

## Autorización

La Fase 3 queda cerrada. **Se autoriza la Fase 4.**
