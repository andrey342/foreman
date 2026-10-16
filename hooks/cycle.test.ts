import { describe, expect, test } from 'claude-code/testing'
import type { ForemanCycle, ForemanReview, ForemanThread } from '../types'
import { REVIVE_MAX, applyMessage, bindRound, isActive, pendingRequest, reviveMessage, stepCycle } from './lib/cycle'
import { standing } from './lib/owner'

const T0 = '2026-10-10T01:00:00.000Z'
const T1 = '2026-10-10T01:05:00.000Z'
const T2 = '2026-10-10T01:10:00.000Z'

const C: ForemanCycle = {
  id: 'c1:A', runId: 'c1', part: 'A', plan: 'docs/plan.md', base: 'abc1234', implThread: 'aaaa0001', maxCycles: 2,
  rounds: [], phase: 'implementing', phaseAt: T0, owner: 'me', startedAt: T0, updatedAt: T0,
}
const TH: ForemanThread = { id: 'aaaa0001', sessionId: 's', name: 'foreman:c1:implementer-A', role: 'implementer', cwd: 'C:\\demo', model: 'sonnet', effort: 'high', startedAt: T0, updatedAt: T0, sentAt: T0, state: 'working' }
const th = (state: ForemanThread['state'], extra: Partial<ForemanThread> = {}): ForemanThread => ({ ...TH, state, updatedAt: T1, ...extra })
const RV = (verdict: ForemanReview['verdict'], extra: Partial<ForemanReview> = {}): ForemanReview => ({ kind: 'review', runId: 'c1', part: 'A', n: 1, file: '.claude/runs/c1/review-A-r1.md', agentId: 'ag1', startedAt: T1, finishedAt: T2, verdict, findings: verdict === 'NO' ? 2 : 0, ...extra })
const reviewing = (rounds = 1): ForemanCycle => ({
  ...C, phase: 'reviewing', phaseAt: T1, reviewRequestedAt: T1,
  rounds: Array.from({ length: rounds }, (_, i) => ({ n: i + 1, file: `.claude/runs/c1/review-A-r${i + 1}.md`, agentId: `ag${i + 1}`, verdict: i + 1 < rounds ? 'NO' : 'none', findings: 0 })),
})
const look = (c: ForemanCycle, thread: ForemanThread | undefined, review?: ForemanReview) => stepCycle(c, { thread, review, nowIso: T2 })

describe('the transition table (plan §5)', () => {
  test('implementing + thread working: stays, nothing to do', async () => {
    expect(look(C, th('working'))).toEqual({ cycle: C, effects: [], moved: false })
  })
  test('implementing + thread ready (a turn of this phase): reviewing, review round 1 requested', async () => {
    const s = look(C, th('ready'))
    expect(s.cycle).toMatchObject({ phase: 'reviewing', phaseAt: T2, reviewRequestedAt: T2 })
    expect(s.effects).toEqual([{ kind: 'review', n: 1 }])
  })
  test('implementing + a ready from before the phase began: not a new turn, stays', async () => {
    expect(look({ ...C, phaseAt: T2 }, th('ready', { updatedAt: T1 })).moved).toBe(false)
  })
  test('implementing + question / blocked / failed / stopped by the person / dialog: waiting on the thread, never an answer', async () => {
    for (const [state, extra] of [['waiting', {}], ['blocked', {}], ['failed', {}], ['stopped', { heldBy: 'person' }]] as const) {
      const s = look(C, th(state, { waitingFor: 'A or B?', ...extra }))
      expect(s.cycle).toMatchObject({ phase: 'waiting', waitingOn: 'thread' })
      expect(s.cycle.reason).toContain(state)
      expect(s.effects).toEqual([{ kind: 'notify', text: `c1:A: waiting, ${s.cycle.reason}`, level: 'stop' }])
    }
  })
  test('implementing + thread stopped mid-turn (the app closed): revived, at most REVIVE_MAX times, then the person decides', async () => {
    const s = look(C, th('stopped', { waitingFor: 'its process ended mid-turn' }))
    expect(s.cycle).toMatchObject({ phase: 'implementing', revived: 1 })
    expect(s.effects).toEqual([{ kind: 'revive' }])
    // from waiting on the thread too (a stop seen before this look)
    const w = look({ ...C, phase: 'waiting', waitingOn: 'thread', reason: 'x' }, th('stopped', { waitingFor: 'its process ended mid-turn' }))
    expect(w.cycle).toMatchObject({ phase: 'implementing', revived: 1 })
    expect(w.moved).toBe(true)
    const spent = look({ ...C, revived: REVIVE_MAX }, th('stopped', { waitingFor: 'its process ended mid-turn' }))
    expect(spent.cycle).toMatchObject({ phase: 'waiting', waitingOn: 'thread' })
    expect(spent.effects.map(e => e.kind)).toEqual(['notify'])
    // not revived: an exit while a dialog was open (Open is the way), a session gone from the CLI's list, a plan the person paused, a thread open in the app
    expect(look(C, th('stopped', { waitingFor: 'its session is gone from claude agents' })).effects.map(e => e.kind)).toEqual(['notify'])
    expect(stepCycle(C, { thread: th('stopped', { waitingFor: 'its process ended mid-turn' }), review: undefined, nowIso: T2, runPaused: true }).effects.map(e => e.kind)).toEqual(['notify'])
    expect(look(C, th('stopped', { waitingFor: 'exited while blocked' })).effects.map(e => e.kind)).toEqual(['notify'])
    const inApp = look(C, th('stopped', { openedAt: T1 }))
    expect(inApp.cycle.reason).toBe('the implementer is open in the app: answer it there')
    expect(inApp.effects).toEqual([{ kind: 'notify', text: 'c1:A: waiting, the implementer is open in the app: answer it there', level: 'info' }])
    // the same thread blocked in the app: the same reason, nothing said twice
    expect(look(inApp.cycle, th('blocked', { openedAt: T1 })).moved).toBe(false)
    const msg = reviveMessage({ part: 'A', plan: 'docs/plan.md', brief: 'C:\\demo\\.git\\foreman\\plan\\brief-A.md', progress: 'C:\\demo\\.git\\foreman\\plan\\progress.md' })
    expect(msg).toContain('part A of the plan `docs/plan.md`: your brief is `C:\\demo\\.git\\foreman\\plan\\brief-A.md`')
    expect(msg).toContain('`git status`')
  })
  test('implementing + thread at a usage limit: limit (the thread layer retries)', async () => {
    const s = look(C, th('limit', { retryAt: T2 }))
    expect(s.cycle.phase).toBe('limit')
    expect(s.effects).toEqual([])
    expect(look(s.cycle, th('working', { updatedAt: T2 })).cycle.phase).toBe('implementing')
  })
  test('reviewing + no review bound, or still running: stays', async () => {
    expect(look(reviewing(), th('ready'), undefined).moved).toBe(false)
    expect(look(reviewing(), th('ready'), RV('none', { finishedAt: undefined })).moved).toBe(false)
  })
  test('reviewing + OK: ready, notified', async () => {
    const s = look(reviewing(), th('ready'), RV('OK'))
    expect(s.cycle).toMatchObject({ phase: 'ready', rounds: [{ n: 1, verdict: 'OK' }] })
    expect(s.effects).toEqual([{ kind: 'notify', text: 'c1:A: ready, review r1 OK after 1 round(s)', level: 'info' }])
    expect(isActive(s.cycle)).toBe(false)
  })
  test('reviewing + NO with rounds left: applying, the implementer is sent the review path only', async () => {
    const s = look(reviewing(), th('ready'), RV('NO'))
    expect(s.cycle).toMatchObject({ phase: 'applying', applyFor: 1, rounds: [{ n: 1, verdict: 'NO', findings: 2 }] })
    expect(s.effects).toEqual([{ kind: 'apply', round: { n: 1, file: '.claude/runs/c1/review-A-r1.md', agentId: 'ag1', verdict: 'NO', findings: 2 } }])
    const msg = applyMessage({ n: 1, file: '.claude/runs/c1/review-A-r1.md', agentId: 'ag1', verdict: 'NO', findings: 2 })
    expect(msg).toContain('`.claude/runs/c1/review-A-r1.md`')
    expect(msg).toContain('foreman-result')
    // 0.2: no report.md, no "commit with explicit paths" in the brief (plan §2d)
    expect(msg.includes('report.md')).toBe(false)
    expect(msg.includes('explicit paths')).toBe(false)
  })
  test('reviewing + NO on the last round: waiting on the person, "rounds used up"', async () => {
    const s = look(reviewing(2), th('ready'), RV('NO', { n: 2, agentId: 'ag2', file: '.claude/runs/c1/review-A-r2.md' }))
    expect(s.cycle).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
    expect(s.cycle.reason).toContain('review rounds used up (2 of 2)')
    expect(s.effects.map(e => e.kind)).toEqual(['notify'])
  })
  test('reviewing + BLOCKED, or no verdict: waiting on the person', async () => {
    expect(look(reviewing(), th('ready'), RV('BLOCKED')).cycle).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: 'the reviewer is blocked (.claude/runs/c1/review-A-r1.md)' })
    const none = look(reviewing(), th('ready'), RV('none', { noResult: true, reason: 'the review file was not written' }))
    expect(none.cycle.reason).toBe('review r1 gave no verdict (the review file was not written)')
  })
  test('reviewing + a settled review of another agent (a stale round): stays', async () => {
    expect(look(reviewing(), th('ready'), RV('OK', { agentId: 'someone-else' })).moved).toBe(false)
  })
  test('applying does not move by itself (its effect does)', async () => {
    expect(look({ ...reviewing(), phase: 'applying' }, th('ready')).moved).toBe(false)
  })
  test('waiting on the thread follows the thread; on the person, only a message the person sent after the wait', async () => {
    const onThread: ForemanCycle = { ...C, phase: 'waiting', waitingOn: 'thread', reason: 'the implementer is waiting: A or B?', phaseAt: T1 }
    expect(look(onThread, th('working', { updatedAt: T2 })).cycle.phase).toBe('implementing')
    const onPerson: ForemanCycle = { ...C, phase: 'waiting', waitingOn: 'person', reason: 'rounds used up', phaseAt: T1 }
    expect(look(onPerson, th('working', { sentAt: T0 })).moved).toBe(false)
    expect(look(onPerson, th('ready')).moved).toBe(false)
    expect(look(onPerson, th('working', { sentAt: T2 })).cycle.phase).toBe('implementing')
  })
  test('ready and closed are terminal', async () => {
    for (const phase of ['ready', 'closed'] as const) expect(look({ ...C, phase }, th('working')).moved).toBe(false)
  })
  test('the implementer gone from the registry: waiting, said once', async () => {
    const s = look(C, undefined)
    expect(s.cycle).toMatchObject({ phase: 'waiting', reason: 'its implementer thread is gone from the registry' })
    expect(look(s.cycle, undefined).moved).toBe(false)
  })
  test('OK notifies and nothing more: the plan run, not the cycle, starts the next part (run.ts)', async () => {
    expect(look(reviewing(), th('ready'), RV('OK')).effects.map(e => e.kind)).toEqual(['notify'])
  })
})

describe('rounds and requests', () => {
  test('the review a request started is found and bound, once', async () => {
    const c = { ...C, phase: 'reviewing' as const, reviewRequestedAt: T1 }
    const r = RV('none', { finishedAt: undefined, startedAt: T1 })
    expect(pendingRequest(c, [RV('OK', { agentId: 'old', startedAt: T0 }), r])).toEqual(r)
    const bound = bindRound(c, r, T2)
    expect(bound.rounds).toEqual([{ n: 1, file: r.file, agentId: 'ag1', verdict: 'none', findings: 0 }])
    expect(bound.updatedAt).toBe(T2)
    expect(pendingRequest(bound, [r])).toBe(undefined)
  })
})

describe('owners (N-02, C3-03)', () => {
  const rows = [{ sessionId: 'alive', pid: 1, cwd: 'C:\\demo', kind: 'interactive', startedAt: 0 }, { sessionId: 'gone', cwd: 'C:\\demo', kind: 'interactive', startedAt: 0 }]
  test('mine, another live session, or an orphan', async () => {
    expect(standing('me', 'me', rows)).toBe('mine')
    expect(standing('alive', 'me', rows)).toBe('other')
    expect(standing('gone', 'me', rows)).toBe('orphan')
    expect(standing('never-listed-p-run', 'me', rows)).toBe('orphan')
    expect(standing(undefined, 'me', rows)).toBe('orphan')
  })
})
