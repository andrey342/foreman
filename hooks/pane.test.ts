import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { groupOf, isUnder, repoRows, statusLine } from './lib/agents'

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

test('the pane lists the repo sessions grouped by state, on terminal and desktop', async ($, on) => {
  const calls: string[][] = []
  world(on, AGENTS, calls)
  const run = await $.command.run(typed(''))
  expect(run.text).toContain('foreman pane')
  expect(calls[0]).toEqual(['claude', 'agents', '--json', '--all'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'foreman', surface, component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^Working \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Waiting for you \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Done \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /aaaa0002 .*dialog open/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /elsewhere|ancient|prefix trap|chat/ })).toBeUndefined()
    const before = calls.length
    await ui.press({ key: 'refresh' })
    expect(calls.length).toBe(before + 1)
    await ui.unmount()
  }
})

test('the pane says so when claude agents fails', async ($, on) => {
  world(on, 'boom: not logged in', [])
  await $.command.run(typed(''))
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /Could not list background sessions: boom: not logged in/ })).toBeDefined()
  await ui.unmount()
})

test('the pane with no sessions says so', async ($, on) => {
  world(on, [], [])
  await $.command.run(typed(''))
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /No other background sessions in this repo/ })).toBeDefined()
  await ui.unmount()
})

test('/foreman profile with no file runs on the defaults', async ($, on) => {
  world(on, [], [])
  const run = await $.command.run(typed('profile'))
  expect(run.text).toContain('No .claude/foreman.json: running on the defaults.')
  expect(run.text).toContain('"runsDir": ".claude/runs"')
})

test('/foreman init writes a profile that parses clean', async ($, on) => {
  world(on, [], [])
  const written: Record<string, string> = {}
  on('fs.list', () => ({ value: [{ name: 'package.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.write', ($, e) => { written[e.path] = e.text; return { value: undefined } })
  const run = await $.command.run(typed('init'))
  expect(run.text).toContain('Wrote C:\\MSG/.claude/foreman.json')
  const paths = Object.keys(written)
  expect(paths.map(p => p.replace(/\\/g, '/'))).toEqual(['C:/MSG/.claude/foreman.json'])
  const text = written[paths[0] ?? ''] ?? ''
  expect(JSON.parse(text).gates).toEqual({ node: ['npm test'] })
})
