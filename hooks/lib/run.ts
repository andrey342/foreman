// A plan run (plan §8 run.ts): the parts of one plan, worked one after the
// other, each by its own cycle (cycle.ts). Pure: `stepPlan` reads the run and
// the cycle of its current part and says what comes next; register.tsx starts
// the cycles and writes the files. Phase 1: no modes and no supervisor yet, so
// a part that ends ready starts the next unless the plan asks for a pause
// (D-76) or the person paused the run; every other stop waits for the person.

import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../../types'

export type PlanEffect =
  /** Start the cycle of `parts[index]` (once: the caller checks no cycle of that part exists). */
  | { kind: 'start'; index: number }
  | { kind: 'notify'; text: string }

export type PlanStep = { run: ForemanPlanRun; effects: PlanEffect[]; moved: boolean }

const ACTIVE: readonly ForemanPlanRun['status'][] = ['running', 'paused']

export function isPlanActive(r: ForemanPlanRun): boolean {
  return ACTIVE.includes(r.status)
}

/** The run's cycle id for a part: `<run id>:<part>`. */
export const partCycleId = (runId: string, part: string) => `${runId}:${part}`

function moved(r: ForemanPlanRun, nowIso: string, extra: Partial<ForemanPlanRun>): ForemanPlanRun {
  const next: ForemanPlanRun = { ...r, ...extra, updatedAt: nowIso }
  if (next.status === 'running' || next.status === 'done') delete next.reason
  return next
}

/**
 * One look at a run. `current` is the cycle of the run's current part, as the
 * registry has it (undefined: not started yet). A paused or finished run does
 * not move here: `/foreman resume` sets a paused one running again.
 */
export function stepPlan(r: ForemanPlanRun, current: ForemanCycle | undefined, nowIso: string): PlanStep {
  const stay: PlanStep = { run: r, effects: [], moved: false }
  if (r.status !== 'running') return stay
  const part = r.parts[r.current]
  if (!part) return stay
  if (!current) return { run: r, effects: [{ kind: 'start', index: r.current }], moved: false }
  if (current.phase !== 'ready') return stay
  const nextIndex = r.current + 1
  const next = r.parts[nextIndex]
  if (!next) {
    const done = moved(r, nowIso, { status: 'done', finishedAt: nowIso })
    return { run: done, effects: [{ kind: 'notify', text: `${r.id}: the plan is done, all ${r.parts.length} part(s) ready` }], moved: true }
  }
  if (next.pauseBefore) {
    const reason = `the plan asks for a pause before part ${next.id}; /foreman resume ${r.id} goes on`
    return { run: moved(r, nowIso, { status: 'paused', reason }), effects: [{ kind: 'notify', text: `${r.id}: part ${part.id} ready; ${reason}` }], moved: true }
  }
  return { run: r, effects: [{ kind: 'start', index: nextIndex }], moved: false }
}

/** The run once the cycle of `parts[index]` exists: that part is the current one. */
export function atPart(r: ForemanPlanRun, index: number, nowIso: string): ForemanPlanRun {
  return index === r.current ? r : moved(r, nowIso, { current: index })
}

export function pauseRun(r: ForemanPlanRun, nowIso: string, reason: string): ForemanPlanRun {
  return moved(r, nowIso, { status: 'paused', reason })
}

/** A paused run goes on: the part after a ready one starts at the next look, even past a pause the plan asked for. */
export function resumeRun(r: ForemanPlanRun, nowIso: string): ForemanPlanRun {
  const next = r.parts[r.current + 1]
  // the person's resume is the answer to the plan's pause before the next part
  const parts = next?.pauseBefore ? r.parts.map((p, i) => (i === r.current + 1 ? { ...p, pauseBefore: false } : p)) : r.parts
  return moved(r, nowIso, { status: 'running', parts })
}

export function stopRun(r: ForemanPlanRun, nowIso: string, reason: string): ForemanPlanRun {
  return moved(r, nowIso, { status: 'stopped', reason, finishedAt: nowIso })
}

/** A one-line state of the run, for status and the pane. */
export function runLine(r: ForemanPlanRun, cycles: readonly ForemanCycle[]): string {
  const part = r.parts[r.current]
  const c = part ? cycles.find(x => x.id === partCycleId(r.id, part.id)) : undefined
  const where = part ? `part ${part.id} (${r.current + 1}/${r.parts.length})${c ? ` ${c.phase}${c.reason ? `: ${c.reason}` : ''}` : ''}` : ''
  return `${r.id} · ${r.status}${r.reason && r.status !== 'running' ? ` (${r.reason})` : ''} · ${where}`.replace(/ · $/, '')
}

/**
 * progress.md (D-70): what foreman knows of the run, written from its own
 * records after every change, never by a thread. The memory a resumed or a
 * new thread is pointed to.
 */
export function progressMarkdown(r: ForemanPlanRun, cycles: readonly ForemanCycle[], threads: readonly ForemanThread[]): string {
  const lines = [
    `# ${r.title}`,
    '',
    `Plan \`${r.plan}\` · run \`${r.id}\` · ${r.status}${r.reason ? ` (${r.reason})` : ''} · started ${r.startedAt}${r.finishedAt ? ` · ended ${r.finishedAt}` : ''}`,
    '',
    'Written by foreman from its records; threads read it, they do not edit it.',
    '',
  ]
  r.parts.forEach((p, i) => {
    const c = cycles.find(x => x.id === partCycleId(r.id, p.id))
    const state = c ? c.phase : i < r.current ? 'skipped' : 'not started'
    lines.push(`## Part ${p.id} · ${p.title}`, '', `- State: ${state}${c?.reason ? ` (${c.reason})` : ''}${p.pauseBefore ? ' · the plan pauses before it' : ''}`)
    if (c) {
      lines.push(`- From commit \`${c.base.slice(0, 12)}\`; reviews: ${c.rounds.length ? c.rounds.map(x => `r${x.n} ${x.verdict}${x.findings ? ` (${x.findings})` : ''}`).join(', ') : 'none yet'}`)
      const t = threads.find(x => x.id === c.implThread)
      if (t?.lastResult) {
        lines.push(`- Last result: ${t.lastResult.status} · ${t.lastResult.summary.replace(/\s+/g, ' ').slice(0, 300)}`)
        if (t.lastResult.commits?.length) lines.push(`- Commits: ${t.lastResult.commits.map(x => `\`${x}\``).join(', ')}`)
        if (t.lastResult.gates?.length) lines.push(`- Gates: ${t.lastResult.gates.map(g => `\`${g.cmd}\` → ${g.exit}`).join(', ')}`)
      }
    }
    lines.push('')
  })
  return `${lines.join('\n').trimEnd()}\n`
}
