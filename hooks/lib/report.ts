// report.md (M4): what a plan run did, written by foreman from its records when
// the plan is done, and the body of the pull request a `pr` delivery opens
// (D-72). Pure: register.tsx gathers the records and writes the file.

import type { ForemanCycle, ForemanPlanRun, ForemanReview, ForemanThread } from '../../types'
import { partCycleId } from './run'

/** A line of decisions.jsonl, as much of it as the report reads. */
export type ReportDecision = { at: string; part: string; stop: string; decision: string; by: string; text?: string; reason?: string; costUsd?: number }

const one = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const usd = (n: number) => `${n.toFixed(2)} USD`

/** The report of a run, from what foreman recorded of it. */
export function reportMarkdown(o: {
  run: ForemanPlanRun
  cycles: readonly ForemanCycle[]
  threads: readonly ForemanThread[]
  reviews: readonly ForemanReview[]
  decisions: readonly ReportDecision[]
}): string {
  const { run } = o
  const where = run.branch ? `branch \`${run.branch}\`${run.base ? ` from \`${run.base}\`` : ''}` : 'the checkout as it was'
  const lines: string[] = [
    `# ${run.title}`,
    '',
    `Plan \`${run.plan}\` · ${run.parts.length} part(s) · ${where}.`,
    '',
    'Written by foreman from its records of the run.',
    '',
    '## Parts',
    '',
  ]
  let reviewCost = 0
  let supervisorCost = 0
  for (const p of run.parts) {
    const c = o.cycles.find(x => x.id === partCycleId(run.id, p.id))
    const state = !c ? 'not started' : c.phase === 'ready' ? 'done' : c.phase
    lines.push(`### ${p.id} · ${p.title} — ${state}`, '')
    if (!c) { lines.push('Not started.', ''); continue }
    const t = o.threads.find(x => x.id === c.implThread)
    if (t?.lastResult?.summary) lines.push(one(t.lastResult.summary, 600), '')
    if (t?.lastResult?.commits?.length) lines.push(`- Commits: ${t.lastResult.commits.map(x => `\`${x.slice(0, 12)}\``).join(', ')}`)
    if (t?.lastResult?.gates?.length) lines.push(`- Gates the implementer ran: ${t.lastResult.gates.map(g => `\`${g.cmd}\` → ${g.exit}`).join(', ')}`)
    const revs = o.reviews.filter(r => r.runId === run.id && r.part === p.id && r.finishedAt).sort((a, b) => a.n - b.n)
    if (revs.length) lines.push(`- Reviews: ${revs.map(r => `r${r.n} ${r.couldNotRun?.length ? 'could not run' : r.verdict === 'none' ? 'no verdict' : r.verdict}${r.verdict === 'NO' ? ` (${r.findings} finding${r.findings === 1 ? '' : 's'})` : ''}`).join(', ')}`)
    for (const r of revs) reviewCost += r.run?.costUsd ?? 0
    const ds = o.decisions.filter(d => d.part === p.id)
    for (const d of ds) {
      supervisorCost += d.costUsd ?? 0
      const said = d.decision === 'answer' || d.decision === 'replan' ? d.text : d.reason
      lines.push(`- ${d.at.slice(11, 16)} ${d.by === 'code' ? 'foreman' : 'the supervisor'}: ${d.decision}${said ? ` — ${one(said, 300)}` : ''}`)
    }
    lines.push('')
  }
  if (run.prepare) lines.push('## The worktree', '', `\`${run.prepare.cmd}\` ${run.prepare.state === 'done' ? `ran (exit ${run.prepare.exit ?? 0})` : run.prepare.state === 'failed' ? `failed (exit ${run.prepare.exit ?? '?'})` : 'is running'} before the first part.`, '')
  const d = run.delivery
  if (d) {
    lines.push('## Delivery', '')
    lines.push(`- Mode: ${d.mode}${d.note ? ` (${d.note})` : ''}`)
    if (d.url) lines.push(`- Pull request: ${d.url}`)
    if (d.state === 'failed') lines.push(`- Not delivered: ${d.reason ?? 'a step failed'}`)
    if (d.worktree) lines.push(`- Worktree: ${d.worktree}`)
    lines.push('')
  }
  if (reviewCost > 0 || supervisorCost > 0) {
    lines.push('## Cost of the processes', '', `- Reviews: ${usd(reviewCost)}`, `- Supervisor: ${usd(supervisorCost)}`, '- The implementers\' threads count against the person\'s own usage.', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
