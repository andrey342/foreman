// A plan run (plan §8 run.ts): the parts of one plan, worked one after the
// other, each by its own cycle (cycle.ts). Pure: `stepPlan` reads the run and
// the cycle of its current part and says what comes next; register.tsx starts
// the cycles and writes the files. One mode (D-111): a part that ends ready
// starts the next unless the plan asks for a pause (D-76) or the person paused
// the run; the stops inside a part are the cycle's and its supervisor's.

import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../../types'

/** How a notice is given (M1): `info` in the pane and a toast; `stop` and `done` also by PushNotification. */
export type NoticeLevel = 'info' | 'stop' | 'done'

export type PlanEffect =
  /** Start the cycle of `parts[index]` (once: the caller checks no cycle of that part exists). */
  | { kind: 'start'; index: number }
  | { kind: 'notify'; text: string; level: NoticeLevel }

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
  // the worktree's install command runs first (D-71): no part starts before it is done
  if (!current) return r.prepare && r.prepare.state !== 'done' ? stay : { run: r, effects: [{ kind: 'start', index: r.current }], moved: false }
  if (current.phase !== 'ready') return stay
  const nextIndex = r.current + 1
  const next = r.parts[nextIndex]
  if (!next) {
    const done = moved(r, nowIso, { status: 'done', finishedAt: nowIso })
    return { run: done, effects: [{ kind: 'notify', text: `${r.id}: the plan is done, all ${r.parts.length} part(s) ready`, level: 'done' }], moved: true }
  }
  const reason = !next.go && next.pauseBefore ? `the plan asks you to check before part ${next.id}; Continue (or /foreman resume ${r.id}) goes on` : undefined
  if (reason) {
    return { run: moved(r, nowIso, { status: 'paused', reason }), effects: [{ kind: 'notify', text: `${r.id}: part ${part.id} ready; ${reason}`, level: 'stop' }], moved: true }
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

/**
 * A paused run goes on. At a part boundary (`atBoundary`: the current part is
 * ready) the person's word is the answer to the plan's pause before the next
 * part: that part is marked `go` and
 * starts at the next look. A run the person paused mid-part only runs again;
 * the next part's own pause still holds.
 */
export function resumeRun(r: ForemanPlanRun, nowIso: string, atBoundary: boolean): ForemanPlanRun {
  const parts = atBoundary ? r.parts.map((p, i) => (i === r.current + 1 ? { ...p, go: true } : p)) : r.parts
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
  const delivery = r.status === 'done' && r.delivery?.state === 'failed' ? ` · not delivered: ${r.delivery.reason ?? 'a step failed'}` : r.status === 'done' && r.delivery?.url ? ` · ${r.delivery.url}` : ''
  return `${r.id} · ${r.status}${delivery}${r.branch ? ` · branch ${r.branch}` : ''}${r.reason && r.status !== 'running' ? ` (${r.reason})` : ''} · ${where}`.replace(/ · $/, '')
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
    ...(r.branch ? ['', r.status === 'stopped' || (r.status === 'done' && r.delivery?.state === 'failed')
      ? `Kept, with the work in them: the branch \`${r.branch}\`${r.isolation === 'worktree' && r.tree ? ` and foreman's worktree \`${r.tree}\`` : ''}. foreman never deletes them.`
      : `The plan works on the branch \`${r.branch}\`${r.isolation === 'worktree' && r.tree ? ` in foreman's worktree \`${r.tree}\`` : ''}; foreman delivers it when the plan is done.`] : []),
    '',
    'Written by foreman from its records; threads read it, they do not edit it.',
    '',
  ]
  r.parts.forEach((p, i) => {
    const c = cycles.find(x => x.id === partCycleId(r.id, p.id))
    const state = c ? c.phase : i < r.current ? 'skipped' : 'not started'
    lines.push(`## Part ${p.id} · ${p.title}`, '', `- State: ${state}${c?.reason ? ` (${c.reason})` : ''}${p.pauseBefore && !p.go ? ' · the plan pauses before it' : ''}`)
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
