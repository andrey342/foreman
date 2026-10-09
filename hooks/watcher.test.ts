// End to end through the plugin's own hooks, with the CLI, the file system,
// the store and the clock beneath it. The engine hands fs.* hooks paths with
// `\` on Windows, so the fake file system keys them that way.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanThread } from '../types'

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
  }
  const isDir = (p: string) => Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
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
    if (a[1] === 'agents') return ok(JSON.stringify(w.agent && w.launched ? [{ id: 'aaaa0001', sessionId: 'aaaa0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'foreman:adhoc:free', ...w.agent }] : []))
    if (a[1] === '--bg' && a[2] === '--resume') return w.denyResume ? { deny: 'spawn failed' } : ok('note: woke session aaaa0001 with its saved options\nbackgrounded · aaaa0001 · foreman:adhoc:free')
    if (a[1] === '--bg') { w.launched = true; return ok('backgrounded · aaaa0001 · foreman:adhoc:free') }
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
const stored = (w: World) => (w.store['threads:c:/demo'] ?? []) as ForemanThread[]

test('launch, the turn ends with a done block: Done in status, the store and the run file, one toast', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(typed('launch implementer "fix it" --run r1 --part A'))).text).toContain('Launched')
  w.files[TPATH] = turn('TASK: fix it', NOW_MS + 100, 'fixed', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  expect((await $.command.run(typed('status'))).text).toContain('| Ready for review |')
  expect(stored(w)[0]).toMatchObject({ id: 'aaaa0001', state: 'ready', lastResult: { summary: 'fixed' }, transcript: TPATH })
  expect(stored(w)[0]?.usage?.output).toBe(10)
  const doc = JSON.parse(w.files['C:\\demo\\.claude\\runs\\r1\\foreman.json'] ?? '{}')
  expect(doc.transitions.map((t: { from: string; to: string }) => `${t.from}>${t.to}`)).toEqual(['none>working', 'working>ready'])
  expect(w.toasts.filter(t => t.includes('→ ready')).length).toBe(1)
  // a second look changes nothing and counts nothing again
  await $.command.run(typed('status'))
  expect(stored(w)[0]?.usage?.output).toBe(10)
})

test('C-01: right after tell the done row and the old turn do not end the new turn; the new answer is read', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('launch free "list"'))
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'OLD answer', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  expect((await $.command.run(typed('status'))).text).toContain('| Done |')
  await w.clock.advance(60_000)
  expect((await $.command.run(typed('tell 1 "how many?"'))).text).toContain('Sent to')
  w.agent = { pid: 8, status: 'idle', state: 'done' }
  // the CLI returned; the new prompt is not in the transcript yet and the row still says done
  expect((await $.command.run(typed('status'))).text).toContain('| Working |')
  expect(stored(w)[0]?.lastResult?.summary).toBe('OLD answer')
  w.files[TPATH] = [...turn('TASK: list', NOW_MS + 100, 'OLD answer', 'm1'), ...turn('how many?', NOW_MS + 62_300, 'NEW answer: 5', 'm2')].join('\n')
  expect((await $.command.run(typed('status'))).text).toContain('| Done |')
  expect(stored(w)[0]?.lastResult?.summary).toBe('NEW answer: 5')
  expect(stored(w)[0]?.usage?.output).toBe(20)
})

test('the watcher: a 30 s tick moves the thread and toasts, with no command typed', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('launch free "list"'))
  await w.clock.settle()
  expect(stored(w)[0]?.state).toBe('working')
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'thirteen', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  const toastsBefore = w.toasts.length
  await w.clock.advance(30_000)
  expect(stored(w)[0]).toMatchObject({ state: 'done', lastResult: { summary: 'thirteen' } })
  expect(w.toasts.slice(toastsBefore).some(t => t.includes('foreman:adhoc:free → done'))).toBe(true)
})

test('C-09: status right after launch waits for the sync in flight and shows the finished turn', async ($, on) => {
  const w = world(on)
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  // the transcript the launch will produce, already finished
  w.files[TPATH] = turn('TASK: list', NOW_MS + 1, 'quick', 'm1').join('\n')
  await $.command.run(typed('launch free "list"'))
  expect((await $.command.run(typed('status'))).text).toContain('| Done |')
})

test('C-03: a session the CLI reports failed: Failed, and the next launch is accepted', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('launch free "list"'))
  w.agent = { state: 'failed' }
  expect((await $.command.run(typed('status'))).text).toContain('| Failed (the session failed')
  expect((await $.command.run(typed('launch free "again"'))).text).toContain('Launched')
})

test('C-04: --run .. and --part ../x are refused before anything is written', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': '{ "notify": { "toast": false } }' } })
  expect((await $.command.run(typed('launch free "x" --run ..'))).text).toContain('--run takes')
  expect((await $.command.run(typed('launch free "x" --part ../x'))).text).toContain('--part takes')
  expect(w.runs.length).toBe(0)
  expect(Object.keys(w.files)).toEqual(['C:\\demo\\.claude\\foreman.json'])
})

test('C-02: a launch keeps the threads another chat put in the store, and sees them', async ($, on) => {
  const other: ForemanThread = { id: 'bbbb0002', sessionId: 'bbbb0002-s', name: 'foreman:adhoc:qa', role: 'qa', cwd: 'C:\\demo', model: 'sonnet', effort: 'medium', startedAt: '2026-10-09T20:59:00.000Z', updatedAt: '2026-10-09T20:59:00.000Z', state: 'ready' }
  const w = world(on, { store: { 'threads:c:/demo': [other] } })
  await $.command.run(typed('launch free "mine"'))
  expect(stored(w).map(t => t.id).sort()).toEqual(['aaaa0001', 'bbbb0002'])
  expect((await $.command.run(typed('status'))).text).toContain('bbbb0002')
})

test('C-02: a thread another chat launched and the CLI shows working holds the slot here too', async ($, on) => {
  const other: ForemanThread = { id: 'aaaa0001', sessionId: 'aaaa0001-s', name: 'foreman:adhoc:free', role: 'free', cwd: 'C:\\demo', model: 'sonnet', effort: 'high', startedAt: iso(NOW_MS - 1000), updatedAt: iso(NOW_MS - 1000), state: 'working' }
  const w = world(on, { store: { 'threads:c:/demo': [other] } })
  w.launched = true
  expect((await $.command.run(typed('launch implementer "second"'))).text).toContain('maxParallelThreads is 1 and foreman:adhoc:free is still busy')
  expect(w.runs.some(r => r.argv[1] === '--bg')).toBe(false)
})

test('C-02: a transition the run file already ends with is not written twice', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('launch implementer "fix" --run r1'))
  const path = 'C:\\demo\\.claude\\runs\\r1\\foreman.json'
  // another chat already recorded working -> ready for this thread
  const doc = JSON.parse(w.files[path] ?? '{}')
  doc.transitions.push({ at: iso(NOW_MS + 5000), thread: 'aaaa0001', from: 'working', to: 'ready' })
  w.files[path] = JSON.stringify(doc)
  w.files[TPATH] = turn('TASK: fix', NOW_MS + 100, 'fixed', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  expect(stored(w)[0]?.state).toBe('ready')
  const after = JSON.parse(w.files[path] ?? '{}')
  expect(after.transitions.filter((t: { to: string }) => t.to === 'ready').length).toBe(1)
  expect(after.threads[0].state).toBe('ready')
})

test('C-14: a run file that does not parse is kept aside, not overwritten', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\runs\\r1\\foreman.json': '{ "runId": "r1", oops' } })
  await $.command.run(typed('launch free "x" --run r1'))
  const aside = Object.keys(w.files).find(p => p.includes('foreman.json.broken-'))
  expect(aside).toBeDefined()
  expect(w.files[aside ?? '']).toBe('{ "runId": "r1", oops')
  expect(JSON.parse(w.files['C:\\demo\\.claude\\runs\\r1\\foreman.json'] ?? '{}').transitions.length).toBe(1)
})

test('C-12: a resume that cannot run: the command says so and the thread is shown stopped', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('launch free "list"'))
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'one', 'm1').join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  w.denyResume = true
  const told = (await $.command.run(typed('tell 1 "more"'))).text ?? ''
  expect(told).toContain('Not sent: claude --bg --resume did not run')
  expect(stored(w)[0]).toMatchObject({ state: 'stopped', waitingFor: 'a message failed to resume it' })
})

test('C-12: a command whose CLI call is refused answers with the reason instead of failing', async ($, on) => {
  const w = world(on)
  w.denyAll = true
  const out = (await $.command.run(typed('launch free "x"'))).text ?? ''
  expect(out).toContain('/foreman launch free "x" failed')
})

test('C-08: a transcript over 3.5 MB is read through the tail script, its path passed in the environment', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('launch free "list"'))
  w.files[TPATH] = turn('TASK: list', NOW_MS + 100, 'big one', 'm1').join('\n') + '\n' + ' '.repeat(3_600_000)
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await $.command.run(typed('status'))
  const tail = w.runs.find(r => r.argv[0] === 'powershell.exe')
  expect(tail?.env).toEqual({ FOREMAN_TAIL_PATH: TPATH })
  expect(tail?.argv.join(' ').includes('aaaa0001')).toBe(false)
  expect(stored(w)[0]?.lastResult?.summary).toBe('big one')
})

test('C-11: a profile skill the session does not list is left out of the brief and reported', async ($, on) => {
  const w = world(on, { skills: ['msg-implement-plan'], files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ roles: { implementer: { skills: ['msg-implement-plan', 'msg-nope'] } } }) } })
  const out = (await $.command.run(typed('launch implementer "x"'))).text ?? ''
  expect(out).toContain('Skills not found in this session, left out of the brief: msg-nope.')
  const brief = w.runs.find(r => r.argv[1] === '--bg')?.argv.at(-1) ?? ''
  expect(brief).toContain('SKILLS: msg-implement-plan')
  expect(brief.includes('msg-nope')).toBe(false)
  expect(brief).toContain('RULES: no push')
})

test('C-16: in a worktree the thread runs in the worktree; the registry stays the repo\'s', async ($, on) => {
  const wt = 'C:\\demo\\.claude\\worktrees\\wt1'
  const w = world(on, { sessionRoot: wt, files: { [`${wt}\\.git`]: 'gitdir: C:/demo/.git/worktrees/wt1' } })
  await $.command.run(typed('launch free "x"'))
  expect(stored(w)[0]?.cwd).toBe(wt)
})
