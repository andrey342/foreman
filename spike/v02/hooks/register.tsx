// foreman v0.2, Phase 0 spike. Every probe writes what it saw to the session's log
// (`$.store` key `v02:log:<sessionId>` and `<git common dir>/foreman-spike/log-<sessionId>.json`).
// Probes run from `/fspike <probe> [arg]` or from the model through `mcp__foreman-spike__spike`.
//
// Armed run (the desktop spike, F0-1/2/3/5/7): when `<git common dir>/foreman-spike/armed` holds
// `armed`, the first session that starts marks it used and runs `flow` from `session.start`,
// writing everything to `<git common dir>/foreman-spike/results.json`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'fspike'
const presses = atom({ plugin: 'foreman-spike', key: 'presses' } as const, 0)
const typed = atom({ plugin: 'foreman-spike', key: 'typed' } as const, '')
const picked = atom({ plugin: 'foreman-spike', key: 'picked' } as const, '')

// The implementer's own desktop session (claude agents --json: "Foreman v0.2 plugin implementation").
const IMPLEMENTER_SESSION = '08c56a72-0277-4b54-be0f-324158a97f21'
const LAB = 'C:\\Users\\javi-\\source\\repos\\foreman-lab'
const LAB_WT = 'C:/Users/javi-/source/repos/foreman-lab/.claude/worktrees/foreman-spike-x'
// The implementer's id as the app knows it (get_session "self"), for the ccd_session_mgmt tools.
const IMPLEMENTER_LOCAL = 'local_274575e3-41ae-48b4-aecd-a3e6ada65cee'

type Entry = Record<string, unknown>

let sessionId = ''
let spikeDir: string | undefined
let logFile: string | undefined
// set while an armed run writes results.json
let results: Entry | undefined

const PROBES = ['env', 'tools', 'notify', 'push', 'mcp', 'ask', 'askcmd', 'pane', 'panes', 'start', 'send', 'row', 'gitdir', 'review', 'reviewcwd', 'agent', 'agentwt', 'agentiso', 'settings', 'open', 'config', 'spawnreview', 'mcpstart', 'mcpsend', 'mcpstop', 'procreview', 'desktopcli', 'flow', 'dump'] as const

const errorOf = (err: unknown) => ({ error: String(err instanceof Error ? err.message : err) })

async function gitCommonDir($: EngineInterface, cwd?: string): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd ? { cwd } : {})
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function saveResults($: EngineInterface) {
  if (!results || !spikeDir) return
  try {
    await $.fs.write(`${spikeDir}/results.json`, JSON.stringify(results, null, 2))
  } catch {
    // the session log still has it
  }
}

async function log($: EngineInterface, probe: string, data: Entry): Promise<Entry> {
  const entry: Entry = { at: new Date().toISOString(), sessionId, probe, ...data }
  const key = `v02:log:${sessionId}`
  const all = [...(((await $.store.get(key)) as Entry[] | undefined) ?? []), entry]
  await $.store.set(key, all)
  if (logFile) {
    try {
      await $.fs.write(logFile, JSON.stringify(all, null, 2))
    } catch (err) {
      entry.logWrite = errorOf(err)
    }
  }
  if (results) {
    results.events = [...((results.events as Entry[] | undefined) ?? []), entry]
    await saveResults($)
  }
  return entry
}

async function agentRows($: EngineInterface): Promise<Entry[]> {
  const r = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 30_000 })
  return JSON.parse(r.stdout) as Entry[]
}

async function spawnTracked($: EngineInterface, description: string, prompt: string, cwd?: string) {
  const r = await $.agent.spawn({ subagentType: 'foreman-spike:reviewer', description, prompt, ...(cwd ? { cwd } : {}) })
  await $.store.set('v02:spawned', [...(((await $.store.get('v02:spawned')) as string[] | undefined) ?? []), r.agentId ?? ''])
  return r
}

const START_PAYLOAD = {
  title: 'foreman:spike:test',
  prompt: 'Reply with the word PONG and nothing else',
  initiation: 'user_asked',
  context: 'fresh',
  background: 'foreman v0.2 Phase 0 spike F0-1: a plugin creating a desktop session. Nothing to do but answer PONG; do not use any tool.',
  cwd: LAB,
  permission_mode: 'auto',
  use_worktree: false,
}

async function probe($: EngineInterface, name: string, arg: string, from: string): Promise<unknown> {
  switch (name) {
    case 'env':
      return {
        cwd: await $.session.cwd(),
        id: await $.session.id(),
        surfaces: await $.session.surfaces(),
        version: await $.session.version(),
        gitCommonDir: await gitCommonDir($),
        logFile,
      }
    case 'tools': {
      const names = (await $.tool.list()).map(t => t.name)
      return {
        count: names.length,
        startSession: names.includes('mcp__ccd_session__start_session'),
        stopSession: names.includes('mcp__ccd_session_mgmt__stop_session'),
        pushNotification: names.includes('PushNotification'),
        ccd: names.filter(n => n.startsWith('mcp__ccd_')),
        matches: names.filter(n => /SendMessage|AskUserQuestion|EnterWorktree|foreman/i.test(n)),
      }
    }
    case 'notify':
      return await $.ui.notify(`foreman-spike: notify probe (F0-7, ${from})`, { title: 'foreman spike' })
    case 'push':
      // not a built-in tool in the types: the input is cast
      return await $.tool.call({ tool: 'PushNotification', message: `foreman-spike: PushNotification probe (F0-7, ${from})`, status: 'proactive' } as never)
    case 'mcp':
      // F0-1 (b): does $.mcp.call reach the app's ccd_session server? a read-only tool
      return await $.mcp.call('ccd_session', arg || 'list_start_targets', {})
    case 'ask':
      return await $.ui.ask(`foreman spike (${from}): do you see this dialog in the app?`, ['Yes, I see it', 'No'])
    case 'askcmd':
      // the dialog asked from inside a command.run (queued by the plugin)
      return await $.command.run({ command: 'fspike', args: 'ask' })
    case 'pane':
      return { opened: await $.ui.open({ id: PANE, title: 'foreman spike v0.2' }), panes: await $.ui.panes() }
    case 'panes':
      return await $.ui.panes()
    case 'start':
      // F0-1 (a): can the plugin create a desktop session through the model's tool?
      return await $.tool.call({ tool: 'mcp__ccd_session__start_session', ...START_PAYLOAD } as never)
    case 'send': {
      // F0-3: arg = "<sessionId> <text>"
      const [to = IMPLEMENTER_SESSION, ...rest] = arg ? arg.split(/\s+/) : []
      return await $.session.send({ to: { sessionId: to }, text: rest.join(' ') || `foreman-spike F0-3: a plugin message by sessionId from ${sessionId}` })
    }
    case 'row': {
      // F0-5: this session's own row in claude agents, literal; arg: another sessionId or name
      const rows = await agentRows($)
      return rows.filter(r => (arg ? r.sessionId === arg || r.name === arg : r.sessionId === sessionId))
    }
    case 'gitdir': {
      const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel'], arg ? { cwd: arg } : {})
      return { cwd: arg || (await $.session.cwd()), exitCode: r.exitCode, stdout: r.stdout.trim().split(/\r?\n/), stderr: r.stderr.trim() }
    }
    case 'review': {
      // F0-10: the reviewer subagent writes under <git common dir>/foreman/<slug>/. arg: optional cwd
      const dir = await gitCommonDir($, arg || undefined)
      if (!dir) return { error: 'no git common dir' }
      const target = `${dir}/foreman/spike-x/review-x-${arg ? 'worktree' : 'main'}.md`
      const spawn = await spawnTracked($, 'spike review write', `Write a file at exactly this absolute path with the Write tool: ${target}\nIts content: the line "Verdict: OK" and then the line "written by the foreman-spike reviewer subagent".\nThen answer DONE, or the exact error if the write failed.`, arg || undefined)
      return { target, spawn }
    }
    case 'reviewcwd':
      // F0-10 / D-73: where does a subagent spawned with `cwd` actually run? arg: the cwd
      return { spawn: await spawnTracked($, 'spike reviewer cwd', 'Run exactly this with the Bash tool: pwd && git rev-parse --show-toplevel && git branch --show-current\nThen answer with its output only.', arg || undefined) }
    case 'agent': {
      // any prompt to the spike subagent: arg = "<cwd or -> <prompt...>"
      const [cwd = '-', ...words] = arg.split(/\s+/)
      return { spawn: await spawnTracked($, 'spike agent', words.join(' '), cwd !== '-' ? cwd : undefined) }
    }
    case 'agentwt':
      // D-73: the subagent enters the plan's worktree itself. arg: the worktree path
      return {
        spawn: await spawnTracked(
          $,
          'spike agent enters worktree',
          `1) Call the EnterWorktree tool with path "${arg}" as your very first action. 2) Use the Read tool on the relative path WT_MARKER.txt. 3) Run with the Bash tool: pwd && git branch --show-current. Answer with the three results verbatim, errors included.`,
        ),
      }
    case 'agentiso': {
      // D-73: a subagent pinned in its own worktree (isolation) switches into the plan's. arg: the worktree path
      const r = await $.agent.spawn({
        subagentType: 'foreman-spike:isoreviewer',
        description: 'spike isolated agent enters worktree',
        prompt: `0) Run with the Bash tool: pwd && git branch --show-current. 1) Call the EnterWorktree tool with path "${arg}". 2) Use the Read tool on the relative path WT_MARKER.txt. 3) Run with the Bash tool: pwd && git branch --show-current. Answer with the four results verbatim, errors included.`,
      })
      await $.store.set('v02:spawned', [...(((await $.store.get('v02:spawned')) as string[] | undefined) ?? []), r.agentId ?? ''])
      return { spawn: r }
    }
    case 'settings': {
      // F0-9 / M7: the effective permissions a thread would inherit (merged), and the local source alone
      const merged = (await $.settings.read()) as Entry
      const local = (await $.settings.read({ source: 'local' })) as Entry
      return { mergedPermissions: merged.permissions ?? null, localPermissions: local.permissions ?? null }
    }
    case 'open': {
      // D-69 Open for the background driver: show a thread in the app. `--desktop` refuses redirected
      // output, so `start` gives it a console of its own. arg: the thread's sessionId
      const [id = '', how = 'ps'] = arg.split(/\s+/)
      const argv =
        how === 'cmd'
          ? ['cmd', '/c', 'start', '""', 'claude', '--desktop', '--resume', id]
          : ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath claude -ArgumentList '--desktop','--resume','${id}' -WindowStyle Hidden`]
      const r = await $.process.run(argv, { timeoutMs: 30_000 })
      return { exitCode: r.exitCode, stdout: r.stdout.slice(0, 500), stderr: r.stderr.slice(0, 500) }
    }
    case 'spawnreview': {
      // D-84 (2e): the reviewer through $.process.spawn (no 10-minute cap), JSON result read from stdout
      const started = Date.now()
      let out = ''
      let err = ''
      const child = $.process.spawn({
        argv: ['claude', '-p', '--model', 'haiku', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Bash(git diff:*)', 'Bash(npm test)', '--output-format', 'json'],
        ...(arg ? { cwd: arg } : {}),
        input: 'Run exactly `npm test` with the Bash tool (no other command) and answer with the line "Verdict: OK" if it passes, else "Verdict: NO", then its pass and fail lines.',
      })
      for await (const piece of child) {
        if (piece.stream === 'stdout') out += piece.text
        else err += piece.text
      }
      const r = JSON.parse(out.slice(out.indexOf('{'))) as Entry
      return { wallMs: Date.now() - started, subtype: r.subtype, duration_ms: r.duration_ms, cost: r.total_cost_usd, result: r.result, stderr: err.slice(0, 300) }
    }
    case 'config': {
      // D-86: is the push switch a /config row setup could offer?
      const rows = await $.config.list()
      return rows.filter(r => /push|notif/i.test(`${r.key} ${r.label}`)).map(r => ({ key: r.key, label: r.label, kind: r.kind, value: r.value, options: r.options }))
    }
    case 'mcpstart':
      // F0-1 (b): the app's own MCP server, called by the plugin (no permission prompt, no classifier?)
      return await $.mcp.call('ccd_session', 'start_session', { ...START_PAYLOAD, title: arg || 'foreman:spike:mcp' })
    case 'mcpsend': {
      // F0-3 (b): arg = "<app session id> <text>"
      const [to = IMPLEMENTER_LOCAL, ...rest] = arg ? arg.split(/\s+/) : []
      return await $.mcp.call('ccd_session_mgmt', 'send_message', { session_id: to, message: rest.join(' ') || `foreman-spike F0-3: a plugin message through ccd_session_mgmt.send_message from ${sessionId}` })
    }
    case 'mcpstop':
      return await $.mcp.call('ccd_session_mgmt', 'stop_session', { session_id: arg })
    case 'procreview': {
      // D-73 alternative: the reviewer as a `claude -p` process whose cwd is the plan's worktree
      const r = await $.process.run(
        // --allowedTools takes several values: the prompt goes in by stdin
        ['claude', '-p', '--model', 'haiku', '--allowedTools', 'Read,Bash(pwd),Bash(git branch:*)'],
        { cwd: arg || LAB_WT, timeoutMs: 180_000, stdin: '1) Use the Read tool on the relative path WT_MARKER.txt. 2) Run with the Bash tool: pwd 3) Run with the Bash tool: git branch --show-current. Answer with the three results verbatim, errors included.' },
      )
      return { exitCode: r.exitCode, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 1000) }
    }
    case 'desktopcli': {
      // F0-1 (c in the plan's table, "claude --desktop" with a prompt)
      const r = await $.process.run(['claude', '--desktop', '--name', 'foreman:spike:b', 'Reply with PONG'], { timeoutMs: 30_000 })
      return { exitCode: r.exitCode, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) }
    }
    case 'flow':
      // `/fspike flow headless`: no surface wait, no queued command, no `claude --desktop`
      return await flow($, `command.run (${from})`, arg !== 'headless')
    case 'dump':
      return (await $.store.get(`v02:log:${sessionId}`)) ?? []
    default:
      return { error: `unknown probe "${name}"; one of ${PROBES.join(', ')}` }
  }
}

async function run($: EngineInterface, name: string, arg: string, from: string): Promise<string> {
  let result: unknown
  try {
    result = await probe($, name, arg, from)
  } catch (err) {
    result = errorOf(err)
  }
  await log($, name, { from, arg, result })
  return `${name}: ${JSON.stringify(result)}`
}

// One step of the armed run: its result (or error) lands in results.json at once.
async function step($: EngineInterface, key: string, fn: () => Promise<unknown>) {
  const started = new Date().toISOString()
  let value: unknown
  try {
    value = await fn()
  } catch (err) {
    value = errorOf(err)
  }
  if (results) results[key] = { started, ended: new Date().toISOString(), value }
  await saveResults($)
  return value
}

async function flow($: EngineInterface, from: string, inApp: boolean): Promise<Entry> {
  results = { sessionId, from, startedAt: new Date().toISOString(), events: [] }
  await saveResults($)
  const at = `flow from ${from}`
  // non-interactive first
  await step($, 'env', () => probe($, 'env', '', at))
  await step($, 'tools', () => probe($, 'tools', '', at))
  await step($, 'notify', () => probe($, 'notify', '', at))
  await step($, 'push', () => probe($, 'push', '', at))
  await step($, 'mcpCall', () => probe($, 'mcp', '', at))
  await step($, 'sendToImplementer', () => probe($, 'send', '', at))
  await step($, 'ownRow', () => probe($, 'row', '', at))
  await step($, 'spawnCwd', () => probe($, 'agent', `${LAB_WT} 1) Use the Read tool on the relative path WT_MARKER.txt. 2) Run with the Bash tool: pwd && git branch --show-current. Answer with both results verbatim, errors included.`, at))
  await step($, 'spawnEnterWorktree', () => probe($, 'agentwt', LAB_WT, at))
  // then what needs the person: wait for the desktop to attach (a -p run never does)
  if (inApp) {
    await step($, 'surfaceWait', async () => {
      for (let i = 0; i < 180; i++) {
        const surfaces = await $.session.surfaces()
        if (surfaces.length > 0) return { surfaces, waitedMs: i * 500 }
        await $.clock.sleep(500)
      }
      return { surfaces: [], waitedMs: 90_000 }
    })
  }
  await step($, 'pane', () => probe($, 'pane', '', at))
  await step($, 'askFromSessionStart', () => probe($, 'ask', '', at))
  if (inApp) {
    // queued until the session is idle; bounded so the run always ends
    await step($, 'askFromCommandRun', () =>
      Promise.race([probe($, 'askcmd', '', at), $.clock.sleep(180_000).then(() => ({ error: 'no answer within 180 s' }))]),
    )
  }
  // F0-1 (a): the plugin creates a desktop session, then F0-3 to it
  const started = await step($, 'startSession', () => probe($, 'start', '', at))
  if (started && typeof started === 'object' && !('error' in started)) {
    const row = await step($, 'startedRow', async () => {
      for (let i = 0; i < 60; i++) {
        const rows = (await agentRows($)).filter(r => r.name === START_PAYLOAD.title)
        if (rows.length > 0) return rows
        await $.clock.sleep(1000)
      }
      return []
    })
    const first = Array.isArray(row) ? (row[0] as Entry | undefined) : undefined
    if (first && typeof first.sessionId === 'string') {
      await step($, 'sendToStarted', () => probe($, 'send', `${first.sessionId} foreman-spike F0-3: reply with the word PING-ACK and nothing else`, at))
    }
  }
  if (inApp) await step($, 'desktopCli', () => probe($, 'desktopcli', '', at))
  if (inApp) {
    // M1: the same notices two minutes later, when the person has likely left this session
    await $.clock.sleep(120_000)
    await step($, 'latePush', () => probe($, 'push', '', `${at}, 2 min later`))
    await step($, 'lateNotify', () => probe($, 'notify', '', `${at}, 2 min later`))
    await step($, 'latePanes', () => probe($, 'panes', '', at))
  }
  results.finishedAt = new Date().toISOString()
  await saveResults($)
  return results
}

const appIdOf = (value: unknown) => /local_[0-9a-f-]{36}/.exec(JSON.stringify(value) ?? '')?.[0]

// Round 2 (armed2): the ccd tools through $.mcp.call, a reviewer as a process, then the person's presses.
async function flow2($: EngineInterface, from: string): Promise<Entry> {
  results = { round: 2, sessionId, from, startedAt: new Date().toISOString(), events: [] }
  await saveResults($)
  const at = `flow2 from ${from}`
  await step($, 'env', () => probe($, 'env', '', at))
  await step($, 'pane', () => probe($, 'pane', '', at))
  const started = await step($, 'mcpStart', () => probe($, 'mcpstart', 'foreman:spike:mcp', at))
  const appId = appIdOf(started)
  await step($, 'startedAppId', async () => appId ?? null)
  const row = await step($, 'startedRow', async () => {
    for (let i = 0; i < 90; i++) {
      const rows = (await agentRows($)).filter(r => r.name === 'foreman:spike:mcp')
      if (rows.length > 0 && rows.some(r => r.status === 'idle')) return rows
      await $.clock.sleep(1000)
    }
    return (await agentRows($)).filter(r => r.name === 'foreman:spike:mcp')
  })
  const first = Array.isArray(row) ? (row[0] as Entry | undefined) : undefined
  if (appId) await step($, 'mcpSendStarted', () => probe($, 'mcpsend', `${appId} foreman-spike F0-3 (mcp): reply with the word PING-ACK and nothing else`, at))
  if (first && typeof first.sessionId === 'string') {
    await step($, 'sessionSendStarted', () => probe($, 'send', `${first.sessionId} foreman-spike F0-3 ($.session.send): reply with the word PING-ACK-2 and nothing else`, at))
  }
  if (appId) {
    await $.clock.sleep(20_000)
    await step($, 'mcpStopIdle', () => probe($, 'mcpstop', appId, at))
    await step($, 'mcpSendLong', () => probe($, 'mcpsend', `${appId} Run this with the Bash tool: sleep 60 — then answer DONE.`, at))
    await $.clock.sleep(15_000)
    await step($, 'rowBeforeStop', async () => (await agentRows($)).filter(r => r.name === 'foreman:spike:mcp'))
    await step($, 'mcpStopBusy', () => probe($, 'mcpstop', appId, at))
    await $.clock.sleep(3_000)
    await step($, 'rowAfterStop', async () => (await agentRows($)).filter(r => r.name === 'foreman:spike:mcp'))
  }
  await step($, 'mcpSendImplementer', () => probe($, 'mcpsend', '', at))
  await step($, 'procReview', () => probe($, 'procreview', LAB_WT, at))
  results.finishedAt = new Date().toISOString()
  await saveResults($)
  return results
}

// D-84 (2a): the deny text when this process is a reviewer (FOREMAN_THREAD from --settings env)
async function reviewerGuard($: EngineInterface, tool: string): Promise<string | undefined> {
  const thread = (await $.env.get('FOREMAN_THREAD')) ?? ''
  if (!/:reviewer-/.test(thread)) return undefined
  await log($, 'guard.deny', { tool, thread })
  return `foreman-spike guard: ${thread} is a reviewer and may not use ${tool}`
}

let armChecked = false

// Only a desktop session consumes the arm (a `claude --bg` or `-p` session in this repo leaves it); once per load.
async function runIfArmed($: EngineInterface, from: string, isDesktop: boolean) {
  if (armChecked || !spikeDir) return
  // at session.attach the roster may not list the client yet: the attach itself says it
  if (!isDesktop && !(await $.session.surfaces()).includes('desktop')) return
  armChecked = true
  const armedFile = `${spikeDir}/armed`
  const armed = (await $.fs.exists(armedFile)) ? (await $.fs.read(armedFile)).trim() : ''
  if (armed !== 'armed' && armed !== 'armed2') return
  await $.fs.write(armedFile, `${armed} used by ${sessionId} at ${new Date().toISOString()} (${from})
`)
  // detached: the hook does not wait for the person
  const running = armed === 'armed' ? flow($, from, true) : flow2($, from)
  void running.catch(err => log($, 'flow.error', errorOf(err)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const dir = await gitCommonDir($)
    spikeDir = dir ? `${dir}/foreman-spike` : '.spike'
    logFile = `${spikeDir}/log-${sessionId}.json`
    await log($, 'session.start', { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, surfaces: await $.session.surfaces() })
    await $.command.register({ name: 'fspike', description: 'foreman v0.2 spike probes', argumentHint: PROBES.join('|') })
    await $.agent.register({
      name: 'reviewer',
      description: 'foreman spike: writes one file where it is told',
      prompt: 'You are a spike helper. Do exactly what the prompt says with your tools, then answer DONE or the exact results asked for.',
      tools: ['Read', 'Write', 'Bash', 'EnterWorktree'],
      model: 'haiku',
      effort: 'low',
      permissionMode: 'auto',
    })
    await $.agent.register({
      name: 'isoreviewer',
      description: 'foreman spike: an isolated subagent that enters an existing worktree',
      prompt: 'You are a spike helper. Do exactly what the prompt says with your tools, then answer with the exact results asked for.',
      tools: ['Read', 'Bash', 'EnterWorktree'],
      model: 'haiku',
      effort: 'low',
      permissionMode: 'auto',
      isolation: 'worktree',
    })
    await $.tool.register({
      name: 'status',
      description: "foreman's status: how the plan foreman runs is going (parts, threads, reviews). Call it when the user asks foreman how things are going, e.g. 'foreman, ¿cómo va?' or 'foreman, status'.",
      inputSchema: { type: 'object', properties: {} },
      // F0-8: left out, a plugin tool waits behind ToolSearch like an MCP server's
      isDeferred: false,
    })
    await $.tool.register({
      name: 'spike',
      description: 'foreman v0.2 spike probe runner (development only). Call it only when asked to run a named spike probe.',
      inputSchema: {
        type: 'object',
        properties: { probe: { type: 'string', enum: [...PROBES] }, arg: { type: 'string' } },
        required: ['probe'],
      },
    })
    // in the app the desktop attaches after session.start: the arm is checked at both
    await runIfArmed($, 'session.start', false)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await log($, 'session.attach', { surface: e.surface, clientId: e.clientId, viewport: e.viewport ?? null, panes: await $.ui.panes() })
    if (e.surface === 'desktop') await runIfArmed($, 'session.attach', true)
    return next(e)
  })

  on('command.run', { command: 'fspike' }, async ($, e) => {
    // the app runs 2.1.295 and these types are 2.1.296: read the input defensively
    const origin = (e as { origin?: { kind?: string } }).origin?.kind ?? 'none'
    const [name = '', ...rest] = (e.args ?? '').trim().split(/\s+/)
    return { text: await run($, name, rest.join(' '), `command.run (origin ${origin}, command ${e.command})`) }
  })

  // D-84 (2a): in a process started with --settings '{"env":{"FOREMAN_THREAD":"foreman:<plan>:reviewer-<part>"}}'
  // the plugin acts as the reviewer's guard: no writes
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await reviewerGuard($, e.tool)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'foreman-spike guard could not judge this call' }))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await reviewerGuard($, e.tool)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'foreman-spike guard could not judge this call' }))

  on('tool.call', { tool: 'mcp__foreman-spike__status' }, async ($, e) => {
    await log($, 'status.tool', { tool_use_id: e.tool_use_id })
    return { result: 'foreman (spike): no plan is running in this repo; 0 threads, 0 reviews.' }
  })

  on('tool.call', { tool: 'mcp__foreman-spike__spike' }, async ($, e) => {
    const input = e as unknown as { probe?: string; arg?: string }
    return { result: await run($, input.probe ?? '', input.arg ?? '', 'tool.call') }
  })

  on('turn.complete', async ($, e, next) => {
    const spawned = ((await $.store.get('v02:spawned')) as string[] | undefined) ?? []
    if (e.agentId !== undefined && spawned.includes(e.agentId)) await log($, 'subagent.answer', { agentId: e.agentId, answer: e.answer, usage: e.usage ?? null })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    // mobile has no Input or Select
    if (!('Input' in els) || !('Select' in els)) return <Text>foreman spike: no fields on {e.surface}</Text>
    const { Input, Select } = els
    const n = await read($, presses)
    const t = await read($, typed)
    const p = await read($, picked)
    return (
      <Box flexDirection="column">
        <Markdown text={`**foreman spike v0.2** on \`${e.surface}\`\n\nPress the button, type in the field and press Enter, pick an option.`} />
        <Text>presses: {n}</Text>
        <Button
          key="press"
          label="Press me"
          onPress={async () => {
            const v = await update($, presses, x => (x ?? 0) + 1)
            await log($, 'pane.press', { surface: e.surface, presses: v })
          }}
        />
        <Button key="spawn" label="Spawn test" onPress={async () => void (await run($, 'reviewcwd', LAB_WT, `pane press on ${e.surface}`))} />
        <Button key="send" label="Send test" onPress={async () => void (await run($, 'send', '', `pane press on ${e.surface}`))} />
        <Input
          key="reply"
          label="Reply"
          placeholder="type and press Enter"
          submitLabel="send"
          onSubmit={async (value: string) => {
            await update($, typed, () => value)
            await log($, 'pane.input', { surface: e.surface, value })
          }}
        />
        <Text>typed: {t || '-'}</Text>
        <Select
          key="mode"
          label="Mode"
          options={[{ value: 'auto', label: 'auto' }, { value: 'review', label: 'review' }]}
          value={p || 'auto'}
          onSelect={async (value: string) => {
            await update($, picked, () => value)
            await log($, 'pane.select', { surface: e.surface, value })
          }}
        />
        <Text>picked: {p || '-'}</Text>
      </Box>
    )
  })
}
