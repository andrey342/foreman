import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../types'
import { groupOf, isUnder, repoRows, statusLine } from './lib/agents'
import { partCycleId } from './lib/run'
import { atPause, decisionToShow, needsYou, partTitle, reviewToShow, shownStill, statusWords } from './ui/pane'

const NOW = 1_791_577_700_000
const ROOT = 'C:\\MSG'

const AGENTS = [
  { pid: 1, id: 'aaaa0001', cwd: 'C:\\MSG', kind: 'background', startedAt: NOW - 60_000, sessionId: 'aaaa0001-x', name: 'foreman:r1:implementer-A', status: 'busy', state: 'working' },
  { pid: 2, id: 'aaaa0002', cwd: 'C:\\MSG\\Backend', kind: 'background', startedAt: NOW - 120_000, sessionId: 'aaaa0002-x', name: 'c0f2', status: 'waiting', waitingFor: 'dialog open', state: 'blocked' },
  { id: 'aaaa0003', cwd: 'c:/msg', kind: 'background', startedAt: NOW - 3_600_000, sessionId: 'aaaa0003-x', name: 'old plan', state: 'done' },
  { id: 'aaaa0004', cwd: 'C:\\MSG', kind: 'background', startedAt: NOW - 30 * 86_400_000, sessionId: 'aaaa0004-x', name: 'ancient', state: 'done' },
  { pid: 5, id: 'bbbb0001', cwd: 'C:\\Other', kind: 'background', startedAt: NOW, sessionId: 'bbbb0001-x', name: 'elsewhere', status: 'idle', state: 'done' },
  { pid: 6, cwd: 'C:\\MSG', kind: 'interactive', startedAt: NOW, sessionId: 'cccc0001-x', name: 'chat', status: 'idle' },
  { pid: 7, id: 'aaaa0005', cwd: 'C:\\MSGX', kind: 'background', startedAt: NOW, sessionId: 'aaaa0005-x', name: 'prefix trap', state: 'working' },
]

/** `/foreman <args>` as the person types it. */
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

const PANE_PROPS = { title: 'foreman', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

/** The world beneath the plugin: a repo at C:\MSG, no profile, `claude agents` mocked. */
function world(on: On, agents: unknown, calls: string[][]) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const panes: { id: string; title: string }[] = []
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null, id: 'msg' } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', () => ({ value: false }))
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => { panes.push({ id: e.id, title: e.title ?? e.id }); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { panes.splice(panes.findIndex(p => p.id === e.id), 1); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    return typeof agents === 'string'
      ? { value: { exitCode: 1, stdout: '', stderr: agents, isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: JSON.stringify(agents), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('repo rows: background only, under the root, recent or live, newest first', async () => {
  const rows = repoRows(AGENTS, ROOT, NOW)
  expect(rows.map(r => r.id)).toEqual(['aaaa0001', 'aaaa0002', 'aaaa0003'])
  expect(isUnder('C:\\MSGX', ROOT)).toBe(false)
  expect(isUnder('c:/msg/backend/', ROOT)).toBe(true)
  expect(rows.map(groupOf)).toEqual(['working', 'waiting', 'done'])
  expect(statusLine(rows)).toBe('1 working · 1 waiting')
  expect(statusLine([])).toBe(undefined)
})

test('the pane with no plan (D-113): one sentence on how to start one; the repo\'s other sessions stay out; Details holds the repo, the listing and Refresh', async ($, on) => {
  const calls: string[][] = []
  world(on, AGENTS, calls)
  const run = await $.command.run(typed(''))
  expect(run.text).toContain('foreman pane')
  expect(calls[0]).toEqual(['claude', 'agents', '--json', '--all'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'foreman', surface, component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'No plan is running here. Ask in the chat: “foreman, run docs/plans/<file>.md”.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /aaaa000|Working \(|Done \(|dialog open/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /listed/ })).toBeUndefined()
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: /^C:\\MSG · listed \d\d:\d\d UTC$/ })).toBeDefined()
    const before = calls.length
    await ui.press({ key: 'refresh' })
    expect(calls.length).toBe(before + 1)
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Button', text: 'Refresh' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane says in Details when claude agents fails', async ($, on) => {
  world(on, 'boom: not logged in', [])
  await $.command.run(typed(''))
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: /Could not list background sessions: boom: not logged in/ })).toBeDefined()
  await ui.unmount()
})

test('/foreman profile with no file runs on the defaults', async ($, on) => {
  world(on, [], [])
  const run = await $.command.run(typed('profile'))
  expect(run.text).toContain('No .claude/foreman.json: running on the defaults.')
  expect(run.text).toContain('"version": 2')
  expect(run.text).toContain('"reviewRounds": 3')
  // foreman's files go under .git/foreman unless the repo names a folder (D-70)
  expect((run.text ?? '').includes('runsDir')).toBe(false)
})

test('/foreman init writes a profile that parses clean', async ($, on) => {
  world(on, [], [])
  const written: Record<string, string> = {}
  on('fs.list', () => ({ value: [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: JSON.stringify({ scripts: { test: 'jest' } }) }))
  on('fs.write', ($, e) => { written[e.path] = e.text; return { value: undefined } })
  const run = await $.command.run(typed('init'))
  expect(run.text).toContain('Wrote C:\\MSG/.claude/foreman.json')
  const paths = Object.keys(written)
  expect(paths.map(p => p.replace(/\\/g, '/'))).toEqual(['C:/MSG/.claude/foreman.json'])
  const text = written[paths[0] ?? ''] ?? ''
  expect(JSON.parse(text)).toEqual({ version: 2, gates: { checks: ['npm test'] } })
})

// ---------------------------------------------------------------- the live round of Phase 3b (V-1…V-7)

describe('the pane after the live round of Phase 3b', () => {
  const T = '2026-10-17T10:00:00.000Z'
  const plan = (o: Partial<ForemanPlanRun> = {}): ForemanPlanRun => ({
    id: 'p', plan: 'docs/p.md', title: 'P', dir: 'C:\\x',
    parts: [{ id: 'A', title: 'Part A — Fix median for even-length lists' }, { id: 'B', title: 'Part B: Add range' }, { id: 'C', title: 'Part C', pauseBefore: true }],
    current: 0, status: 'running', owner: 'me', startedAt: T, updatedAt: T, ...o,
  })
  const cycle = (part: string, phase: ForemanCycle['phase'], o: Partial<ForemanCycle> = {}): ForemanCycle => ({
    id: partCycleId('p', part), runId: 'p', part, plan: 'docs/p.md', base: 'abc', implThread: `t${part}`, maxCycles: 3,
    rounds: phase === 'ready' ? [{ n: 1, file: `r-${part}`, agentId: 'a', verdict: 'OK', findings: 0 }] : [], phase, phaseAt: T, startedAt: T, updatedAt: T, ...o,
  })
  const thread = (part: string, o: Partial<ForemanThread> = {}): ForemanThread => ({
    id: `t${part}`, sessionId: 's', name: `foreman:p:implementer-${part}`, role: 'implementer', cwd: 'C:\\x', model: 'opus', effort: 'high', startedAt: T, updatedAt: T, state: 'working', ...o,
  })

  test('V-1: a pause the person made is "Paused" with nothing in Needs you; only the plan\'s own pause asks before the next part', () => {
    // the person paused while A ran; A is ready; B has no pause of its own
    const mine = plan({ status: 'paused', reason: 'paused by the person; Continue (or /foreman resume) goes on' })
    const ready = [cycle('A', 'ready')]
    expect(atPause(mine, ready)).toBe(false)
    expect(statusWords(mine, ready, [])).toBe('Paused')
    expect(needsYou({ threads: [], cycles: ready } as never, [mine])).toEqual([])
    // the plan's own pause before C, B ready
    const own = plan({ status: 'paused', current: 1 })
    const both = [cycle('A', 'ready'), cycle('B', 'ready')]
    expect(atPause(own, both)).toBe(true)
    expect(needsYou({ threads: [], cycles: both } as never, [own]).map(n => n.kind)).toEqual(['pause'])
    // the pause Continue already answered is no pause
    expect(atPause({ ...own, parts: own.parts.map(p => (p.id === 'C' ? { ...p, go: true } : p)) }, both)).toBe(false)
  })

  test('V-2: the status line says what waits; "Needs you" is the box\'s title only', () => {
    const both = [cycle('A', 'ready'), cycle('B', 'ready')]
    expect(statusWords(plan({ status: 'paused', current: 1 }), both, [])).toBe('Waiting for you before part C')
    const waiting = [cycle('A', 'waiting')]
    expect(statusWords(plan(), waiting, [thread('A', { state: 'waiting', lastResult: { status: 'question', summary: 's', question: 'Which one?' } })])).toBe('Waiting for your answer on part A')
    expect(statusWords(plan(), waiting, [thread('A', { state: 'blocked', waitingFor: 'permission prompt' })])).toBe('Waiting for a permission on part A')
    expect(statusWords(plan(), waiting, [thread('A', { state: 'waiting', openedAt: T })])).toBe('Waiting for you on part A, in its own chat')
    expect(statusWords(plan(), waiting, [thread('A', { state: 'waiting', waitingFor: 'review rounds used up' })])).toBe('Waiting for you on part A')
  })

  test('V-3: the supervisor\'s last decision shows only while its part is the current one and not ready', () => {
    const decided = (part: string, phase: ForemanCycle['phase']) => cycle(part, phase, { decisions: [{ at: '2026-10-17T10:52:00.000Z', stop: 'question', decision: 'escalate', by: 'supervisor', reason: 'delivery' }] })
    expect(decisionToShow(plan(), [decided('A', 'waiting')])?.part).toBe('A')
    // B and C work on, the pause, the stopped plan: A's decision is gone
    expect(decisionToShow(plan({ current: 1 }), [decided('A', 'ready'), cycle('B', 'implementing')])).toBe(undefined)
    expect(decisionToShow(plan({ current: 1, status: 'paused' }), [decided('A', 'ready'), cycle('B', 'ready')])).toBe(undefined)
    expect(decisionToShow(plan({ current: 2, status: 'stopped' }), [decided('A', 'ready'), cycle('B', 'ready'), cycle('C', 'closed')])).toBe(undefined)
    // its part is ready: done with
    expect(decisionToShow(plan(), [decided('A', 'ready')])).toBe(undefined)
  })

  test('V-4: a part ready with another to come reads "Starting part n of m", not "Working" on a part marked ✓', () => {
    expect(statusWords(plan(), [cycle('A', 'ready')], [])).toBe('Starting part 2 of 3')
    expect(statusWords(plan({ current: 1 }), [cycle('A', 'ready'), cycle('B', 'implementing')], [thread('B')])).toBe('Working on part 2 of 3')
  })

  test('V-5: a stopped plan shows no review line, even for a round the Stop cut', () => {
    const cut = cycle('C', 'closed', { rounds: [{ n: 1, file: 'r-C', agentId: 'a', verdict: 'none', findings: 0 }] })
    expect(reviewToShow(plan({ current: 2, status: 'stopped' }), [cycle('A', 'ready'), cycle('B', 'ready'), cut])).toBe(undefined)
    // a running plan still shows a NO
    const no = cycle('A', 'applying', { rounds: [{ n: 1, file: 'r-A', agentId: 'a', verdict: 'NO', findings: 2 }] })
    expect(reviewToShow(plan(), [no])?.words).toBe('2 findings')
  })

  test('live round of Phase 4: the person\'s pause says the part at work finishes first; the worktree\'s install says it runs', () => {
    expect(statusWords(plan({ status: 'paused' }), [cycle('A', 'implementing')], [thread('A')])).toBe('Paused · part A finishes first')
    expect(statusWords(plan({ status: 'paused' }), [cycle('A', 'reviewing')], [thread('A')])).toBe('Paused · part A finishes first')
    expect(statusWords(plan({ status: 'paused' }), [cycle('A', 'ready')], [])).toBe('Paused')
    // paused before a part started: nothing is at work
    expect(statusWords(plan({ status: 'paused' }), [], [])).toBe('Paused')
    expect(statusWords(plan({ prepare: { cmd: 'npm ci', state: 'running', at: T } }), [], [])).toBe('Preparing the worktree (npm ci)')
    expect(statusWords(plan({ prepare: { cmd: 'npm ci', state: 'done', at: T } }), [], [])).toBe('Working on part 1 of 3')
  })

  test('V-9: what was unfolded stays only while the line that unfolded it is drawn', () => {
    const no = cycle('B', 'applying', { rounds: [{ n: 1, file: 'r-B1', agentId: 'a', verdict: 'NO', findings: 2 }] })
    const run = plan({ current: 1 })
    expect(shownStill('r-B1', [run], [cycle('A', 'ready'), no])).toBe(true)
    // the second round starts: the first one's line is gone, and what it unfolded with it
    const r2 = cycle('B', 'reviewing', { rounds: [{ n: 1, file: 'r-B1', agentId: 'a', verdict: 'NO', findings: 2 }, { n: 2, file: 'r-B2', agentId: 'b', verdict: 'none', findings: 0 }] })
    expect(shownStill('r-B1', [run], [cycle('A', 'ready'), r2])).toBe(false)
    // the report, while the plan is done and delivered
    const done = plan({ status: 'done', current: 2, delivery: { mode: 'branch', state: 'delivered' } })
    expect(shownStill('C:\\x\\report.md', [done], [])).toBe(true)
    expect(shownStill('C:\\x\\report.md', [plan()], [])).toBe(false)
  })

  test('V-7: a part\'s title loses the "Part A —" or "Part B:" its heading starts with', () => {
    expect(partTitle({ id: 'A', title: 'Part A — Fix median for even-length lists' })).toBe('Fix median for even-length lists')
    expect(partTitle({ id: 'B', title: 'Part B: Add range' })).toBe('Add range')
    expect(partTitle({ id: 'B', title: '8. Parte B — Frontend' })).toBe('Frontend')
    expect(partTitle({ id: '2', title: 'Phase 2 - Wire it' })).toBe('Wire it')
    // nothing after the id, another id, or no step word: the title as it is
    expect(partTitle({ id: 'C', title: 'Part C' })).toBe('Part C')
    expect(partTitle({ id: 'A', title: 'Part B — Other' })).toBe('Part B — Other')
    expect(partTitle({ id: '1', title: 'Fix login' })).toBe('Fix login')
  })
})
