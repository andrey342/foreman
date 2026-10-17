// End to end through the plugin's own hooks, with the CLI, the file system,
// the store and the clock beneath it. The engine hands fs.* hooks paths with
// `\` on Windows, so the fake file system keys them that way.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanThread } from '../types'

/** The time a long scenario test may take (the kit's default is 5 s). */
const SLOW_MS = 30_000

const NOW_MS = Date.parse('2026-10-09T21:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const TPATH = 'C:\\home\\.claude\\projects\\C--demo\\aaaa0001-s.jsonl'
const K = (p: string) => p.split('/').join('\\')
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const row = (o: Record<string, unknown>) => JSON.stringify(o)
const fence = (summary: string, status = 'done') => '```foreman-result\n' + JSON.stringify({ status, summary }) + '\n```'

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  runs: { argv: string[]; env?: Record<string, string> }[]
  toasts: string[]
  agent: Record<string, unknown> | undefined
  denyResume: boolean
  denyAll: boolean
  /** The CLI lists the session once `claude --bg` started it. */
  launched: boolean
  clock: ReturnType<typeof mock.clock>
  skills: string[]
  sessionRoot: string
  /** fs.read calls, by path. */
  reads: Record<string, number>
  /** store.get calls, by key. */
  gets: Record<string, number>
}

function world(on: On, seed: Partial<Pick<World, 'store' | 'files' | 'sessionRoot' | 'skills'>> = {}): World {
  const w: World = {
    files: { ...(seed.files ?? {}) },
    store: { ...(seed.store ?? {}) },
    runs: [],
    toasts: [],
    agent: { pid: 7, status: 'busy', state: 'working' },
    denyResume: false,
    denyAll: false,
    launched: false,
    clock: mock.clock(on, { now: NOW_MS }),
    skills: seed.skills ?? [],
    sessionRoot: seed.sessionRoot ?? 'C:\\demo',
    reads: {},
    gets: {},
  }
  const isDir = (p: string) => Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => { w.gets[e.key] = (w.gets[e.key] ?? 0) + 1; return { value: w.store[e.key] } })
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: w.sessionRoot }))
  on('session.cwd', () => ({ value: w.sessionRoot }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('command.list', () => ({ value: w.skills.map(name => ({ name, description: '', source: 'user' })) }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\home' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.exists', ($, e) => ({ value: K(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = K(e.path)
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    if (isDir(p) || p === 'C:\\demo' || p === w.sessionRoot) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => {
    const p = K(e.path)
    w.reads[p] = (w.reads[p] ?? 0) + 1
    if (p in w.files) return { value: w.files[p] as string }
    if (p.includes('\\prompts\\')) return { value: p.endsWith('_result.md') ? 'END' : p.endsWith('_rules.md') ? 'RULES: no push' : 'TASK: {{task}} SKILLS: {{skills}}' }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    w.runs.push({ argv: [...e.argv], ...(e.init?.env ? { env: { ...e.init.env } } : {}) })
    if (w.denyAll) return { deny: 'claude not found' }
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const a = e.argv
    if (a[0] === 'git' && a.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    if (a[1] === 'agents') return ok(JSON.stringify(w.agent && w.launched ? [{ id: 'aaaa0001', sessionId: 'aaaa0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'foreman:adhoc:implementer', ...w.agent }] : []))
    if (a[1] === '--bg' && a[2] === '--resume') return w.denyResume ? { deny: 'spawn failed' } : ok('note: woke session aaaa0001 with its saved options\nbackgrounded · aaaa0001 · foreman:adhoc:implementer')
    if (a[1] === '--bg') { w.launched = true; return ok('backgrounded · aaaa0001 · foreman:adhoc:implementer') }
    if (a[1] === 'stop') return ok('stopped aaaa0001')
    if (a[0] === 'powershell.exe') return ok('{"cut line\n' + (w.files[TPATH] ?? ''))
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const turn = (prompt: string, at: number, summary: string, id: string, status = 'done') => [
  row({ type: 'user', timestamp: iso(at), message: { role: 'user', content: prompt } }),
  row({ type: 'assistant', timestamp: iso(at + 3000), message: { id, content: [{ type: 'text', text: `answer\n\n${fence(summary, status)}` }], usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  row({ type: 'system', subtype: 'turn_duration', timestamp: iso(at + 4000) }),
]
const stored = (w: World) => (w.store['v2:threads:c:/demo'] ?? []) as ForemanThread[]
/** A run's files live under the repo's .git (D-70). */
const RUNS = 'C:\\demo\\.git\\foreman'
const agentsRuns = (w: World) => w.runs.filter(r => r.argv[1] === 'agents').length

/**
 * A thread as a plan's part starts it, in the registry with its CLI row live
 * (the 0.1 `/foreman launch` is gone, D-75: these tests watch a thread, not
 * how it started).
 */
function begin(w: World, o: { runId?: string; cwd?: string } = {}): ForemanThread {
  const t: ForemanThread = {
    id: 'aaaa0001', sessionId: 'aaaa0001-s', name: 'foreman:adhoc:implementer', role: 'implementer', ...(o.runId ? { runId: o.runId } : {}),
    cwd: o.cwd ?? 'C:\\demo', model: 'opus', effort: 'high', startedAt: iso(NOW_MS), updatedAt: iso(NOW_MS), sentAt: iso(NOW_MS), state: 'working', owner: 'sess-me',
  }
  w.store['v2:threads:c:/demo'] = [...stored(w), t]
  w.launched = true
  return t
}
const reply = async ($: { tool: { call: (i: never) => Promise<unknown> } }, text: string) => String(((await $.tool.call({ tool: 'mcp__foreman__reply', thread: '1', text } as never)) as { result?: unknown }).result)

// a long scenario (dozens of watcher looks on the mock clock): its own time, so a loaded machine does not fail it (Phase 5 review, c)
test('a thread\'s turn ends with a done block: Done in status, the store and the run file, one toast', { timeoutMs: SLOW_MS }, async ($, on) => {
  const w = world(on)
  begin(w, { runId: 'r1' })
  w.files[TPATH] = turn('TASK: fix it', NOW_MS + 100, 'fixed', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  expect((await $.command.run(typed('status'))).text).toContain('| Ready for review |')
  expect(stored(w)[0]).toMatchObject({ id: 'aaaa0001', state: 'ready', lastResult: { summary: 'fixed' }, transcript: TPATH })
  expect(stored(w)[0]?.usage?.output).toBe(10)
  const doc = JSON.parse(w.files[`${RUNS}\\r1\\foreman.json`] ?? '{}')
  expect(doc.transitions.map((t: { from: string; to: string }) => `${t.from}>${t.to}`)).toEqual(['working>ready'])
  expect(w.toasts.filter(t => t.includes('→ ready')).length).toBe(1)
  // a second look changes nothing and counts nothing again
  await $.command.run(typed('status'))
  expect(stored(w)[0]?.usage?.output).toBe(10)
})

test('C-01: right after a reply the done row and the old turn do not end the new turn; the new answer is read', async ($, on) => {
  const w = world(on)
  begin(w)
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'OLD answer', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  expect((await $.command.run(typed('status'))).text).toContain('| Ready for review |')
  await w.clock.advance(60_000)
  expect(await reply($ as never, 'how many?')).toContain('Sent to')
  w.agent = { pid: 8, status: 'idle', state: 'done' }
  // the CLI returned; the new prompt is not in the transcript yet and the row still says done
  expect((await $.command.run(typed('status'))).text).toContain('| Working |')
  expect(stored(w)[0]?.lastResult?.summary).toBe('OLD answer')
  w.files[TPATH] = [...turn('TASK: list', NOW_MS + 100, 'OLD answer', 'm1'), ...turn('how many?', NOW_MS + 62_300, 'NEW answer: 5', 'm2')].join('\n')
  expect((await $.command.run(typed('status'))).text).toContain('| Ready for review |')
  expect(stored(w)[0]?.lastResult?.summary).toBe('NEW answer: 5')
  expect(stored(w)[0]?.usage?.output).toBe(20)
})

test('the watcher: a 30 s tick moves the thread and toasts, with no command typed', async ($, on) => {
  const w = world(on)
  begin(w)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(stored(w)[0]?.state).toBe('working')
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'thirteen', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  const toastsBefore = w.toasts.length
  await w.clock.advance(30_000)
  expect(stored(w)[0]).toMatchObject({ state: 'ready', lastResult: { summary: 'thirteen' } })
  expect(w.toasts.slice(toastsBefore).some(t => t.includes('foreman:adhoc:implementer → ready'))).toBe(true)
})

test('C-09: status right after a session start waits for the sync in flight and shows the finished turn', async ($, on) => {
  const w = world(on)
  begin(w)
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  w.files[TPATH] = turn('TASK: list', NOW_MS + 1, 'quick', 'm1').join('\n')
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(typed('status'))).text).toContain('| Ready for review |')
})

test('C-03: a session the CLI reports failed: Failed, with why', async ($, on) => {
  const w = world(on)
  begin(w)
  w.agent = { state: 'failed' }
  expect((await $.command.run(typed('status'))).text).toContain('| Failed (the session failed')
})

test('C-02: a chat sees the threads another chat put in the store', async ($, on) => {
  const other: ForemanThread = { id: 'bbbb0002', sessionId: 'bbbb0002-s', name: 'foreman:adhoc:implementer-B', role: 'implementer', cwd: 'C:\\demo', model: 'sonnet', effort: 'medium', startedAt: '2026-10-09T20:59:00.000Z', updatedAt: '2026-10-09T20:59:00.000Z', state: 'ready' }
  const w = world(on, { store: { 'v2:threads:c:/demo': [other] } })
  begin(w)
  const out = (await $.command.run(typed('status'))).text ?? ''
  expect(stored(w).map(t => t.id).sort()).toEqual(['aaaa0001', 'bbbb0002'])
  expect(out).toContain('bbbb0002')
})

test('C-02: a transition the run file already ends with is not written twice', async ($, on) => {
  const w = world(on)
  begin(w, { runId: 'r1' })
  const path = `${RUNS}\\r1\\foreman.json`
  // another chat already recorded working -> ready for this thread
  w.files[path] = JSON.stringify({ v: 2, runId: 'r1', updatedAt: iso(NOW_MS + 5000), threads: [], transitions: [{ at: iso(NOW_MS + 5000), thread: 'aaaa0001', from: 'working', to: 'ready' }], reviews: [], cycles: [] })
  w.files[TPATH] = turn('TASK: fix', NOW_MS + 100, 'fixed', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  expect(stored(w)[0]?.state).toBe('ready')
  const after = JSON.parse(w.files[path] ?? '{}')
  expect(after.transitions.filter((t: { to: string }) => t.to === 'ready').length).toBe(1)
  expect(after.threads[0].state).toBe('ready')
})

test('C-14: a run file that does not parse is kept aside, not overwritten', async ($, on) => {
  const w = world(on, { files: { [`${RUNS}\\r1\\foreman.json`]: '{ "runId": "r1", oops' } })
  begin(w, { runId: 'r1' })
  w.files[TPATH] = turn('TASK: x', NOW_MS + 100, 'done', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  const aside = Object.keys(w.files).find(p => p.includes('foreman.json.broken-'))
  expect(aside).toBeDefined()
  expect(w.files[aside ?? '']).toBe('{ "runId": "r1", oops')
  expect(JSON.parse(w.files[`${RUNS}\\r1\\foreman.json`] ?? '{}').transitions.length).toBe(1)
})

test('C-12: a reply whose resume cannot run says so, and the thread is shown stopped', async ($, on) => {
  const w = world(on)
  begin(w)
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'one', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  w.denyResume = true
  expect(await reply($ as never, 'more')).toContain('Not sent: claude --bg --resume did not run')
  expect(stored(w)[0]).toMatchObject({ state: 'stopped', waitingFor: 'a message failed to resume it' })
})

test('C-12: a command whose CLI call is refused answers with the reason instead of failing', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': '# Plan\n\n## Part A\nDo it.\n' } })
  w.denyAll = true
  const out = (await $.command.run(typed('go docs/plan.md'))).text ?? ''
  expect(out).toContain('Not started: /foreman go docs/plan.md needs')
  expect(out).toContain('(foreman: $.process.run: claude not found)')
})

test('C-08: a transcript over 3.5 MB is read through the tail script, its path passed in the environment', async ($, on) => {
  const w = world(on)
  begin(w)
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'big one', 'm1').join('\n') + '\n' + ' '.repeat(3_600_000)
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  const tail = w.runs.find(r => r.argv[0] === 'powershell.exe')
  expect(tail?.env).toEqual({ FOREMAN_TAIL_PATH: TPATH })
  expect(tail?.argv.join(' ').includes('aaaa0001')).toBe(false)
  expect(stored(w)[0]?.lastResult?.summary).toBe('big one')
})

test('the 0.1 commands answer with what replaces them, and run nothing (D-75)', async ($, on) => {
  const w = world(on)
  const said = async (args: string) => (await $.command.run(typed(args))).text ?? ''
  expect(await said('launch implementer "x"')).toContain('/foreman launch is gone in 0.2: a task is a plan.')
  expect(await said('tell 1 "x"')).toContain('/foreman tell is gone in 0.2')
  expect(await said('open 1')).toContain('/foreman open is gone in 0.2')
  expect(await said('log 1')).toContain('/foreman log is gone in 0.2')
  expect(await said('close 1')).toContain('/foreman close is gone in 0.2')
  expect(await said('init')).toBe('/foreman init is gone in 0.2: /foreman setup writes the profile, after at most three questions.')
  expect(await said('profile')).toBe('/foreman profile is gone in 0.2: /foreman setup --show shows what foreman finds here and the profile in effect.')
  expect(await said('stop aaaa0001')).toBe('No active plan "aaaa0001" here. A thread stops with its plan: /foreman stop <plan>.')
  expect(w.runs.some(r => r.argv[1] === '--bg')).toBe(false)
})

test('D-79: with nothing open, claude agents runs at most once per 5 minutes; the store is still read every 30 s', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const listedAtStart = agentsRuns(w)
  const getsAtStart = w.gets['v2:threads:c:/demo'] ?? 0
  for (let i = 0; i < 19; i++) await w.clock.advance(30_000) // 9.5 minutes
  // the look at start, then one each time 5 minutes have passed since the last listing
  expect(listedAtStart).toBe(1)
  expect(agentsRuns(w)).toBe(2)
  expect((w.gets['v2:threads:c:/demo'] ?? 0) - getsAtStart).toBeGreaterThanOrEqual(19)
  // a command still lists at once
  await $.command.run(typed('status'))
  expect(agentsRuns(w)).toBe(3)
})

test('D-79: with a thread open, every look lists; a transcript that did not change is not read again', async ($, on) => {
  const w = world(on)
  begin(w)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'one', 'm1').slice(0, 1).join('\n')
  await w.clock.advance(30_000)
  const listed = agentsRuns(w)
  const reads = w.reads[TPATH] ?? 0
  expect(reads).toBe(1)
  await w.clock.advance(30_000)
  await w.clock.advance(30_000)
  expect(agentsRuns(w)).toBe(listed + 2)
  // same size, same mtime: not read again
  expect(w.reads[TPATH]).toBe(1)
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'one', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await w.clock.advance(30_000)
  expect(w.reads[TPATH]).toBe(2)
  expect(stored(w)[0]).toMatchObject({ state: 'ready', lastResult: { summary: 'one' } })
  expect(stored(w)[0]?.usage?.output).toBe(10)
})
