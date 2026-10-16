// A plan end to end through the plugin's own hooks (/foreman go): the CLI, the
// transcripts, the reviewer subagents, the dialog, the clock and the shared
// store are beneath it. Paths reach fs.* hooks with `\` (the engine normalises them).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanCycle, ForemanPlanRun, ForemanThread } from '../types'

const NOW_MS = Date.parse('2026-10-10T02:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const K = (p: string) => p.split('/').join('\\')
const TPATH = 'C:\\home\\.claude\\projects\\C--demo\\aaaa0001-s.jsonl'
/** The plan's folder (D-70): under the repo's .git, named by the plan's slug. */
const RUN = 'C:\\demo\\.git\\foreman\\plan'
const PLAN = '# Plan\n\n## Part A\nFix sumTo.\n\n**Acceptance**\n- sumTo(5) is 15\n\n## Part B\nDocument it.\n'
const PAUSED_PLAN = '# Plan\n\n## Part A\nFix sumTo.\n\n**Pause:** the team checks A before B.\n\n## Part B\nDocument it.\n'
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const row = (o: Record<string, unknown>) => JSON.stringify(o)
const fence = (summary: string, status = 'done') => '```foreman-result\n' + JSON.stringify({ status, summary }) + '\n```'

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  agent: Record<string, unknown> | undefined
  launched: boolean
  launches: string[][]
  resumes: string[][]
  spawns: { type: string; prompt: string; description: string }[]
  live: { id: string; type: string; description: string }[]
  sessions: { sessionId: string; pid?: number }[]
  me: string
  toasts: string[]
  logs: string[]
  notified: string[][]
  all: string[][]
  copied: string[]
  /** What the person picks in the next dialog; `deny`: no dialog in this session (a -p run). */
  answer: string
  asked: string[]
}

function world(on: On, seed: { files?: Record<string, string>; store?: Record<string, unknown> } = {}): World {
  const w: World = {
    files: { 'C:\\demo\\docs\\plan.md': PLAN, ...(seed.files ?? {}) },
    store: { ...(seed.store ?? {}) },
    clock: mock.clock(on, { now: NOW_MS }),
    agent: { pid: 7, status: 'busy', state: 'working' },
    launched: false,
    launches: [],
    resumes: [],
    spawns: [],
    live: [],
    sessions: [],
    me: 'sess-me',
    toasts: [],
    logs: [],
    notified: [],
    all: [],
    copied: [],
    answer: 'Run them',
    asked: [],
  }
  const isDir = (p: string) => ['c:\\demo', 'c:\\demo\\'].includes(K(p).toLowerCase()) || Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: 'C:\\demo' }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.id', () => ({ value: w.me }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('command.list', () => ({ value: [] }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\home' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.exists', ($, e) => ({ value: K(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = K(e.path).replace(/\\+$/, '')
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
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
    if (p in w.files) return { value: w.files[p] as string }
    if (p.includes('\\prompts\\')) {
      if (p.includes('\\agents\\')) return { value: 'SYSTEM' }
      if (p.endsWith('reviewer.md')) return { value: 'REVIEW {{reviewFile}} BASE {{base}} PREV {{previous}}' }
      return { value: p.endsWith('_result.md') ? 'END' : p.endsWith('_rules.md') ? 'RULES' : 'TASK: {{task}} PLAN {{plan}} PART {{part}}\n{{partText}}\n{{criteria}}' }
    }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    const a = [...e.argv]
    w.all.push(a)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && a.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === 'HEAD') return ok('abc1234def5678\n')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('HEAD~1')) return ok('0123456789ab\n')
    if (a[1] === 'agents') {
      const rows: unknown[] = w.sessions.map(s => ({ ...s, cwd: 'C:\\demo', kind: 'interactive', startedAt: 0 }))
      if (w.agent && w.launched) rows.push({ id: 'aaaa0001', sessionId: 'aaaa0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'foreman:plan:implementer-A', ...w.agent })
      // any later thread (the next part) has just started working
      w.launches.slice(1).forEach((_, i) => rows.push({ id: `bbbb000${i + 1}`, sessionId: `bbbb000${i + 1}-s`, cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, pid: 9, status: 'busy', state: 'working' }))
      return ok(JSON.stringify(rows))
    }
    if (a[1] === '--bg' && a[2] === '--resume') { w.resumes.push(a); return ok('note: woke session aaaa0001 with its saved options\nbackgrounded · aaaa0001 · foreman:plan:implementer-A') }
    if (a[1] === '--bg') {
      w.launches.push(a)
      w.launched = true
      const id = w.launches.length === 1 ? 'aaaa0001' : `bbbb000${w.launches.length - 1}`
      return ok(`backgrounded · ${id} · ${a[3]}`)
    }
    if (a[1] === 'stop') return ok('stopped aaaa0001')
    if (a[0] === 'notify-me') { w.notified.push(a); return ok('') }
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected ${a.join(' ')}`, isStdoutTruncated: false, isStderrTruncated: false } }
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
  // $.ui.ask is a tool.call of AskUserQuestion: answered with the label the person picks
  on('tool.call', ($, e) => {
    if (String(e.tool) !== 'AskUserQuestion') return { result: 'ran' }
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    w.asked.push(q)
    if (w.answer === 'deny') return { deny: 'no one to ask in a -p run' }
    return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: w.answer } } } as never
  })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.copy', ($, e) => { w.copied.push(e.text); return { value: { isCopied: true } } })
  return w
}

const cyclesOf = (w: World) => (w.store['v2:cycles:c:/demo'] ?? []) as ForemanCycle[]
const threadsOf = (w: World) => (w.store['v2:threads:c:/demo'] ?? []) as ForemanThread[]
const plansOf = (w: World) => ((w.store['plans:c:/demo'] as { plans?: ForemanPlanRun[] } | undefined)?.plans ?? [])
const runDoc = (w: World) => JSON.parse(w.files[`${RUN}\\foreman.json`] ?? '{}')
const cycleMoves = (w: World, part = 'A') => (runDoc(w).transitions as { thread: string; from: string; to: string; at: string }[]).filter(t => t.thread === `cycle:${part}` && t.from !== t.to).map(t => `${t.from}>${t.to}`)
const complete = (agentId: string, answer: string) => ({ answer, durationMs: 1000, isAborted: false, turnId: 't', agentId, reason: 'answer' as const })

/** The implementer ends a turn: its prompt row (after foreman sent it) and its answer, written now. */
function implementerTurn(w: World, prompt: string, summary: string, id: string, status = 'done') {
  const t = w.clock.now()
  w.files[TPATH] = [
    ...(w.files[TPATH] ? [w.files[TPATH]] : []),
    row({ type: 'user', timestamp: iso(t + 100), message: { role: 'user', content: prompt } }),
    row({ type: 'assistant', timestamp: iso(t + 2000), message: { id, content: [{ type: 'text', text: `done\n\n${fence(summary, status)}` }], usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    row({ type: 'system', subtype: 'turn_duration', timestamp: iso(t + 3000) }),
  ].join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
}

/** A look by the watcher: what a 30 s tick does. */
async function tick(w: World, $: { command: { run: (i: ReturnType<typeof typed>) => Promise<{ text?: string }> } }) {
  await w.clock.advance(30_000)
  return (await $.command.run(typed('status'))).text ?? ''
}

test('go: part A implemented → review NO → apply (path only) → review OK → ready, then part B starts by itself', async ($, on) => {
  const w = world(on)
  const out = (await $.command.run(typed('go docs/plan.md'))).text ?? ''
  expect(w.asked[0]).toContain('Run 2 part(s) of docs/plan.md in order (auto mode)?')
  expect(w.asked[0]).toContain('• A · Part A (1 criteria)')
  expect(out).toContain('Plan plan started: 2 part(s), in order, auto mode:')
  expect(out).toContain('Part A: foreman:plan:implementer-A (aaaa0001')
  // the thread's prompt names its brief file; the brief holds the part's own text and criteria (D-69, D-76)
  expect(w.launches[0]?.at(-1)).toBe(`Read and follow the brief in \`${RUN}\\brief-A.md\`. It is your assignment; the file is yours to read, not to edit.`)
  const brief = w.files[`${RUN}\\brief-A.md`] ?? ''
  expect(brief).toContain('TASK: Implement part A (Part A) of the plan `docs/plan.md`. PLAN docs/plan.md PART A')
  expect(brief).toContain('Fix sumTo.')
  expect(brief).toContain('- sumTo(5) is 15')
  expect(brief).toContain('RULES')
  expect(cyclesOf(w)[0]).toMatchObject({ id: 'plan:A', phase: 'implementing', base: 'abc1234def5678', owner: 'sess-me', maxCycles: 3 })
  expect(plansOf(w)[0]).toMatchObject({ id: 'plan', status: 'running', current: 0, dir: RUN })

  await w.clock.advance(60_000)
  implementerTurn(w, 'Read and follow…', 'first try', 'm1')
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'reviewing', rounds: [{ n: 1, agentId: 'agent1', verdict: 'none' }] })
  expect(w.spawns[0]?.type).toBe('foreman:reviewer')
  expect(w.spawns[0]?.prompt).toContain(`REVIEW ${RUN}\\review-A-r1.md BASE abc1234def5678 PREV none: this is the first review of the part`)

  // the reviewer writes NO and answers
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: NO\n\n### C-01 · P2 · src/sum.js:1 · missing JSDoc\nSECRET-REVIEW-BODY\n'
  await $.turn.complete(complete('agent1', '{"verdict":"NO","findings":1}'))
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', rounds: [{ n: 1, verdict: 'NO', findings: 1 }] })
  expect(w.resumes.length).toBe(1)
  const msg = w.resumes[0]?.at(-1) ?? ''
  expect(msg).toContain(`\`${RUN}\\review-A-r1.md\``)
  expect(msg.includes('SECRET-REVIEW-BODY')).toBe(false)
  expect(msg.includes('missing JSDoc')).toBe(false)

  // the implementer applies it; the job's row keeps saying done (SPIKE addendum), the transcript decides
  await w.clock.advance(60_000)
  implementerTurn(w, msg, 'applied C-01', 'm2')
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'reviewing' })
  expect(w.spawns.length).toBe(2)
  expect(w.spawns[1]?.prompt).toContain(`PREV ${RUN}\\review-A-r1.md`)
  w.files[`${RUN}\\review-A-r2.md`] = 'Verdict: OK\n\nC-01 fixed.\n'
  await $.turn.complete(complete('agent2', '{"verdict":"OK","findings":0}'))
  await tick(w, $)
  expect(cycleMoves(w)).toEqual(['none>implementing', 'implementing>reviewing', 'reviewing>applying', 'applying>implementing', 'implementing>reviewing', 'reviewing>ready'])
  for (const t of runDoc(w).transitions as { at: string }[]) expect(Number.isNaN(Date.parse(t.at))).toBe(false)
  expect(w.toasts.some(t => t === 'plan:A: ready, review r2 OK after 2 round(s)')).toBe(true)
  // part A ready: part B started in the same look, on its own thread, from the commit A ended at
  expect(cyclesOf(w).map(c => `${c.id}:${c.phase}`)).toEqual(['plan:A:ready', 'plan:B:implementing'])
  expect(plansOf(w)[0]).toMatchObject({ status: 'running', current: 1 })
  expect(w.launches.length).toBe(2)
  expect(w.files[`${RUN}\\brief-B.md`]).toContain('Document it.')
  expect(w.toasts.some(t => t === 'plan: part B started (foreman:plan:implementer-B)')).toBe(true)
  const status = (await $.command.run(typed('status'))).text ?? ''
  expect(status).toContain('- plan · running · part B (2/2) implementing')
  expect(status).toContain('- Part A of plan: ready · r1 NO, r2 OK · max 3')
  // progress.md says it (D-70)
  expect(w.files[`${RUN}\\progress.md`]).toContain('## Part A · Part A\n\n- State: ready')
  expect(w.files[`${RUN}\\progress.md`]).toContain('## Part B · Part B\n\n- State: implementing')
})

test('go writes everything under .git/foreman/<slug>/ and nothing in the work tree (Phase 1 criterion 2, kit level)', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  const written = Object.keys(w.files).filter(f => f !== 'C:\\demo\\docs\\plan.md')
  expect(written.sort()).toEqual([`${RUN}\\brief-A.md`, `${RUN}\\foreman.json`, `${RUN}\\progress.md`])
  expect(runDoc(w)).toMatchObject({ v: 2, runId: 'plan', plan: { id: 'plan', plan: 'docs/plan.md' } })
})

test('go asks to confirm the parts: Cancel starts nothing; --parts runs the named ones without asking; with nobody to ask it starts and says so', async ($, on) => {
  const w = world(on)
  w.answer = 'Cancel'
  expect((await $.command.run(typed('go docs/plan.md'))).text).toContain('Not started (Cancel).')
  expect(w.launches.length).toBe(0)
  expect(plansOf(w)).toEqual([])
  w.answer = 'deny'
  const out = (await $.command.run(typed('go docs/plan.md --parts B'))).text ?? ''
  expect(w.asked.length).toBe(1)
  expect(out).toContain('Plan plan started: 1 part(s)')
  expect(w.launches[0]?.at(-1)).toContain('brief-B.md')
})

test('with nobody to confirm with (a -p run) go starts as asked and says so', async ($, on) => {
  const w = world(on)
  w.answer = 'deny'
  expect((await $.command.run(typed('go docs/plan.md'))).text).toContain('Plan plan started (Nobody to confirm with in this session: started as asked.)')
})

test('one plan per repo: the same plan answers with its state, another is refused, nothing launches (Phase 1 criterion 7)', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\other.md': '# Other\n## Part A\nx\n' } })
  await $.command.run(typed('go docs/plan.md'))
  expect((await $.command.run(typed('go docs/plan.md'))).text).toBe('docs/plan.md is already running here: plan · running · part A (1/2) implementing.')
  expect((await $.command.run(typed('go docs/other.md'))).text).toContain('Plan plan (docs/plan.md) is active in this repo, and foreman runs one plan at a time')
  expect(w.launches.length).toBe(1)
  expect(w.asked.length).toBe(1)
})

test('a pause written in the plan: part A ready does not start B; /foreman resume does', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': PAUSED_PLAN } })
  await $.command.run(typed('go docs/plan.md'))
  expect(w.asked[0]).toContain('• B · Part B (no acceptance criteria found) · the plan pauses before it')
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: OK\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'paused', current: 0, reason: 'the plan asks for a pause before part B; Next part (or /foreman resume plan) goes on' })
  expect(w.launches.length).toBe(1)
  await tick(w, $)
  expect(w.launches.length).toBe(1)
  expect((await $.command.run(typed('resume'))).text).toContain('Resumed plan')
  await tick(w, $)
  expect(w.launches.length).toBe(2)
  expect(plansOf(w)[0]).toMatchObject({ status: 'running', current: 1 })
})

test('the last part ready: the plan is done, said once', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': '# Fix login\n\nThe button does nothing.\n' } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'fixed', 'm1')
  await tick(w, $)
  w.files[`${RUN}\\review-1-r1.md`] = 'Verdict: OK\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'done', current: 0 })
  expect(w.toasts.filter(t => t === 'plan: the plan is done, all 1 part(s) ready').length).toBe(1)
  await tick(w, $)
  expect(w.toasts.filter(t => t === 'plan: the plan is done, all 1 part(s) ready').length).toBe(1)
  // a finished plan lets a new one start, under a fresh slug (A-16)
  expect((await $.command.run(typed('go docs/plan.md'))).text).toContain('Plan plan-2 started')
})

test('NO on the last round: waiting, "rounds used up"; no further review, no resume', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ limits: { reviewRounds: 1 } }) } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'try', 'm1')
  await tick(w, $)
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: NO\n### C-01 · P1 · a:1 · x\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
  expect(cyclesOf(w)[0]?.reason).toContain('review rounds used up (1 of 1)')
  await tick(w, $)
  expect(w.spawns.length).toBe(1)
  expect(w.resumes.length).toBe(0)
  expect(w.launches.length).toBe(1)
})

test('a question from the implementer: waiting, never answered by foreman; the person\'s tell sets it going', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'which file?', 'm1', 'question')
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'thread' })
  await tick(w, $)
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  expect(w.spawns.length).toBe(0)
  await $.command.run(typed('tell 1 "src/sum.js"'))
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
})

test('BLOCKED from the reviewer: waiting on the person', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  w.files[`${RUN}\\review-A-r1.md`] = 'Verdict: BLOCKED\nNo diff.\n'
  await $.turn.complete(complete('agent1', ''))
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: `the reviewer is blocked (${RUN}\\review-A-r1.md)` })
})

test('a usage limit: limit, the reset is kept in the store, and the thread is told to go on after it', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  const t = w.clock.now()
  const resetsAt = Math.floor((t + 3_600_000) / 1000)
  w.files[TPATH] = [
    row({ type: 'user', timestamp: iso(t + 100), message: { role: 'user', content: 'TASK' } }),
    row({ type: 'assistant', timestamp: iso(t + 500), isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { resetsAt }, message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 4am" }] } }),
  ].join('\n')
  w.agent = { pid: 7, status: 'idle', state: 'done' }
  await tick(w, $)
  expect(threadsOf(w)[0]).toMatchObject({ state: 'limit', retryAt: iso(resetsAt * 1000 + 60_000) })
  expect(cyclesOf(w)[0]?.phase).toBe('limit')
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  await w.clock.set(resetsAt * 1000 + 61_000)
  await $.command.run(typed('status'))
  expect(w.resumes.length).toBe(1)
  expect(w.resumes[0]?.at(-1)).toContain('The usage limit has reset')
  expect(threadsOf(w)[0]?.state).toBe('working')
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
})

test('one owner: a part another live session drives is left alone; an orphan is claimed, then driven, its review not started twice', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  // another chat sees it while the owner is alive
  w.me = 'sess-other'
  w.sessions = [{ sessionId: 'sess-me', pid: 1 }, { sessionId: 'sess-other', pid: 2 }]
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', owner: 'sess-me' })
  expect(w.spawns.length).toBe(0)
  // the owner closes: first look claims, the next one acts
  w.sessions = [{ sessionId: 'sess-other', pid: 2 }]
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'implementing', owner: 'sess-other' })
  expect(plansOf(w)[0]?.owner).toBe('sess-other')
  expect(w.spawns.length).toBe(0)
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('reviewing')
  expect(w.spawns.length).toBe(1)
  await tick(w, $)
  await tick(w, $)
  expect(w.spawns.length).toBe(1)
  const moves = (runDoc(w).transitions as { thread: string; note?: string }[]).filter(t => t.thread === 'cycle:A' && t.note?.startsWith('adopted'))
  expect(moves.length).toBe(1)
})

test('an adoption finds the review the previous owner already started and binds it instead of starting another', async ($, on) => {
  const requested = iso(NOW_MS - 10_000)
  const file = 'C:\\demo\\.git\\foreman\\c1\\review-A-r1.md'
  const cycle: ForemanCycle = { id: 'c1:A', runId: 'c1', part: 'A', plan: 'docs/plan.md', base: 'abc1234', implThread: 'aaaa0001', maxCycles: 2, rounds: [], phase: 'reviewing', phaseAt: requested, reviewRequestedAt: requested, owner: 'gone-session', startedAt: requested, updatedAt: requested }
  const started = { kind: 'review', runId: 'c1', part: 'A', n: 1, file, agentId: 'agent-prev', owner: 'gone-session', startedAt: iso(NOW_MS - 5_000), verdict: 'none', findings: 0, base: 'abc1234' }
  const w = world(on, { store: { 'v2:cycles:c:/demo': [cycle], 'v2:reviews:c:/demo': [started] } })
  await tick(w, $) // claim
  await tick(w, $) // drive: bind, not spawn
  expect(w.spawns.length).toBe(0)
  expect(cyclesOf(w)[0]?.rounds).toEqual([{ n: 1, file, agentId: 'agent-prev', verdict: 'none', findings: 0 }])
})

test('an adoption finds the resume the previous owner already sent and does not send it again', async ($, on) => {
  const at = iso(NOW_MS - 10_000)
  const cycle: ForemanCycle = { id: 'c1:A', runId: 'c1', part: 'A', plan: 'docs/plan.md', base: 'abc1234', implThread: 'aaaa0001', maxCycles: 2, rounds: [{ n: 1, file: 'C:\\demo\\.git\\foreman\\c1\\review-A-r1.md', agentId: 'a1', verdict: 'NO', findings: 1 }], phase: 'applying', applyFor: 1, phaseAt: at, owner: 'gone', startedAt: at, updatedAt: at }
  const thread: ForemanThread = { id: 'aaaa0001', sessionId: 'aaaa0001-s', name: 'foreman:c1:implementer-A', role: 'implementer', cwd: 'C:\\demo', model: 'sonnet', effort: 'high', startedAt: at, updatedAt: iso(NOW_MS - 5_000), sentAt: iso(NOW_MS - 5_000), state: 'working', owner: 'gone' }
  const w = world(on, { store: { 'v2:cycles:c:/demo': [cycle], 'v2:threads:c:/demo': [thread] } })
  w.launched = true
  await tick(w, $)
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
})

test('the 0.1 commands answer with what replaces them', async ($, on) => {
  world(on)
  expect((await $.command.run(typed('cycle docs/plan.md --part A'))).text).toContain('/foreman cycle is now /foreman go <plan.md>')
  expect((await $.command.run(typed('night on'))).text).toContain('Night mode is gone in 0.2')
  expect((await $.command.run(typed('go docs/plan.md --level N1'))).text).toBe('--level is gone in 0.2: pass --model (opus, sonnet, haiku, fable).')
})

test('a reload keeps the plan: a new session start restores it and the watcher goes on', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  // the session restarts (state gone: the store holds the plan and the part)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await w.clock.advance(30_000)
  await w.clock.settle()
  expect(cyclesOf(w)[0]?.phase).toBe('reviewing')
  expect(w.spawns.length).toBe(1)
})

test('C-13: a repo profile cannot set the commands foreman runs on its own; the plugin settings can', { options: { claudeExe: 'C:/tools/claude.exe' } }, async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ claudeExe: 'tools/evil.cmd', notify: { command: 'evil.cmd' } }) } })
  const prof = (await $.command.run(typed('profile'))).text ?? ''
  expect(prof).toContain('claudeExe: runs a command without anyone typing, so it is set in the plugin settings')
  expect(prof).toContain('notify.command: runs a command without anyone typing')
  await $.command.run(typed('go docs/plan.md'))
  expect(w.launches[0]?.[0]).toBe('C:/tools/claude.exe')
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'which?', 'm1', 'question')
  await tick(w, $)
  expect(w.notified.length).toBe(0)
  expect(w.all.some(a => a[0] === 'evil.cmd' || a[0] === 'tools/evil.cmd')).toBe(false)
})
