// Phase 2 through the plugin's own hooks: the background driver as the
// watcher sees it (a thread opened in the app, a process that died mid-turn),
// the pane v2 and its buttons, the notices (M1), the model's tools (M2), the
// preflight (M3) and the permissions a thread inherits (M7). The CLI, the
// transcripts, the dialog, the clock and the store are beneath the plugin.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../types'
import { TOOLS } from './lib/tools'
import { ALWAYS_ESCALATE } from './lib/supervisor'
import { decisionWords, lastActionText } from './ui/pane'

const NOW_MS = Date.parse('2026-10-16T20:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const K = (p: string) => p.split('/').join('\\')
/** The first thread's session id: a UUID, as the CLI gives one (Open refuses anything else). */
const SID = 'aaaa0001-0000-4000-8000-000000000001'
const TPATH = `C:\\home\\.claude\\projects\\C--demo\\${SID}.jsonl`
const RUN = 'C:\\demo\\.git\\foreman\\plan'
const PLAN = '# Plan\n\n## Part A\nFix sumTo.\n\n**Acceptance**\n- sumTo(5) is 15\n\n## Part B\nDocument it.\n'
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const row = (o: Record<string, unknown>) => JSON.stringify(o)
const fence = (summary: string, status = 'done', extra: Record<string, unknown> = {}) => '```foreman-result\n' + JSON.stringify({ status, summary, ...extra }) + '\n```'
const PANE_PROPS = { title: 'foreman', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const

/** The supervisor's prompt as the tests read it: every placeholder of prompts/supervisor.md (scripts/check-prompts.mjs checks the file itself). */
const SUPERVISOR_TEMPLATE = 'PLAN {{plan}} PART {{part}} {{partTitle}}\n{{partText}}\n{{criteria}}\n{{stop}}\n{{implementer}}\nREVIEW {{review}}\nDELIVERY {{delivery}}\n{{decidesAlone}}\n{{escalateAlways}}\n{{history}}\nLEFT {{runsLeft}}\n{{allowed}}'

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  /** The background row of the first thread (aaaa0001), once launched. */
  agent: Record<string, unknown> | undefined
  /** The app's (interactive) row of that thread, once Open put it there. */
  app: Record<string, unknown> | undefined
  launched: boolean
  launches: string[][]
  resumes: string[][]
  stops: string[][]
  opens: { argv: string[]; env?: Record<string, string> }[]
  /** The reviewer processes started, with the brief each read on stdin. */
  spawns: { argv: string[]; prompt: string; finish: (out: ReviewerOut) => void; finished: boolean }[]
  me: string
  toasts: string[]
  logs: string[]
  /** What went to the debug log only. */
  debug: string[]
  /** `$.mcp.call`s, as `server tool args`; `mcpFails` makes the next ones answer an error. */
  mcpCalls: { server: string; tool: string; args: Record<string, unknown> }[]
  mcpFails: number
  /** The thread's registry record at the moment `claude stop` ran (Open's order). */
  atStop: (ForemanThread | undefined)[]
  pushes: string[]
  statuses: (string | undefined)[]
  tools: { name: string; isDeferred?: boolean }[]
  panes: { id: string; title: string }[]
  all: string[][]
  answer: string
  /** What the supervisor's `claude -p` prints as its result (D-68), and its runs with the brief it read. */
  supervisor: string
  supervised: { argv: string[]; stdin: string }[]
  /** Background sessions of the repo that are no foreman thread (other work), as `claude agents` lists them. */
  foreign: Record<string, unknown>[]
  /** Runs while `claude --bg` launches (a watcher's look in the middle of a launch). */
  duringLaunch?: () => Promise<void>
  asked: string[]
  noGit: boolean
  dirty: boolean
  config?: string
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

function world(on: On, seed: { files?: Record<string, string>; env?: Record<string, string> } = {}): World {
  const w: World = {
    files: { 'C:\\demo\\docs\\plan.md': PLAN, ...(seed.files ?? {}) },
    store: {},
    clock: mock.clock(on, { now: NOW_MS }),
    agent: { pid: 7, status: 'busy', state: 'working' },
    app: undefined,
    launched: false,
    launches: [],
    resumes: [],
    stops: [],
    opens: [],
    spawns: [],
    me: 'sess-me',
    toasts: [],
    logs: [],
    debug: [],
    mcpCalls: [],
    mcpFails: 0,
    atStop: [],
    pushes: [],
    statuses: [],
    tools: [],
    panes: [],
    all: [],
    answer: 'Run them',
    supervisor: 'The plan leaves it open.\n{"decision":"escalate","reason":"the plan does not say","question":"Throw or return NaN?"}',
    supervised: [],
    foreign: [],
    asked: [],
    noGit: false,
    dirty: false,
    limits: [],
  }
  const env: Record<string, string> = { USERPROFILE: 'C:\\home', OS: 'Windows_NT', ...(seed.env ?? {}) }
  const isDir = (p: string) => ['c:\\demo', 'c:\\demo\\'].includes(K(p).toLowerCase()) || Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: 'C:\\demo' }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.id', () => ({ value: w.me }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 0 }, rateLimits: w.limits } as never }))
  on('settings.read', () => ({ value: { permissions: { allow: ['Bash(npm test)', 'WebFetch(domain:example.com)'] } } as never }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('command.list', () => ({ value: [] }))
  on('tool.register', ($, e) => { w.tools.push({ name: e.name, isDeferred: (e as { isDeferred?: boolean }).isDeferred }); return { value: { tool: `mcp__foreman__${e.name}` } } })
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.exists', ($, e) => ({ value: K(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = K(e.path).replace(/\\+$/, '')
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: (w.files[p] ?? '').length, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    if (isDir(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', ($, e) => {
    const dir = K(e.path).replace(/\\+$/, '')
    const names = Object.keys(w.files).filter(f => f.startsWith(dir + '\\')).map(f => f.slice(dir.length + 1).split('\\')[0] as string)
    return { value: [...new Set(names)].map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const p = K(e.path)
    if (p === 'C:\\home\\.claude.json' && w.config !== undefined) return { value: w.config }
    if (p in w.files) return { value: w.files[p] as string }
    if (p.endsWith('\\prompts\\supervisor.md')) return { value: SUPERVISOR_TEMPLATE }
    if (p.includes('\\prompts\\')) {
      if (p.includes('\\agents\\')) return { value: 'SYSTEM' }
      if (p.endsWith('reviewer.md')) return { value: 'REVIEW {{reviewFile}} BASE {{base}}' }
      return { value: p.endsWith('_result.md') ? 'END' : p.endsWith('_rules.md') ? 'RULES' : 'TASK: {{task}}\n{{partText}}\n{{criteria}}' }
    }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', async ($, e) => {
    const a = [...e.argv]
    w.all.push(a)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = (stderr: string, exitCode = 128) => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && w.noGit) return fail('fatal: not a git repository (or any of the parent directories): .git')
    if (a[0] === 'git' && a.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === 'HEAD') return ok('abc1234def5678\n')
    if (a[0] === 'git' && a[1] === 'status') return ok(w.dirty ? ' M src/sum.js\n' : '')
    if (a[1] === 'agents') {
      const rows: unknown[] = [{ pid: 1, cwd: 'C:\\demo', kind: 'interactive', startedAt: 0, sessionId: 'coord-s', name: 'coordinator', status: 'busy' }]
      if (w.agent && w.launched) rows.push({ id: 'aaaa0001', sessionId: SID, cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'foreman:plan:implementer-A', ...w.agent })
      if (w.app) rows.push({ cwd: 'C:\\demo', kind: 'interactive', startedAt: NOW_MS, sessionId: SID, name: 'foreman:plan:implementer-A', ...w.app })
      rows.push(...w.foreign)
      w.launches.slice(1).forEach((_, i) => rows.push({ id: `bbbb000${i + 1}`, sessionId: `bbbb000${i + 1}-s`, cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, pid: 9, status: 'busy', state: 'working' }))
      return ok(JSON.stringify(rows))
    }
    if (a[1] === '--bg' && a[2] === '--resume') { w.resumes.push(a); return ok(`note: woke session ${String(a[3]).slice(0, 8)} with its saved options\nbackgrounded · ${String(a[3]).slice(0, 8)} · foreman:plan:implementer-A`) }
    if (a[1] === '--bg') {
      w.launches.push(a)
      w.launched = true
      const during = w.duringLaunch
      w.duringLaunch = undefined
      if (during) await during()
      const id = w.launches.length === 1 ? 'aaaa0001' : `bbbb000${w.launches.length - 1}`
      return ok(`backgrounded · ${id} · ${a[3]}`)
    }
    if (a[1] === 'stop') { w.stops.push(a); w.atStop.push(((w.store['v2:threads:c:/demo'] ?? []) as ForemanThread[]).find(t => t.id === a[2])); return ok(`stopped ${a[2]}`) }
    if (a[1] === '-p') {
      w.supervised.push({ argv: a, stdin: e.init?.stdin ?? '' })
      return ok(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: w.supervisor, num_turns: 2, duration_ms: 4000, total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } }))
    }
    if (a[0] === 'powershell.exe') { w.opens.push({ argv: a, ...(e.init?.env ? { env: { ...e.init.env } } : {}) }); return ok('') }
    return fail(`unexpected ${a.join(' ')}`, 1)
  })
  // the reviewer's `claude -p` (D-73): it runs until the test answers for it (reviewSays)
  on('process.spawn', async function* ($, e) {
    let finish: (out: ReviewerOut) => void = () => undefined
    const answered = new Promise<ReviewerOut>(resolve => { finish = resolve })
    w.spawns.push({ argv: [...e.argv], prompt: e.input ?? '', finish, finished: false })
    const out = await answered
    const stdout = 'result' in out ? processJson(out.result) : out.stdout
    if (stdout) yield { stream: 'stdout' as const, text: stdout }
    return { value: { code: 'result' in out ? 0 : out.code, signal: null } }
  })
  on('tool.call', ($, e) => {
    if (String(e.tool) === 'PushNotification') {
      w.pushes.push((e as unknown as { message: string }).message)
      return { result: { pushSent: false, localSent: false, disabledReason: 'config_off' } } as never
    }
    if (String(e.tool) !== 'AskUserQuestion') return { result: 'ran' }
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    w.asked.push(q)
    if (w.answer === 'deny') return { deny: 'no one to ask here' }
    return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: w.answer } } } as never
  })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { (e.to === 'debug' ? w.debug : w.logs).push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { w.statuses.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } as never }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'base', scope: 'shared' }] }))
  on('mcp.call', ($, e) => {
    w.mcpCalls.push({ server: e.server, tool: e.tool, args: { ...e.args } })
    if (w.mcpFails > 0) { w.mcpFails--; return { value: { content: [{ type: 'text', text: 'Session not found' }], isError: true } } }
    return { value: { content: [{ type: 'text', text: 'Message delivered to session (delivery: delivered; message_id: m1)' }], isError: false } }
  })
  on('ui.panes', () => ({ value: w.panes.map(p => ({ ...p, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => { w.panes.push({ id: e.id, title: e.title ?? e.id }); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { w.panes.splice(w.panes.findIndex(p => p.id === e.id), 1); return { value: undefined } })
  return w
}

const cyclesOf = (w: World) => (w.store['v2:cycles:c:/demo'] ?? []) as ForemanCycle[]
const threadsOf = (w: World) => (w.store['v2:threads:c:/demo'] ?? []) as ForemanThread[]
const plansOf = (w: World) => ((w.store['plans:c:/demo'] as { plans?: ForemanPlanRun[] } | undefined)?.plans ?? [])
const runDoc = (w: World) => JSON.parse(w.files[`${RUN}\\foreman.json`] ?? '{}')

/** What a reviewer process prints: its result (the review's text), or raw output and an exit code. */
type ReviewerOut = { result: string } | { stdout: string; code: number }
const processJson = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 6, duration_ms: 60_000, total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, permission_denials: [] })

/** The reviewer process that runs answers (D-73): foreman writes its result to the review file and settles it. */
async function reviewSays(w: { spawns: { finish: (out: ReviewerOut) => void; finished: boolean }[]; clock: { settle: () => Promise<void> } }, out: string | ReviewerOut) {
  // the process starts when foreman first reads its output: let that happen
  await w.clock.settle()
  const r = w.spawns.find(s => !s.finished)
  if (!r) throw new Error('no reviewer is running')
  r.finished = true
  r.finish(typeof out === 'string' ? { result: out } : out)
  await w.clock.settle()
}

/** The implementer ends a background turn: its prompt row and its answer, then turn_duration. */
function implementerTurn(w: World, summary: string, id: string, status = 'done', extra: Record<string, unknown> = {}) {
  const t = w.clock.now()
  w.files[TPATH] = [
    ...(w.files[TPATH] ? [w.files[TPATH]] : []),
    row({ type: 'user', timestamp: iso(t + 100), message: { role: 'user', content: 'Read and follow the brief' } }),
    row({ type: 'assistant', timestamp: iso(t + 2000), message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: `done\n\n${fence(summary, status, extra)}` }], usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    row({ type: 'system', subtype: 'turn_duration', timestamp: iso(t + 3000) }),
  ].join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
}

async function tick(w: World, $: { command: { run: (i: ReturnType<typeof typed>) => Promise<{ text?: string }> } }) {
  await w.clock.advance(30_000)
  return (await $.command.run(typed('status'))).text ?? ''
}

// ---------------------------------------------------------------- M7, M1 and the Reply (criterion 2)

test('M7: the thread inherits the repo\'s permissions.allow plus foreman\'s short list, by --settings', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  const settings = JSON.parse(w.launches[0]?.[w.launches[0].indexOf('--settings') + 1] ?? '{}')
  expect(settings.worktree).toEqual({ bgIsolation: 'none' })
  expect(settings.env).toEqual({ FOREMAN_THREAD: 'foreman:plan:implementer-A' })
  expect(settings.permissions.allow.slice(0, 3)).toEqual(['Bash(npm test)', 'WebFetch(domain:example.com)', 'Read'])
  expect(settings.permissions.allow).toContain('Bash(git commit:*)')
  // the permission mode stays the profile's (auto by default): inherited rules do not change it
  expect(w.launches[0]?.slice(8, 10)).toEqual(['--permission-mode', 'auto'])
})

test('criterion 2: a question leaves the plan waiting (pane, status line, toast, PushNotification and its answer recorded) and the pane\'s Reply resumes the thread', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'two ways to do it', 'm1', 'question', { question: 'Throw or return NaN for negative n?' })
  await tick(w, $)
  // Phase 3: the question goes to the supervisor first; here it escalates (the plan does not say)
  await tick(w, $)
  expect(w.supervised.length).toBe(1)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: 'the supervisor escalates: the plan does not say: Throw or return NaN?' })
  expect(w.toasts.some(t => t.includes('plan:A: waiting for you, the supervisor escalates: the plan does not say'))).toBe(true)
  expect(w.statuses.at(-1)).toContain('1 waiting')
  expect(w.pushes).toEqual(['foreman: plan:A: waiting for you, the supervisor escalates: the plan does not say: Throw or return NaN?'])
  // what PushNotification answered goes to the debug log and foreman.json only, not the chat (review P3)
  expect(w.debug).toContain('PushNotification: not sent (config_off)')
  expect(w.logs.some(l => l.startsWith('PushNotification'))).toBe(false)
  expect(runDoc(w).notices.at(-1)).toMatchObject({ level: 'stop', push: 'not sent (config_off)' })
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  // the pane v3 (D-113): the question in full in "Needs you", why it came to the person behind Why, the details folded
  expect((await ui.findAll({ type: 'Text', text: /^Needs you$/ })).length).toBe(2)
  expect(await ui.find({ type: 'Text', text: 'Part A asks: Throw or return NaN for negative n?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^foreman decided: passed part A to you \(\d\d:\d\d\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /thread aaaa0001/ })).toBeUndefined()
  await ui.press({ key: 'why:plan' })
  expect(await ui.find({ type: 'Text', text: 'the plan does not say: Throw or return NaN?' })).toBeDefined()
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: /part A · waiting · thread aaaa0001 · Waiting for you · opus\/high/ })).toBeDefined()
  await ui.input({ key: 'reply:aaaa0001:0', text: 'Throw a RangeError.' })
  await w.clock.settle()
  // Send: the field is drawn anew and empty (its key counts the Sends), and the pane says it went
  expect(await ui.find({ type: 'Text', text: 'Sent ✓ — the thread goes on' })).toBeDefined()
  expect(await ui.find({ key: 'reply:aaaa0001:0' })).toBeUndefined()
  await w.clock.advance(9_000)
  expect(await ui.find({ type: 'Text', text: 'Sent ✓ — the thread goes on' })).toBeUndefined()
  expect(w.resumes.length).toBe(1)
  expect(w.resumes[0]?.slice(0, 4)).toEqual(['claude', '--bg', '--resume', SID])
  expect(w.resumes[0]?.at(-1)).toContain('Throw a RangeError.')
  // the Reply carries the short re-brief (the review's answer to Phase 2's doubt 3)
  expect(w.resumes[0]?.at(-1)).toContain(`(you work on part A of the plan \`docs/plan.md\`; your brief is \`${RUN}\\brief-A.md\`; foreman's notes are in \`${RUN}\\progress.md\`.)`)
  // a live idle background process is stopped before the resume (D-03)
  expect(w.stops).toEqual([['claude', 'stop', 'aaaa0001']])
  await ui.unmount()
  w.agent = { pid: 7, status: 'busy', state: 'working' }
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
})

test('M1: an info notice (a part starts) is a toast but no push; notify.quiet keeps it to the pane', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ notify: { quiet: true } }) } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  expect(cyclesOf(w).map(c => c.phase)).toEqual(['ready', 'implementing'])
  expect(w.pushes).toEqual([])
  expect(w.toasts.some(t => t.includes('part B started'))).toBe(false)
  expect(runDoc(w).notices.map((n: { level: string; text: string }) => `${n.level} ${n.text}`)).toEqual(['info plan:A: ready, review r1 OK after 1 round(s)', 'info plan: part B started (foreman:plan:implementer-B)'])
  // the ready part's thread is done, not "ready for review" (review O-4)
  expect(threadsOf(w)[0]?.state).toBe('done')
  // the chat hears that the part is ready, not that the next one started, nor the review's line (round 2's noise)
  expect(w.logs).toContain('plan:A: ready, review r1 OK after 1 round(s)')
  expect(w.logs.some(l => l.includes('part B started') || l.startsWith('Review A r1'))).toBe(false)
  expect(w.debug.some(l => l.includes('part B started'))).toBe(true)
})

// ---------------------------------------------------------------- Open (criterion 3) and the thread in the app

test('criterion 3: a blocked thread opens in the app (claude stop, then Start-Process with the id by environment); foreman reads the app\'s row and turn; a Reply reaches the same session', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  w.agent = { pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
  await tick(w, $)
  expect(threadsOf(w)[0]).toMatchObject({ state: 'blocked', waitingFor: 'permission prompt' })
  expect(w.pushes.length).toBe(1)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  await ui.press({ key: 'open:aaaa0001' })
  await w.clock.settle()
  expect(w.stops).toEqual([['claude', 'stop', 'aaaa0001']])
  // the mark was in the registry before the stop: a look in between cannot resume it (the race seen live)
  expect(w.atStop[0]?.openedAt).toBeDefined()
  expect(w.opens.length).toBe(1)
  const open = w.opens[0]
  expect(open?.argv.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])
  expect(open?.argv[4]).toBe("Start-Process -FilePath $env:FOREMAN_OPEN_EXE -ArgumentList '--desktop','--resume',$env:FOREMAN_OPEN_ID -WindowStyle Hidden")
  expect(open?.env).toEqual({ FOREMAN_OPEN_EXE: 'claude', FOREMAN_OPEN_ID: SID })
  expect(w.toasts.some(t => t.startsWith(`Opened foreman:plan:implementer-A in the app's sidebar (local_${SID})`))).toBe(true)
  // the stop cut the dialog's call: a moment later foreman tells the session, now in the app, to run it again (round 2)
  expect(w.mcpCalls).toEqual([])
  await w.clock.advance(3_000)
  await w.clock.settle()
  expect(w.mcpCalls.map(c => `${c.server} ${c.tool} ${String(c.args.session_id)}`)).toEqual([`ccd_session_mgmt send_message local_${SID}`])
  expect(String(w.mcpCalls[0]?.args.message)).toContain('your last tool call was cut when this thread was opened in the app')
  expect(runDoc(w).transitions.some((x: { note?: string }) => x.note === 'told in the app to run its cut call again')).toBe(true)
  await ui.unmount()
  // the background process is gone; the app holds the session and the person answers the dialog there
  w.agent = { status: undefined, state: 'stopped' }
  w.app = { pid: 70, status: 'busy' }
  await tick(w, $)
  expect(threadsOf(w)[0]).toMatchObject({ state: 'working', openedAt: expect.any(String) })
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
  // the app's turn ends: end_turn, no turn_duration (F0-5)
  const t = w.clock.now()
  w.files[TPATH] = [
    row({ type: 'user', timestamp: iso(NOW_MS + 100), message: { role: 'user', content: 'Read and follow the brief' } }),
    row({ type: 'assistant', timestamp: iso(t + 1000), message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: `ok\n\n${fence('fixed after the dialog')}` }], usage: { input_tokens: 1, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    row({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(t + 1100) }),
  ].join('\n')
  w.app = { pid: 70, status: 'idle' }
  await tick(w, $)
  expect(threadsOf(w)[0]).toMatchObject({ lastResult: { summary: 'fixed after the dialog' } })
  expect(cyclesOf(w)[0]?.phase).toBe('reviewing')
  // a pushed notice for the blocked thread, and none for the open one (the person is there)
  expect(w.pushes.length).toBe(1)
  // a Reply after Open: no stop (the app's session is no background process), the same session id
  const before = w.stops.length
  const out = await $.tool.call({ tool: 'mcp__foreman__reply', thread: 'aaaa0001', text: 'also the README' } as never)
  expect(String((out as { result?: unknown }).result)).toContain('Sent to foreman:plan:implementer-A (aaaa0001)')
  expect(w.stops.length).toBe(before)
  expect(w.resumes.at(-1)?.slice(0, 4)).toEqual(['claude', '--bg', '--resume', SID])
  expect(threadsOf(w)[0]?.openedAt).toBe(undefined)
})

test('Open refuses to cut a working thread\'s turn; the limit on parallel threads counts a thread busy in the app', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ limits: { maxParallelThreads: 1 } }) } })
  await $.command.run(typed('go docs/plan.md'))
  expect((await $.command.run(typed('open aaaa0001'))).text).toBe('Not opened: the thread is working, and Open would cut its turn: wait until it stops or asks.')
  // the background row is gone and the app runs it: still busy, found by session id
  w.agent = undefined
  w.app = { pid: 70, status: 'busy' }
  const out = (await $.command.run(typed('launch implementer "another"'))).text ?? ''
  expect(out).toContain('maxParallelThreads is 1 and foreman:plan:implementer-A is still busy')
})

// ---------------------------------------------------------------- the model's tools (criterion 4)

test('criterion 4: four tools in the prompt\'s list; status answers; go asks the person even with parts named, and with no dialog starts nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  expect(w.tools).toEqual(['status', 'go', 'reply', 'open'].map(name => ({ name, isDeferred: false })))
  const status = await $.tool.call({ tool: 'mcp__foreman__status' } as never)
  expect(String((status as { result?: unknown }).result)).toContain('No threads.')
  // a report, said so to the model: it opened a thread on its own after one in the acceptance (review 7)
  expect(String((status as { result?: unknown }).result)).toContain('Nothing waits for the person.\n(A report: tell the user what it says. Open a thread or reply only when the user asks for it.)')
  w.answer = 'Cancel'
  const cancelled = await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review', parts: 'A' } as never)
  // a mode the model still passes is said and ignored (D-111)
  expect(w.asked.at(-1)).toContain('Run 1 part(s) of docs/plan.md in order?')
  expect(w.asked.at(-1)).toContain('Note: --mode: one mode in 0.2')
  expect(String((cancelled as { result?: unknown }).result)).toContain('Not started (Cancel)')
  w.answer = 'deny'
  const noDialog = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review' } as never) as { result?: unknown }).result)
  expect(noDialog).toContain('Not started: there is no dialog here to confirm it with the person.')
  expect(noDialog).toContain('To start it, the person types: /foreman go docs/plan.md --yes')
  expect(w.launches.length).toBe(0)
  const flagged = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: '--yes' } as never) as { result?: unknown }).result)
  expect(flagged).toBe('plan cannot start with "-".')
  w.answer = 'Run them'
  const started = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review' } as never) as { result?: unknown }).result)
  expect(started).toContain('Plan plan started: 2 part(s), in order:')
  expect(plansOf(w)[0]).toMatchObject({ status: 'running' })
  expect('mode' in (plansOf(w)[0] ?? {})).toBe(false)
})

test('the reply tool sends the person\'s words to the thread that waits, and sends a dialog to Open instead', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  expect(String((await $.tool.call({ tool: 'mcp__foreman__reply', text: 'go on' } as never) as { result?: unknown }).result)).toBe('No thread waits for an answer.')
  w.agent = { pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
  await tick(w, $)
  expect(String((await $.tool.call({ tool: 'mcp__foreman__reply', text: 'yes' } as never) as { result?: unknown }).result)).toContain('waits on a dialog (permission prompt), not on an answer: open it in the app (foreman_open)')
  expect(w.resumes.length).toBe(0)
  const opened = String((await $.tool.call({ tool: 'mcp__foreman__open' } as never) as { result?: unknown }).result)
  expect(opened).toContain('Opened foreman:plan:implementer-A in the app\'s sidebar')
})

// ---------------------------------------------------------------- preflight (criterion 5)

test('criterion 5: outside git, go answers one message that says what is missing, and writes nothing', async ($, on) => {
  const w = world(on)
  w.noGit = true
  const out = (await $.command.run(typed('go docs/plan.md --yes'))).text ?? ''
  expect(out).toBe('Not started: /foreman go docs/plan.md needs\n- a git repository: this folder is not in one (each part is reviewed from a commit; `git init` and commit once)\nAlso:\n- no gates declared or found: each review judges the diff and the plan\'s criteria alone')
  expect(w.launches.length).toBe(0)
  expect(Object.keys(w.files).filter(f => f.includes('.git\\foreman'))).toEqual([])
})

test('criterion 5: a folder Claude Code does not trust is named, with the way to trust it; a trusted parent folder is enough', async ($, on) => {
  const w = world(on)
  w.config = JSON.stringify({ projects: { 'C:/other': { hasTrustDialogAccepted: true }, 'C:/demo': { hasTrustDialogAccepted: false } } })
  w.dirty = true
  w.limits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-16T22:00:00Z' }]
  const out = (await $.command.run(typed('go docs/plan.md --yes'))).text ?? ''
  expect(out).toContain('- Claude Code to trust this folder: open it once in the app (or run `claude` in it) and accept the trust prompt; a background thread cannot ask')
  expect(out).toContain('- this checkout has uncommitted changes')
  expect(out).toContain('- usage: five_hour at 95%, resets 2026-10-16T22:00:00Z')
  expect(w.launches.length).toBe(0)
  w.config = JSON.stringify({ projects: { 'C:/': { hasTrustDialogAccepted: true } } })
  const ok = (await $.command.run(typed('go docs/plan.md --yes'))).text ?? ''
  expect(ok).toContain('Plan plan started')
  expect(ok).toContain('Note: this checkout has uncommitted changes')
})

// ---------------------------------------------------------------- recovery (criterion 6)

test('criterion 6: a thread whose process ended mid-turn is resumed on a re-brief, twice at most; a thread the person stopped is not', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  // the app closed: the row lost its pid and still says working
  w.agent = { state: 'working' }
  await w.clock.advance(3 * 60_000)
  await tick(w, $)
  expect(w.resumes.length).toBe(1)
  const msg = w.resumes[0]?.at(-1) ?? ''
  expect(msg).toContain('foreman resumes you: your session\'s process ended before your turn did')
  expect(msg).toContain(`your brief is \`${RUN}\\brief-A.md\``)
  expect(msg).toContain(`foreman's notes on the plan are in \`${RUN}\\progress.md\``)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', revived: 1 })
  expect(runDoc(w).transitions.some((x: { note?: string }) => x.note === 'implementer resumed on a re-brief (1 of 2)')).toBe(true)
  // it dies twice more: once more resumed, then the person decides
  w.agent = { state: 'working', startedAt: 0 }
  await w.clock.advance(3 * 60_000)
  await tick(w, $)
  expect(w.resumes.length).toBe(2)
  await w.clock.advance(3 * 60_000)
  await tick(w, $)
  expect(w.resumes.length).toBe(2)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'thread' })
  expect(w.pushes.at(-1)).toContain('the implementer is stopped: its process ended mid-turn')
})

test('Stop: the plan ends, its part is closed, its thread is stopped for the person and never resumed by foreman', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  // Stop asks first (D-113)
  w.answer = 'Stop it'
  await ui.press({ key: 'stop:plan' })
  await w.clock.settle()
  await ui.unmount()
  expect(plansOf(w)[0]).toMatchObject({ status: 'stopped', reason: 'stopped by the person' })
  expect(cyclesOf(w)[0]?.phase).toBe('closed')
  expect(threadsOf(w)[0]).toMatchObject({ state: 'stopped', heldBy: 'person' })
  expect(w.stops).toEqual([['claude', 'stop', 'aaaa0001']])
  w.agent = { state: 'stopped' }
  await tick(w, $)
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  // a new go is possible again
  expect((await $.command.run(typed('go docs/plan.md --yes'))).text).toContain('Plan plan-2 started')
})

// ---------------------------------------------------------------- thread mode in the app (criterion 7)

test('criterion 7: a thread opened in the app stays in thread mode: its status line at attach, no pane, no tools, no watcher', async ($, on) => {
  const w = world(on, { env: { FOREMAN_THREAD: 'foreman:plan:implementer-A' } })
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-1' })
  expect(w.statuses.at(-1)).toBe('thread foreman:plan:implementer-A: no guards in the profile')
  expect(w.panes).toEqual([])
  expect(w.tools).toEqual([])
  await w.clock.advance(10 * 60_000)
  expect(w.all.some(a => a[1] === 'agents')).toBe(false)
})

test('criterion 7, as the app runs it: no FOREMAN_THREAD there (the app does not apply the saved settings), but the session id is a thread\'s, so it is a thread (round 2)', async ($, on) => {
  const w = world(on)
  // the registry, as the coordinator left it: this session is the thread of part B, opened in the app
  const thread: ForemanThread = { id: 'aaaa0001', sessionId: 'sess-me', name: 'foreman:plan:implementer-B', role: 'implementer', runId: 'plan', part: 'B', cwd: 'C:\\demo', model: 'sonnet', effort: 'low', startedAt: iso(NOW_MS), updatedAt: iso(NOW_MS), state: 'stopped', openedAt: iso(NOW_MS) }
  w.store['v2:threads:c:/demo'] = [thread]
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-1' })
  expect(w.statuses.at(-1)).toBe('thread foreman:plan:implementer-B: no guards in the profile')
  expect(w.tools).toEqual([])
  expect(w.panes).toEqual([])
  expect((await $.command.run(typed('status'))).text).toBe('This session is the foreman thread foreman:plan:implementer-B: /foreman runs in the chat that coordinates it.')
  await w.clock.advance(10 * 60_000)
  expect(w.all.some(a => a[1] === 'agents')).toBe(false)
})

// ---------------------------------------------------------------- the pane v2 (criterion 8)

test('criterion 8: the pane opens by itself at the first desktop attach while a plan runs, once; nothing opens with no work', async ($, on) => {
  const idle = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-1' })
  expect(idle.panes).toEqual([])
  // a plan started here opens it (round 2: the person had to type /foreman); closed, a later attach leaves it closed
  await $.command.run(typed('go docs/plan.md'))
  expect(idle.panes).toEqual([{ id: 'foreman', title: 'foreman' }])
  await $.command.run(typed(''))
  expect(idle.panes).toEqual([])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-2' })
  expect(idle.panes).toEqual([])
})

test('criterion 8: with a plan running, the first desktop attach opens the pane', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  // another chat of the repo, or this one reopened: no pane yet, the plan runs
  w.panes.length = 0
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  expect(w.panes).toEqual([])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-1' })
  expect(w.panes).toEqual([{ id: 'foreman', title: 'foreman' }])
})

test('criterion 8: a pause the plan writes, in the pane: parts, Continue after A is ready, Pause and Continue, on desktop', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': PLAN.replace('## Part B', 'Pause: check part A by hand.\n\n## Part B') } })
  await $.command.run(typed('go docs/plan.md --yes'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n\nAll criteria met.\n')
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'paused', reason: 'the plan asks you to check before part B; Continue (or /foreman resume plan) goes on' })
  expect(w.launches.length).toBe(1)
  expect(w.pushes.at(-1)).toBe('foreman: plan: part A ready; the plan asks you to check before part B; Continue (or /foreman resume plan) goes on')
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^Plan$/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^Needs you$/ })).length).toBe(2)
  expect(await ui.find({ type: 'Text', text: ' ✓ A  Part A' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ○ B  Part B' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The plan asks you to check before part B.' })).toBeDefined()
  // an OK review is no line of its own: the part's ✓ says it (D-113)
  expect(await ui.find({ type: 'Text', text: /^Review round/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'Next part' })).toBeUndefined()
  expect(await ui.find({ type: 'Select' })).toBeUndefined()
  // Continue: the plan's pause is answered, part B starts
  await ui.press({ key: 'continue:plan' })
  await w.clock.settle()
  await tick(w, $)
  expect(w.launches.length).toBe(2)
  expect(plansOf(w)[0]).toMatchObject({ status: 'running', current: 1 })
  expect(runDoc(w).transitions.some((x: { note?: string }) => x.note === 'resumed: part B may start')).toBe(true)
  // Pause and Continue are one button with one key: the press after the redraw lands on the same element
  await ui.press({ key: 'toggle:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('paused')
  expect(await ui.find({ type: 'Button', text: 'Continue' })).toBeDefined()
  await ui.press({ key: 'toggle:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('running')
  // every press of the plan's buttons reached foreman and is in its record; the pane says what the last one did
  expect(runDoc(w).presses.map((p: { element: string; surface: string }) => `${p.element} ${p.surface}`)).toEqual(['continue:plan desktop', 'toggle:plan desktop', 'toggle:plan desktop'])
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: /^Last button: \d\d:\d\d Pause\/Continue: Resumed plan/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^plan plan · docs\/plan\.md · files C:\\demo\\\.git\\foreman\\plan$/ })).toBeDefined()
  // Stop asks first; "Keep going" keeps it running
  w.answer = 'Keep going'
  await ui.press({ key: 'stop:plan' })
  await w.clock.settle()
  expect(w.asked.at(-1)).toBe('Stop Plan? Its thread stops; its commits and files stay.')
  expect(plansOf(w)[0]?.status).toBe('running')
  w.answer = 'Stop it'
  await ui.press({ key: 'stop:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('stopped')
  expect(await ui.find({ type: 'Text', text: 'Stopped' })).toBeDefined()
  await ui.unmount()
})

test('one mode (D-111): /foreman next and --mode review say they are gone; the plan chains its parts', async ($, on) => {
  const w = world(on)
  const out = (await $.command.run(typed('go docs/plan.md --mode review --yes'))).text
  expect(out).toContain('Note: --mode: one mode in 0.2')
  expect('mode' in (plansOf(w)[0] ?? {})).toBe(false)
  expect((await $.command.run(typed('next'))).text).toBe('Next part is gone: a plan\'s parts chain by themselves. Before a part the plan pauses at, Continue in the pane (or /foreman resume) goes on.')
  expect(w.launches.length).toBe(1)
})

test('Open, then a look while the background process is gone and the app has not taken it yet: foreman does not resume it (review P1)', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  w.agent = { pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
  await tick(w, $)
  expect((await $.command.run(typed('open aaaa0001'))).text).toContain('Opened foreman:plan:implementer-A')
  // the CLI's row says stopped, no app row yet: a thread stopped mid-turn, but open in the app
  w.agent = { state: 'stopped' }
  await w.clock.advance(3 * 60_000)
  await tick(w, $)
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  expect(threadsOf(w)[0]?.openedAt).toBeDefined()
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', reason: 'the implementer is open in the app: answer it there' })
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Part A is open in its own chat: answer it there. foreman goes on when its turn ends.' })).toBeDefined()
  await ui.unmount()
})

test('the open tool says it is only for when the person asks; the status tool that it changes nothing (review 7)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  expect(w.tools.length).toBe(4)
  expect(TOOLS.find(t => t.name === 'open')?.description).toContain('call it only when the user asks to open the thread')
  expect(TOOLS.find(t => t.name === 'status')?.description).toContain('A report only: it changes nothing')
})

test('a look of the watcher while go is launching the first part does not start it again (round 2 of the acceptance)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  // the 30 s watcher fires while `claude --bg` runs for part A: the run is saved, its cycle not yet
  w.duringLaunch = async () => { await w.clock.advance(30_000) }
  const out = (await $.command.run(typed('go docs/plan.md --yes'))).text ?? ''
  expect(out).toContain('Plan plan started')
  await w.clock.settle()
  await tick(w, $)
  expect(w.launches.length).toBe(1)
  expect(plansOf(w)[0]).toMatchObject({ status: 'running', current: 0 })
  expect(runDoc(w).transitions.filter((t: { thread: string }) => t.thread === 'plan').map((t: { to: string }) => t.to)).toEqual(['running@A'])
})

test('Open of a blocked thread: when the app never takes the message, the person is told to write in the thread', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  w.agent = { pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
  await tick(w, $)
  w.mcpFails = 3
  await $.command.run(typed('open aaaa0001'))
  for (const ms of [3_000, 10_000, 30_000]) {
    await w.clock.advance(ms)
    await w.clock.settle()
  }
  expect(w.mcpCalls.length).toBe(3)
  expect(w.toasts.some(t => t.startsWith('foreman:plan:implementer-A is open in the app and its last tool call was cut: write "go on" in its chat'))).toBe(true)
})

test('Open of a thread that waits for an answer cuts no call: no message to the app', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'which?', 'm1', 'question', { question: 'A or B?' })
  await tick(w, $)
  expect((await $.command.run(typed('open aaaa0001'))).text).toContain('Opened')
  await w.clock.advance(45_000)
  await w.clock.settle()
  expect(w.mcpCalls).toEqual([])
})

// ---------------------------------------------------------------- the supervisor (Phase 3)

const decisionsOf = (w: World) => (w.files[`${RUN}\\decisions.jsonl`] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

/** The implementer asks; the supervisor's answer is `result`; two looks let its background run land. */
async function askAndSupervise(w: World, $: Parameters<typeof tick>[1], result: string, question = 'Throw or return NaN for negative n?') {
  w.supervisor = result
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'two ways to do it', 'm1', 'question', { question })
  await tick(w, $)
  await tick(w, $)
}

test('Phase 3 criterion 2 (kit): the supervisor answers what the plan settles; the thread goes on; decisions.jsonl holds the run, its usage and cost', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, 'The acceptance criterion says sumTo(-1) is refused.\n{"decision":"answer","text":"The plan\'s criterion refuses a negative n: throw a RangeError, and add a test for it."}')
  expect(w.supervised.length).toBe(1)
  // a read-only process in the work tree: dontAsk, the read-only tools, its thread-mode name; the brief on stdin
  const run = w.supervised[0]
  expect(run?.argv.slice(1, 6)).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'])
  expect(run?.argv).toContain('{"env":{"FOREMAN_THREAD":"foreman:plan:supervisor-A"}}')
  expect(run?.argv.slice((run?.argv.indexOf('--allowedTools') ?? 0) + 1)).toEqual(['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)'])
  // the implementer's words fenced as data; the real prompt, filled from the authority table (one source, criterion 1b)
  expect(run?.stdin).toContain('<implementer-text>\nThrow or return NaN for negative n?\n</implementer-text>')
  for (const row of ALWAYS_ESCALATE) expect(run?.stdin).toContain(`- ${row.label}`)
  expect(run?.stdin).toContain('Fix sumTo.')
  // the answer reached the thread, and the part is at work again
  expect(w.resumes.length).toBe(1)
  expect(w.resumes[0]?.at(-1)).toContain('foreman\'s supervisor answers, within the plan:\n\nThe plan\'s criterion refuses a negative n: throw a RangeError, and add a test for it.')
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', supervisorRuns: 1 })
  expect(decisionsOf(w)).toEqual([expect.objectContaining({ part: 'A', stop: 'question', by: 'supervisor', decision: 'answer', costUsd: 0.02, usage: { input: 5, output: 40, cacheRead: 800, cacheWrite: 0 } })])
  expect(runDoc(w).transitions.some((t: { note?: string }) => t.note === 'supervisor (supervisor): answer, 0.020 USD')).toBe(true)
  // the person hears of it in the chat: an answer given on their behalf
  expect(w.logs.some(l => l.startsWith('plan:A: the supervisor answered the implementer:'))).toBe(true)
  expect(w.pushes).toEqual([])
})

test('Phase 3 criterion 3 (kit): «¿hago push?» — an answer that touches delivery becomes escalate, by the code; the person is told', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, 'Sure.\n{"decision":"answer","text":"Yes, push the branch when the tests pass."}', 'Should I push the branch when I am done?')
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
  expect(cyclesOf(w)[0]?.reason).toContain('foreman: the supervisor\'s answer touches what always goes to the person (delivery)')
  expect(w.resumes.length).toBe(0)
  expect(decisionsOf(w)).toEqual([expect.objectContaining({ stop: 'question', by: 'code', decision: 'escalate', question: 'Should I push the branch when I am done?' })])
  expect(w.pushes.length).toBe(1)
  expect(w.pushes[0]).toContain('waiting for you, the supervisor escalates')
})

test('an answer with no decision JSON is an escalation by the code, never a decision', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, 'I would throw a RangeError.')
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
  expect(cyclesOf(w)[0]?.reason).toContain('foreman: no decision JSON in its answer')
  expect(decisionsOf(w)[0]).toMatchObject({ by: 'code', decision: 'escalate' })
  expect(w.resumes.length).toBe(0)
})

test('a supervisor that cannot answer (an empty result) escalates; the part waits for the person with why', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, '')
  expect(cyclesOf(w)[0]?.reason).toContain('the supervisor gave no answer: its answer was empty')
})

test('the last review round NO: the supervisor replans once; the new brief, a resume on it, the rounds again; the next last NO goes to the person (D-67)', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ limits: { reviewRounds: 1 } }) } })
  w.supervisor = 'Two findings come from one mistake.\n{"decision":"replan","text":"Write the failing test first, then change only sumTo; leave the README for part B."}'
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'try', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: NO\n\n### C-01 · P1 · src/sum.js:1 · wrong\n')
  await tick(w, $)
  await tick(w, $)
  expect(w.supervised.length).toBe(1)
  expect(w.supervised[0]?.stdin).toContain('`{"decision":"replan","text":"…"}`')
  const replan = w.files[`${RUN}\\brief-A-replan.md`] ?? ''
  expect(replan).toContain('## The part, replanned by foreman\'s supervisor')
  expect(replan).toContain('Write the failing test first, then change only sumTo')
  expect(w.resumes.at(-1)?.at(-1)).toContain(`read the new brief \`${RUN}\\brief-A-replan.md\``)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', replanned: true, roundBase: 1 })
  // the replanned brief gets its round; its NO is the last one again, and the replan is spent: the person, no supervisor run
  w.agent = { pid: 7, status: 'busy', state: 'working' }
  await tick(w, $)
  await w.clock.advance(60_000)
  implementerTurn(w, 'second try', 'm2')
  await tick(w, $)
  await reviewSays(w, 'Verdict: NO\n\n### C-01 · P1 · src/sum.js:1 · still wrong\n')
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
  expect(cyclesOf(w)[0]?.reason).toContain('the review rounds are used up and the part was replanned already')
  expect(w.supervised.length).toBe(1)
  expect(cyclesOf(w)[0]?.rounds.length).toBe(2)
})

test('a blocked reviewer: the supervisor asks for another review, and a new round starts', async ($, on) => {
  const w = world(on)
  w.supervisor = 'The diff was empty because the commit landed late.\n{"decision":"re-review","reason":"the commit is there now"}'
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: BLOCKED\nNo diff to review.\n')
  await tick(w, $)
  await tick(w, $)
  await tick(w, $)
  expect(w.supervised[0]?.stdin).toContain('The reviewer was blocked (review round 1).')
  expect(w.spawns.length).toBe(2)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'reviewing' })
  expect(cyclesOf(w)[0]?.rounds.map(r => r.n)).toEqual([1, 2])
})

// ---------------------------------------------------------------- the pane v3 (D-113): five states, terminal and desktop

const SURFACES = ['terminal', 'desktop'] as const
/** The pane on a surface, and its lines of text in order. */
async function drawPane($: { ui: { mount: (i: never) => Promise<unknown> } }, surface: 'terminal' | 'desktop' | 'mobile') {
  const ui = (await $.ui.mount({ plugin: 'foreman', surface, component: 'Pane', requestId: 'foreman', props: PANE_PROPS } as never)) as {
    find: (q: Record<string, unknown>) => Promise<{ text: string } | undefined>
    findAll: (q: Record<string, unknown>) => Promise<{ text: string }[]>
    press: (t: { key: string }) => Promise<unknown>
    unmount: () => Promise<void>
  }
  const lines = (await ui.findAll({ type: 'Text' })).map(e => e.text)
  return { ui, lines }
}

test('pane v3, working: the title, one status line, a line per part, nothing that needs you, the details folded; at most 12 lines', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  for (const surface of SURFACES) {
    const { ui, lines } = await drawPane($, surface)
    expect(lines).toEqual(['Plan', 'Working on part 1 of 2', ' ● A  Part A', ' ○ B  Part B'])
    expect(await ui.find({ type: 'Button', text: 'Pause' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Stop' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '▸ Details' })).toBeDefined()
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    await ui.unmount()
  }
  // reviewing: the round in the status line
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  const { ui, lines } = await drawPane($, 'desktop')
  expect(lines[1]).toBe('Working on part 1 of 2 · Reviewing (round 1 of 3)')
  await ui.unmount()
})

test('pane v3, needs you, a question: the question in full, a field and Send, the supervisor\'s decision with Why; at most 12 lines', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, 'Not in the plan.\n{"decision":"escalate","reason":"the plan leaves it open","question":"Throw or return NaN?"}')
  for (const surface of SURFACES) {
    const { ui, lines } = await drawPane($, surface)
    expect(lines).toEqual(['Plan', 'Needs you', ' ● A  Part A', ' ○ B  Part B', 'Needs you', 'Part A asks: Throw or return NaN for negative n?', expect.stringMatching(/^foreman decided: passed part A to you \(\d\d:\d\d\)$/)])
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(await ui.find({ type: 'Input', key: 'reply:aaaa0001:0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Why' })).toBeDefined()
    await ui.unmount()
  }
})

test('pane v3, needs you, a dialog: the part waits for a permission in its own chat, and Open its chat; at most 12 lines', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  w.agent = { pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
  await tick(w, $)
  for (const surface of SURFACES) {
    const { ui, lines } = await drawPane($, surface)
    expect(lines).toEqual(['Plan', 'Needs you', ' ● A  Part A', ' ○ B  Part B', 'Needs you', 'Part A is waiting for a permission in its own chat.'])
    expect(await ui.find({ type: 'Button', key: 'open:aaaa0001', text: 'Open its chat' })).toBeDefined()
    await ui.unmount()
  }
})

test('pane v3, the plan\'s own pause: the plan asks you to check before the next part, and Continue; at most 12 lines', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': PLAN.replace('## Part B', 'Pause: check part A by hand.\n\n## Part B') } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  for (const surface of SURFACES) {
    const { ui, lines } = await drawPane($, surface)
    expect(lines).toEqual(['Plan', 'Needs you', ' ✓ A  Part A', ' ○ B  Part B', 'Needs you', 'The plan asks you to check before part B.'])
    expect(await ui.find({ type: 'Button', key: 'continue:plan', text: 'Continue' })).toBeDefined()
    await ui.unmount()
  }
})

test('pane v3, done: Done ✓ and the number of parts, Show report unfolds foreman\'s record of the run', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': '# Fix login\n\nThe button does nothing.\n' } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'fixed', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  expect(plansOf(w)[0]?.status).toBe('done')
  for (const surface of SURFACES) {
    const { ui, lines } = await drawPane($, surface)
    expect(lines).toEqual(['Fix login', 'Done ✓ · 1 part', ' ✓ 1  Fix login'])
    expect(await ui.find({ type: 'Button', text: 'Pause' })).toBeUndefined()
    await ui.press({ key: 'report:plan' })
    await w.clock.settle()
    expect(await ui.find({ type: 'Markdown', text: /# Fix login/ })).toBeDefined()
    await ui.press({ key: 'report:plan' })
    await w.clock.settle()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

test('pane v3: a review that said NO is one line with Show; the answer the supervisor gave, one line with Why; the repo\'s other sessions stay out of the pane', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ limits: { reviewRounds: 1 } }) } })
  w.foreign = [
    { id: 'eeee0001', sessionId: 'eeee0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'spike', state: 'done' },
    { id: 'eeee0002', sessionId: 'eeee0002-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'old', state: 'stopped' },
  ]
  w.supervisor = 'Two findings come from one mistake.\n{"decision":"replan","text":"Write the failing test first, then change only sumTo."}'
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'try', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: NO\n\n### C-01 · P1 · src/sum.js:1 · wrong\n### C-02 · P2 · src/sum.js:2 · also wrong\n')
  await tick(w, $)
  await tick(w, $)
  const { ui, lines } = await drawPane($, 'desktop')
  expect(lines).toContain('Review round 1: 2 findings')
  expect(lines).toContain('Working on part 1 of 2')
  expect(lines.some(l => /^foreman decided: replanned part A \(\d\d:\d\d\)$/.test(l))).toBe(true)
  expect(lines.some(l => /spike|eeee000|Other background/.test(l))).toBe(false)
  await ui.press({ key: 'review:aaaa0001' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Markdown', text: /C-02 · P2/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'review:aaaa0001', text: 'Hide' })).toBeDefined()
  await ui.press({ key: 'why:plan' })
  expect(await ui.find({ type: 'Text', text: 'Write the failing test first, then change only sumTo.' })).toBeDefined()
  await ui.unmount()
  expect(lastActionText('Open: Opened foreman:plan:implementer-A in the app\'s sidebar (local_aaaa0001-0000-4000-8000-000000000001): answer it there. foreman keeps watching it.')).toBe('Open: Opened foreman:plan:implementer-A in the app\'s sidebar')
  expect(decisionWords({ at: '2026-10-17T10:05:00.000Z', stop: 'question', decision: 'answer', by: 'supervisor', text: 'x' }, 'B')).toBe('answered part B from the plan')
})

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }
const sessionText = async ($: { prompt: { compose: (i: never) => Promise<{ sections: { id: string; text: string }[] }> } }) => (await $.prompt.compose(COMPOSE as never)).sections.find(x => x.id === 'foreman:session')?.text ?? ''

test('the session section (D-68): what waits for the person after an escalation; what the supervisor decided after an answer', async ($, on) => {
  const w = world(on)
  await askAndSupervise(w, $, 'Not in the plan.\n{"decision":"escalate","reason":"the plan leaves it open","question":"Throw or return NaN?"}')
  expect(await sessionText($ as never)).toContain('Waiting for the person: plan:A: the supervisor escalates: the plan leaves it open: Throw or return NaN?.')
  // the person answers; the next stop the supervisor settles
  await $.command.run(typed('tell 1 "Throw."'))
  w.agent = { pid: 7, status: 'busy', state: 'working' }
  await tick(w, $)
  w.supervisor = 'Settled.\n{"decision":"answer","text":"The plan\'s criterion refuses it: throw a RangeError."}'
  await w.clock.advance(60_000)
  implementerTurn(w, 'and the message?', 'm2', 'question', { question: 'Which message for the RangeError?' })
  await tick(w, $)
  await tick(w, $)
  const text = await sessionText($ as never)
  expect(text).toMatch(/The supervisor last decided: plan:A at \d\d:\d\d: answer \(The plan's criterion refuses it: throw a RangeError\.\); the person can correct it with a Reply\./)
  expect(text.includes('Waiting for the person')).toBe(false)
})
