// A plan run (run.ts): parts one after the other, pauses, the end, progress.md.
import { describe, expect, test } from 'claude-code/testing'
import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../types'
import { atPart, isPlanActive, partCycleId, pauseRun, progressMarkdown, resumeRun, runLine, stepPlan } from './lib/run'

const T0 = '2026-10-16T10:00:00.000Z'
const T1 = '2026-10-16T10:30:00.000Z'
const RUN: ForemanPlanRun = {
  id: 'plan', plan: 'docs/plan.md', title: 'The plan', dir: 'C:\\demo\\.git\\foreman\\plan',
  parts: [{ id: 'A', title: 'Part A' }, { id: 'B', title: 'Part B' }, { id: 'C', title: 'Part C', pauseBefore: true }],
  current: 0, status: 'running', owner: 'me', startedAt: T0, updatedAt: T0,
}
const cycle = (part: string, phase: ForemanCycle['phase']): ForemanCycle => ({
  id: partCycleId('plan', part), runId: 'plan', part, plan: 'docs/plan.md', base: 'abc1234def', implThread: `t${part}`, maxCycles: 3,
  rounds: phase === 'ready' ? [{ n: 1, file: 'r', agentId: 'a', verdict: 'OK', findings: 0 }] : [], phase, phaseAt: T0, startedAt: T0, updatedAt: T0,
})

describe('the run steps (no supervisor yet)', () => {
  test('a part with no cycle yet is started', async () => {
    expect(stepPlan(RUN, undefined, T1)).toEqual({ run: RUN, effects: [{ kind: 'start', index: 0 }], moved: false })
  })
  test('a part still at work: nothing happens, whatever its phase', async () => {
    for (const phase of ['implementing', 'reviewing', 'applying', 'waiting', 'limit'] as const) {
      expect(stepPlan(RUN, cycle('A', phase), T1).effects).toEqual([])
    }
  })
  test('a part ready: the next one starts', async () => {
    expect(stepPlan(RUN, cycle('A', 'ready'), T1).effects).toEqual([{ kind: 'start', index: 1 }])
    expect(atPart(RUN, 1, T1)).toMatchObject({ current: 1, updatedAt: T1 })
  })
  test('a part ready before one the plan pauses for: paused, said, nothing started', async () => {
    const s = stepPlan({ ...RUN, current: 1 }, cycle('B', 'ready'), T1)
    expect(s.run).toMatchObject({ status: 'paused', reason: 'the plan asks you to check before part C; Continue (or /foreman resume plan) goes on' })
    expect(s.effects).toEqual([{ kind: 'notify', text: 'plan: part B ready; the plan asks you to check before part C; Continue (or /foreman resume plan) goes on', level: 'stop' }])
    expect(isPlanActive(s.run)).toBe(true)
    // resumed at the boundary: the pause the plan asked for is answered, and C starts at the next look
    const resumed = resumeRun(s.run, T1, true)
    expect(resumed.status).toBe('running')
    expect(resumed.reason).toBe(undefined)
    expect(resumed.parts[2]).toEqual({ id: 'C', title: 'Part C', pauseBefore: true, go: true })
    expect(stepPlan(resumed, cycle('B', 'ready'), T1).effects).toEqual([{ kind: 'start', index: 2 }])
  })
  test('the last part ready: the plan is done', async () => {
    const s = stepPlan({ ...RUN, current: 2 }, cycle('C', 'ready'), T1)
    expect(s.run).toMatchObject({ status: 'done', finishedAt: T1 })
    expect(s.effects).toEqual([{ kind: 'notify', text: 'plan: the plan is done, all 3 part(s) ready', level: 'done' }])
    expect(isPlanActive(s.run)).toBe(false)
  })
  test('a paused run does not move; the person\'s pause keeps the part in progress going', async () => {
    const paused = pauseRun(RUN, T1, 'paused by the person')
    expect(stepPlan(paused, cycle('A', 'ready'), T1).effects).toEqual([])
    expect(runLine(paused, [cycle('A', 'implementing')])).toBe('plan · paused (paused by the person) · part A (1/3) implementing')
  })
  test('the person resumes mid-part: the run goes on, and the pause the plan asks for before the next part still holds', async () => {
    const paused = pauseRun({ ...RUN, current: 1 }, T1, 'paused by the person')
    const resumed = resumeRun(paused, T1, false)
    expect(resumed.status).toBe('running')
    expect(resumed.parts[2]?.go).toBe(undefined)
    expect(stepPlan(resumed, cycle('B', 'ready'), T1).run.status).toBe('paused')
  })
})

describe('one mode (D-111)', () => {
  test('a run recorded with the retired review mode chains its parts as any other; the line says no mode', async () => {
    const old = { ...RUN, mode: 'review' } as ForemanPlanRun
    expect(stepPlan(old, cycle('A', 'ready'), T1).effects).toEqual([{ kind: 'start', index: 1 }])
    expect(runLine(old, [cycle('A', 'implementing')])).toBe('plan · running · part A (1/3) implementing')
  })
})

describe('progress.md (D-70)', () => {
  test('one section per part, with what foreman recorded', async () => {
    const t: ForemanThread = {
      id: 'tA', sessionId: 's', name: 'foreman:plan:implementer-A', role: 'implementer', cwd: 'C:\\demo', model: 'opus', effort: 'high', startedAt: T0, updatedAt: T1, state: 'ready',
      lastResult: { status: 'done', summary: 'added the endpoint', commits: ['abc1234'], gates: [{ cmd: 'npm test', exit: 0 }] },
    }
    const md = progressMarkdown({ ...RUN, current: 1 }, [cycle('A', 'ready'), cycle('B', 'implementing')], [t])
    expect(md).toContain('# The plan')
    expect(md).toContain('## Part A · Part A\n\n- State: ready')
    expect(md).toContain('reviews: r1 OK')
    expect(md).toContain('- Last result: done · added the endpoint')
    expect(md).toContain('- Commits: `abc1234`')
    expect(md).toContain('- Gates: `npm test` → 0')
    expect(md).toContain('## Part B · Part B\n\n- State: implementing')
    expect(md).toContain('## Part C · Part C\n\n- State: not started · the plan pauses before it')
  })
})
