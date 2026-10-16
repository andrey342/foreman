// Phase 2 through the plugin's own hooks: the background driver as the
// watcher sees it (a thread opened in the app, a process that died mid-turn),
// the pane v2 and its buttons, the notices (M1), the model's tools (M2), the
// preflight (M3) and the permissions a thread inherits (M7). The CLI, the
// transcripts, the dialog, the clock and the store are beneath the plugin.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../types'
import { TOOLS } from './lib/tools'

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
  spawns: { type: string; prompt: string; description: string }[]
  live: { id: string; type: string; description: string }[]
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
    live: [],
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
    if (a[0] === 'powershell.exe') { w.opens.push({ argv: a, ...(e.init?.env ? { env: { ...e.init.env } } : {}) }); return ok('') }
    return fail(`unexpected ${a.join(' ')}`, 1)
  })
  on('agent.register', () => ({ value: { agent: 'foreman:reviewer' } }))
  on('agent.spawn', ($, e) => {
    const x = e as unknown as { subagentType?: string; subagent_type?: string; prompt: string; description: string }
    const type = x.subagentType ?? x.subagent_type ?? ''
    w.spawns.push({ type, prompt: x.prompt, description: x.description })
    const id = `agent${w.spawns.length}`
    w.live.push({ id, type, description: x.description })
    return { model: 'claude-sonnet-5-5', agentId: id }
  })
  on('agent.list', () => ({ value: w.live.map(a => ({ id: a.id, description: a.description, type: a.type, status: 'running' })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
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
const complete = (agentId: string, answer: string) => ({ answer, durationMs: 1000, isAborted: false, turnId: 't', agentId, reason: 'answer' as const })

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
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'thread', reason: 'the implementer is waiting: Throw or return NaN for negative n?' })
  expect(w.toasts.some(t => t.includes('plan:A: waiting, the implementer is waiting: Throw or return NaN'))).toBe(true)
  expect(w.statuses.at(-1)).toContain('1 waiting')
  expect(w.pushes).toEqual(['foreman: plan:A: waiting, the implementer is waiting: Throw or return NaN for negative n?'])
  // what PushNotification answered goes to the debug log and foreman.json only, not the chat (review P3)
  expect(w.debug).toContain('PushNotification: not sent (config_off)')
  expect(w.logs.some(l => l.startsWith('PushNotification'))).toBe(false)
  expect(runDoc(w).notices.at(-1)).toMatchObject({ level: 'stop', push: 'not sent (config_off)' })
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^Needs you \(1\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}Part A: Needs your answer$/ })).toBeDefined()
  // the part in the person's words, the question in full, the technical details last and dim (review UX)
  expect(await ui.find({ type: 'Text', text: /› A · Part A — Needs your answer$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {6}Throw or return NaN for negative n\?$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /thread aaaa0001 · Waiting for you · opus\/high/ })).toBeDefined()
  await ui.input({ key: 'reply:aaaa0001', text: 'Throw a RangeError.' })
  await w.clock.settle()
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
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: OK\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(cyclesOf(w).map(c => c.phase)).toEqual(['ready', 'implementing'])
  expect(w.pushes).toEqual([])
  expect(w.toasts.some(t => t.includes('part B started'))).toBe(false)
  expect(runDoc(w).notices.map((n: { level: string; text: string }) => `${n.level} ${n.text}`)).toEqual(['info plan:A: ready, review r1 OK after 1 round(s)', 'info plan: part B started (foreman:plan:implementer-B)'])
  // the ready part's thread is done, not "ready for review" (review O-4)
  expect(threadsOf(w)[0]?.state).toBe('done')
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

test('criterion 4: five tools in the prompt\'s list; status answers; go asks the person even with parts named, and with no dialog starts nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  expect(w.tools).toEqual(['status', 'go', 'reply', 'next', 'open'].map(name => ({ name, isDeferred: false })))
  const status = await $.tool.call({ tool: 'mcp__foreman__status' } as never)
  expect(String((status as { result?: unknown }).result)).toContain('No threads.')
  // a report, said so to the model: it opened a thread on its own after one in the acceptance (review 7)
  expect(String((status as { result?: unknown }).result)).toContain('Nothing waits for the person.\n(A report: tell the user what it says. Open a thread, reply, or start the next part only when the user asks for it.)')
  w.answer = 'Cancel'
  const cancelled = await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review', parts: 'A' } as never)
  expect(w.asked.at(-1)).toContain('Run 1 part(s) of docs/plan.md in order (review mode)?')
  expect(String((cancelled as { result?: unknown }).result)).toContain('Not started (Cancel)')
  w.answer = 'deny'
  const noDialog = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review' } as never) as { result?: unknown }).result)
  expect(noDialog).toContain('Not started: there is no dialog here to confirm it with the person.')
  expect(noDialog).toContain('To start it, the person types: /foreman go docs/plan.md --mode review --yes')
  expect(w.launches.length).toBe(0)
  const flagged = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: '--yes' } as never) as { result?: unknown }).result)
  expect(flagged).toBe('plan cannot start with "-".')
  w.answer = 'Run them'
  const started = String((await $.tool.call({ tool: 'mcp__foreman__go', plan: 'docs/plan.md', mode: 'review' } as never) as { result?: unknown }).result)
  expect(started).toContain('Plan plan started: 2 part(s), in order, review mode:')
  expect(plansOf(w)[0]).toMatchObject({ mode: 'review', status: 'running' })
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

test('criterion 8: review mode in the pane: parts, Next part after A is ready, the mode picker, Pause and Resume, on desktop', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md --mode review --yes'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'done', 'm1')
  await tick(w, $)
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: OK\n\nAll criteria met.\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'paused', reason: 'review mode: part A is ready; Next part starts part B' })
  expect(w.launches.length).toBe(1)
  expect(w.pushes.at(-1)).toBe('foreman: plan: part A ready; review mode: part A is ready; Next part starts part B')
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'desktop', component: 'Pane', requestId: 'foreman', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^Plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}Waiting for Next part$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /› A · Part A — Ready \(review r1 OK\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /plan plan · docs\/plan\.md · review mode · part A \(1 of 2\)/ })).toBeDefined()
  // the review, shown in the pane and hidden again (M5); the button's key is the thread's, so it stays when the review changes
  await ui.press({ key: 'review:aaaa0001' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Markdown', text: /All criteria met\./ })).toBeDefined()
  await ui.press({ key: 'hide-review' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  // the mode picker: auto from now on; part A still waits for Next part
  await ui.select({ key: 'mode:plan', value: 'auto' })
  await w.clock.settle()
  expect(plansOf(w)[0]).toMatchObject({ mode: 'auto', status: 'paused' })
  await ui.press({ key: 'next:plan' })
  await w.clock.settle()
  await tick(w, $)
  expect(w.launches.length).toBe(2)
  expect(plansOf(w)[0]).toMatchObject({ status: 'running', current: 1 })
  expect(runDoc(w).transitions.some((x: { note?: string }) => x.note === 'resumed: part B may start')).toBe(true)
  // Pause and Resume are one button with one key: the press after the redraw lands on the same element
  await ui.press({ key: 'toggle:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('paused')
  expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined()
  await ui.press({ key: 'toggle:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('running')
  // every press of the plan's buttons reached foreman and is in its record; the pane says what the last one did
  expect(runDoc(w).presses.map((p: { element: string; surface: string }) => `${p.element} ${p.surface}`)).toEqual(['review:aaaa0001 desktop', 'next:plan desktop', 'toggle:plan desktop', 'toggle:plan desktop'])
  expect(await ui.find({ type: 'Text', text: /^Last: \d\d:\d\d Pause\/Resume: Resumed plan/ })).toBeDefined()
  // a Next part with nothing to start says why, in the pane
  await ui.press({ key: 'next:plan' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Last: \d\d:\d\d Next part: plan is on its last part \(B\)/ })).toBeDefined()
  await ui.unmount()
})

test('/foreman next says why there is nothing to start yet', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md --mode review --yes'))
  expect((await $.command.run(typed('next'))).text).toBe('Part A of plan is not ready yet (implementing); Next part starts part B once it is.')
  expect(String((await $.tool.call({ tool: 'mcp__foreman__next' } as never) as { result?: unknown }).result)).toBe('Part A of plan is not ready yet (implementing); Next part starts part B once it is.')
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
  expect(await ui.find({ type: 'Text', text: /› A · Part A — Open in the app$/ })).toBeDefined()
  await ui.unmount()
})

test('the open tool says it is only for when the person asks; the status tool that it changes nothing (review 7)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: false } as never)
  expect(w.tools.length).toBe(5)
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
