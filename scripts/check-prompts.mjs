// Checks prompts/supervisor.md against hooks/lib/supervisor.ts (D-68, Phase 3 criterion 1b),
// and docs/plan-template.md against the template /foreman setup writes (D-74):
// the prompt takes every placeholder the brief fills, and never writes a row of the authority
// table or of what the supervisor decides alone itself (one source: the table in supervisor.ts).
// Usage: node scripts/check-prompts.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const prompt = readFileSync(join(root, 'prompts', 'supervisor.md'), 'utf8')
const source = readFileSync(join(root, 'hooks', 'lib', 'supervisor.ts'), 'utf8')

const PLACEHOLDERS = ['plan', 'part', 'partTitle', 'partText', 'criteria', 'stop', 'implementer', 'review', 'delivery', 'decidesAlone', 'escalateAlways', 'allowed', 'history', 'runsLeft']
const problems = []
for (const p of PLACEHOLDERS) if (!prompt.includes(`{{${p}}}`)) problems.push(`prompts/supervisor.md: no {{${p}}}`)

// the table's labels and the "decides alone" lines, as supervisor.ts writes them
const table = source.slice(source.indexOf('export const ALWAYS_ESCALATE'), source.indexOf('/** The decisions a stop allows'))
const alone = source.slice(source.indexOf('export const DECIDES_ALONE'), source.indexOf('/**\n * What always goes to the person'))
const strings = text => [...text.matchAll(/'((?:\\'|[^'])+)'/g)].map(m => m[1].replace(/\\'/g, '\''))
const labels = [...table.matchAll(/label: '((?:\\'|[^'])+)'/g)].map(m => m[1].replace(/\\'/g, '\''))
const rows = [...labels, ...strings(alone)]
if (labels.length < 9) problems.push(`hooks/lib/supervisor.ts: ${labels.length} rows read from ALWAYS_ESCALATE, expected 9`)
for (const r of rows) if (prompt.includes(r)) problems.push(`prompts/supervisor.md writes "${r}" itself: it must come from the table ({{escalateAlways}} / {{decidesAlone}})`)

// docs/plan-template.md is the template /foreman setup writes (PLAN_TEMPLATE in hooks/lib/setup.ts), word for word (D-74)
const setup = readFileSync(join(root, 'hooks', 'lib', 'setup.ts'), 'utf8')
const written = /export const PLAN_TEMPLATE = `([\s\S]*?)`\n/.exec(setup)?.[1]
const template = readFileSync(join(root, 'docs', 'plan-template.md'), 'utf8').replace(/\r\n/g, '\n')
if (written === undefined) problems.push('hooks/lib/setup.ts: no PLAN_TEMPLATE')
else if (written !== template) problems.push('docs/plan-template.md differs from PLAN_TEMPLATE in hooks/lib/setup.ts')

console.log(`prompts/supervisor.md: ${PLACEHOLDERS.length} placeholder(s) checked; ${labels.length} escalation row(s) and ${rows.length - labels.length} "decides alone" line(s) from the table, none copied into the prompt; docs/plan-template.md checked against setup's; ${problems.length} problem(s)`)
for (const p of problems) console.log(`  - ${p}`)
process.exit(problems.length ? 1 : 0)
