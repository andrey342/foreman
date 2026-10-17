// The plan file (D-76): parts, criteria and pauses, on three plans written the
// ways real plans are (anonymised), and the run id a plan gets (A-16).
import { describe, expect, test } from 'claude-code/testing'
import { freeSlug, nextPart, parsePlan, pickParts, planParts, planPreview, planSlug } from './lib/plan'

/** Numbered sections, "Parte A/B", a pause section of its own between them (the shape of a large monorepo's plan). */
const NUMBERED = [
  '# Plan de cierre del módulo',
  '',
  '## 5. Contexto',
  'Lo que hay hoy.',
  '',
  '## 6. Parte A — Backend',
  'Hacer el endpoint.',
  '',
  '**Criterios de aceptación**',
  '- los tests del servicio pasan',
  '- el endpoint está documentado',
  '',
  '## 7. Pausa obligatoria',
  'Antes de seguir, decisión del equipo sobre el despliegue.',
  '',
  '## 8. Parte B — Frontend',
  'Conectar la pantalla.',
  '',
].join('\n')

/** "### Fase N —" under a plan heading (the shape of a NestJS backend's plan). */
const PHASES = [
  '# Backend de reservas',
  '',
  '## Plan',
  '',
  '### Fase 1 — Esqueleto',
  '- crear el módulo',
  'Aceptación:',
  '- `npm test` pasa',
  '- el módulo arranca',
  '',
  '### Fase 2b — API',
  'Stop the server before you run the migrations.',
  '',
  '### Fase 3 — Documentación',
  'Escribir el README.',
  '',
].join('\n')

/** No part headings at all: the whole file is one part. */
const SINGLE = '# Arreglar el login\n\nEl botón de entrar no responde en Safari.\n\n## Acceptance\n- clicking it signs in\n'

describe('parts (D-76, Phase 1 criterion 1)', () => {
  test('numbered sections with "Parte A/B" and a pause section between them', async () => {
    const plan = parsePlan(NUMBERED)
    expect(plan.how).toBe('headings')
    expect(plan.parts.map(p => p.id)).toEqual(['A', 'B'])
    expect(plan.parts.map(p => p.title)).toEqual(['6. Parte A — Backend', '8. Parte B — Frontend'])
    expect(plan.parts[0]?.pauseBefore).toBe(false)
    expect(plan.parts[1]?.pauseBefore).toBe(true)
    expect(plan.parts[0]?.criteria).toEqual(['los tests del servicio pasan', 'el endpoint está documentado'])
    // a part's section ends at the next heading of its level: the pause section is not part A's text
    expect(plan.parts[0]?.text.includes('Pausa obligatoria')).toBe(false)
    expect(nextPart(NUMBERED, 'A')).toEqual({ pause: plan.parts[1] })
  })

  test('"### Fase N —" headings, ids like 2b, a label line for the criteria', async () => {
    const plan = parsePlan(PHASES)
    expect(plan.parts.map(p => p.id)).toEqual(['1', '2b', '3'])
    expect(plan.parts[0]?.criteria).toEqual(['`npm test` pasa', 'el módulo arranca'])
    expect(plan.parts[1]?.criteria).toEqual([])
    expect(nextPart(PHASES, '1').part?.id).toBe('2b')
  })

  test('a line that only mentions stopping is not a pause ("Stop the server before…")', async () => {
    const plan = parsePlan(PHASES)
    expect(plan.parts.map(p => p.pauseBefore)).toEqual([false, false, false])
    expect(nextPart(PHASES, '2b').part?.id).toBe('3')
  })

  test('no part headings: the whole file is one part, with its criteria', async () => {
    const plan = parsePlan(SINGLE, 'login.md')
    expect(plan.how).toBe('whole')
    expect(plan.parts).toHaveLength(1)
    expect(plan.parts[0]).toMatchObject({ id: '1', title: 'Arreglar el login', pauseBefore: false, criteria: ['clicking it signs in'] })
    expect(planParts('just a sentence, no heading')[0]?.title).toBe('plan')
  })

  test('no part headings but a heading that names the steps: each ## after it is a part', async () => {
    const text = '# Migración\n\n## Pasos\n\n## Base de datos\nMigrar.\n\n## API\nAdaptar.\n'
    const plan = parsePlan(text)
    expect(plan.how).toBe('sections')
    expect(plan.parts.map(p => [p.id, p.title])).toEqual([['1', 'Base de datos'], ['2', 'API']])
  })

  test('pauses: a pause heading, a line that starts with the word (bold or not), "stop here"', async () => {
    const line = '## Part A\nDo a.\n\n**Pausa:** el equipo revisa A.\n\n## Part B\nDo b.\n'
    expect(planParts(line)[1]?.pauseBefore).toBe(true)
    const heading = '## Part A\nDo a.\n## Part B (stop here for a human decision)\nDo b.\n'
    expect(planParts(heading)[1]?.pauseBefore).toBe(true)
    const plain = '## Part A\nDo a. Then pause the job runner and go on.\n## Part B\nDo b.\n'
    expect(planParts(plain)[1]?.pauseBefore).toBe(false)
  })

  test('English, Spanish and other step words, with emphasis and numbering', async () => {
    const text = '# P\n## **Step 1** setup\n## 2. Milestone M2\n## Paso 3: cierre\n'
    expect(planParts(text).map(p => p.id)).toEqual(['1', 'M2', '3'])
  })
  test('the plan\'s title is never a part, and a heading over deeper part headings is a container (Phase 2 review, P1)', async () => {
    // the Phase 2 acceptance plan as it ran: its title read as part "2", run before A and B
    const acceptance = '# Phase 2 acceptance: the median fix\n\nA short plan.\n\n## Part A — Fix median for even-length lists\n\n1. Ask first.\n\n**Acceptance**\n- median of an even-length list as the person answered\n\n## Part B — Document median\n\nA README section.\n\n**Acceptance**\n- README.md says what median returns\n'
    const plan = parsePlan(acceptance, 'v02-fase2.md')
    expect(plan.title).toBe('Phase 2 acceptance: the median fix')
    expect(plan.parts.map(p => [p.id, p.title, p.criteria.length])).toEqual([['A', 'Part A — Fix median for even-length lists', 1], ['B', 'Part B — Document median', 1]])
    // a phase that holds its parts: the parts, not the phase; the title's number does not take a part's id
    const nested = '# Plan 2\n\n## Fase 2 — Implementación\n\n### Parte A\nUno.\n\n### Parte B\nDos.\n\n## Fase 3 — Cierre\nTres.\n'
    expect(parsePlan(nested).parts.map(p => p.id)).toEqual(['A', 'B', '3'])
    // two level-1 parts: no title among them, both are parts
    expect(parsePlan('# Part A\nUno.\n# Part B\nDos.\n').parts.map(p => p.id)).toEqual(['A', 'B'])
  })
})

describe('run ids and choosing parts', () => {
  test('the slug comes from the file name, with a suffix when taken (A-16)', async () => {
    expect(planSlug('docs/plans/Plan Foreman v0.2.md')).toBe('plan-foreman-v0-2')
    expect(planSlug('C:\\x\\PLAN.md')).toBe('plan')
    expect(freeSlug('plan', new Set())).toBe('plan')
    expect(freeSlug('plan', new Set(['plan', 'plan-2']))).toBe('plan-3')
  })

  test('--parts picks parts in plan order and names the unknown ones', async () => {
    const plan = parsePlan(PHASES)
    const picked = pickParts(plan, '3, 1')
    expect('parts' in picked && picked.parts.map(p => p.id)).toEqual(['1', '3'])
    expect(pickParts(plan, '1,9')).toEqual({ error: '--parts names 9, which the plan does not have (its parts: 1, 2b, 3)' })
  })

  test('the preview says each part, its criteria and the pauses', async () => {
    expect(planPreview(parsePlan(NUMBERED))).toEqual([
      'A · 6. Parte A — Backend (2 criteria)',
      'B · 8. Parte B — Frontend (no acceptance criteria found) · the plan pauses before it',
    ])
  })
})
