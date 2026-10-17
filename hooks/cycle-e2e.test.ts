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

/** The supervisor's prompt as the tests read it: every placeholder of prompts/supervisor.md (scripts/check-prompts.mjs checks the file itself). */
const SUPERVISOR_TEMPLATE = 'PLAN {{plan}} PART {{part}} {{partTitle}}\n{{partText}}\n{{criteria}}\n{{stop}}\n{{implementer}}\nREVIEW {{review}}\nDELIVERY {{delivery}}\n{{decidesAlone}}\n{{escalateAlways}}\n{{history}}\nLEFT {{runsLeft}}\n{{allowed}}'

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  agent: Record<string, unknown> | undefined
  launched: boolean
  launches: string[][]
  resumes: string[][]
  /** The reviewer processes started, with the brief each read on stdin. */
  spawns: { argv: string[]; prompt: string; cwd?: string; finish: (out: ReviewerOut) => void; finished: boolean; killed: boolean }[]
  sessions: { sessionId: string; pid?: number }[]
  me: string
  toasts: string[]
  logs: string[]
  notified: string[][]
  all: string[][]
  /** git and gh calls of a plan's tree and its delivery (D-71, D-72); `gitFails` makes one subcommand fail with that text. */
  git: string[][]
  gitFails?: Record<string, string>
  onBranch?: string
  ghSignedIn?: boolean
  /** The repo's origin remote (null: none); every process run with the folder it ran in; tracked changes in the checkout. */
  remote: string | null
  runs: { argv: string[]; cwd?: string }[]
  dirty?: boolean
  /** The worktree's install command fails with this text. */
  prepareFails?: string
  /** `gh pr create` says the pull request exists already, with this text. */
  ghPrExists?: string
  /** The session's own root (an app worktree), when it is not the main tree. */
  sessionRoot?: string
  copied: string[]
  /** What the person picks in the next dialog; `deny`: no dialog in this session (a -p run). */
  answer: string
  /** What the supervisor's `claude -p` prints as its result (D-68); its runs, with the brief it read on stdin. */
  supervisor: string
  supervised: { argv: string[]; stdin: string; cwd?: string; killed?: boolean }[]
  /** The supervisor's process runs until a Stop ends it. */
  supervisorHangs?: boolean
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
    sessions: [],
    me: 'sess-me',
    toasts: [],
    logs: [],
    notified: [],
    all: [],
    git: [],
    remote: null,
    runs: [],
    copied: [],
    answer: 'Run them',
    supervisor: 'I read the plan.\n{"decision":"escalate","reason":"the plan does not say","question":"Which one?"}',
    supervised: [],
    asked: [],
  }
  const isDir = (p: string) => ['c:\\demo', 'c:\\demo\\'].includes(K(p).toLowerCase()) || Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: w.remote, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: w.sessionRoot ?? 'C:\\demo' }))
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
    if (p.endsWith('\\prompts\\supervisor.md')) return { value: SUPERVISOR_TEMPLATE }
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
    w.runs.push({ argv: a, ...(e.init?.cwd ? { cwd: e.init.cwd } : {}) })
    if (a[0] === 'git' && a[1] === 'status') return { value: { exitCode: 0, stdout: w.dirty ? ' M src/sum.js\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[0] === 'cmd.exe') return w.prepareFails !== undefined ? { value: { exitCode: 1, stdout: '', stderr: w.prepareFails, isStdoutTruncated: false, isStderrTruncated: false } } : { value: { exitCode: 0, stdout: 'added 12 packages in 2s\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && a.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    // a merge that did not go clean leaves MERGE_HEAD; --abort takes the checkout back (H-1 of the Phase 4 review)
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('MERGE_HEAD')) return w.gitFails?.merge !== undefined && w.git.some(x => x[1] === 'merge' && x[2] === '--no-ff') ? ok('abc1234\n') : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[0] === 'git' && a[1] === 'merge' && a[2] === '--abort') { w.git.push(a); return ok('') }
    if (a[0] === 'gh' && a[1] === 'pr' && w.ghPrExists !== undefined) { w.git.push(a); return { value: { exitCode: 1, stdout: '', stderr: w.ghPrExists, isStdoutTruncated: false, isStderrTruncated: false } } }
    // a plan's tree (D-71): the checkout is on main, no branch of the plan's name exists yet, worktrees come and go
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === '--abbrev-ref' && a[3] === 'HEAD') return ok(`${w.onBranch ?? 'main'}\n`)
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2] === '--verify') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[0] === 'git' && (a[1] === 'worktree' || a[1] === 'switch' || a[1] === 'merge' || a[1] === 'push')) { w.git.push(a); return w.gitFails?.[a[1]] !== undefined ? { value: { exitCode: 1, stdout: '', stderr: w.gitFails[a[1]] as string, isStdoutTruncated: false, isStderrTruncated: false } } : ok('') }
    if (a[0] === 'gh') { w.git.push(a); return a[1] === 'auth' ? (w.ghSignedIn ? ok('Logged in to github.com') : { value: { exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.', isStdoutTruncated: false, isStderrTruncated: false } }) : ok('https://github.com/acme/demo/pull/7\n') }
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
  // the supervisor's `claude -p` (D-68), through spawn since a Stop must be able to end it (review F-1): it answers at once,
  // unless `supervisorHangs`; a closed stream is a killed process (`killed`)
  on('process.spawn', async function* ($, e, next) {
    const a = [...e.argv]
    if (a.some(x => x.includes(':supervisor-'))) {
      const entry: { argv: string[]; stdin: string; cwd?: string; killed?: boolean } = { argv: a, stdin: e.input ?? '', ...(e.cwd ? { cwd: e.cwd } : {}) }
      w.supervised.push(entry)
      if (w.supervisorHangs) {
        await new Promise<void>(resolve => next.signal.addEventListener('abort', () => { entry.killed = true; resolve() }))
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: w.supervisor, num_turns: 2, duration_ms: 5000, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } }) }
      return { value: { code: 0, signal: null } }
    }
    // the reviewer's `claude -p` (D-73): it runs until the test answers for it (reviewSays), or a Stop ends it
    let finish: (out: ReviewerOut) => void = () => undefined
    const answered = new Promise<ReviewerOut>(resolve => { finish = resolve })
    const spawned = { argv: a, prompt: e.input ?? '', ...(e.cwd ? { cwd: e.cwd } : {}), finish, finished: false, killed: false }
    w.spawns.push(spawned)
    next.signal.addEventListener('abort', () => { spawned.killed = true; finish({ stdout: '', code: -1 }) })
    const out = await answered
    const stdout = 'result' in out ? processJson(out.result) : out.stdout
    if (stdout) yield { stream: 'stdout' as const, text: stdout }
    return { value: { code: 'result' in out ? 0 : out.code, signal: null } }
  })
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
  expect(w.asked[0]).toContain('Run 2 part(s) of docs/plan.md in order?')
  expect(w.asked[0]).toContain('• A · Part A (1 criteria)')
  expect(out).toContain('Plan plan started: 2 part(s), in order:')
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
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'reviewing', rounds: [{ n: 1, agentId: 'process:foreman:plan:reviewer-A:r1', verdict: 'none' }] })
  // the reviewer is a read-only process (D-73): dontAsk, the brief on stdin, its thread-mode name
  expect(w.spawns[0]?.argv.slice(1, 6)).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'])
  expect(w.spawns[0]?.argv.join(' ')).toContain('"FOREMAN_THREAD":"foreman:plan:reviewer-A"')
  expect(w.spawns[0]?.prompt).toContain(`REVIEW ${RUN}\\review-A-r1.md BASE abc1234def5678 PREV none: this is the first review of the part`)

  // the reviewer answers NO; foreman writes its file
  await reviewSays(w, 'Verdict: NO\n\n### C-01 · P2 · src/sum.js:1 · missing JSDoc\nSECRET-REVIEW-BODY\n')
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
  await reviewSays(w, 'Verdict: OK\n\nC-01 fixed.\n')
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
  expect(status).toContain('- plan · running · branch foreman/plan · part B (2/2) implementing')
  expect(status).toContain('- Part A of plan: ready · r1 NO, r2 OK · max 3')
  // progress.md says it (D-70)
  expect(w.files[`${RUN}\\progress.md`]).toContain('## Part A · Part A\n\n- State: ready')
  expect(w.files[`${RUN}\\progress.md`]).toContain('## Part B · Part B\n\n- State: implementing')
})

test('go writes everything under .git/foreman/<slug>/ and nothing in the work tree (Phase 1 criterion 2, kit level)', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  const written = Object.keys(w.files).filter(f => f !== 'C:\\demo\\docs\\plan.md')
  // and one line in .git/info/exclude, so the person's git status never lists foreman's worktrees (D-71)
  expect(written.sort()).toEqual([`${RUN}\\brief-A.md`, `${RUN}\\foreman.json`, `${RUN}\\progress.md`, 'C:\\demo\\.git\\info\\exclude'])
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
  expect((await $.command.run(typed('go docs/plan.md'))).text).toBe('docs/plan.md is already running here: plan · running · branch foreman/plan · part A (1/2) implementing.')
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
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'paused', current: 0, reason: 'the plan asks you to check before part B; Continue (or /foreman resume plan) goes on' })
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
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'done', current: 0 })
  expect(w.toasts.filter(t => t === 'plan: the plan is done, all 1 part(s) ready').length).toBe(1)
  await tick(w, $)
  expect(w.toasts.filter(t => t === 'plan: the plan is done, all 1 part(s) ready').length).toBe(1)
  // a finished plan lets a new one start, under a fresh slug (A-16)
  expect((await $.command.run(typed('go docs/plan.md'))).text).toContain('Plan plan-2 started')
})

test('NO on the last round: the supervisor (replan or escalate only); it escalates: waiting; no further review, no resume', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ limits: { reviewRounds: 1 } }) } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'try', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: NO\n### C-01 · P1 · a:1 · x\n')
  await tick(w, $)
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: 'the supervisor escalates: the plan does not say: Which one?' })
  expect(w.supervised.length).toBe(1)
  expect(w.supervised[0]?.stdin).toContain('The last review round said NO (review round 1).')
  expect(w.supervised[0]?.stdin).toContain('`{"decision":"replan","text":"…","reason":"…"}`')
  expect(w.supervised[0]?.stdin.includes('{"decision":"answer"')).toBe(false)
  await tick(w, $)
  expect(w.spawns.length).toBe(1)
  expect(w.resumes.length).toBe(0)
  expect(w.launches.length).toBe(1)
})

test('a question from the implementer: the supervisor; when it escalates, the person\'s tell sets it going', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'which file?', 'm1', 'question')
  await tick(w, $)
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: 'the supervisor escalates: the plan does not say: Which one?' })
  expect(w.supervised.length).toBe(1)
  await tick(w, $)
  await tick(w, $)
  expect(w.resumes.length).toBe(0)
  expect(w.spawns.length).toBe(0)
  expect(w.supervised.length).toBe(1)
  await $.command.run(typed('tell 1 "src/sum.js"'))
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('implementing')
})

test('BLOCKED from the reviewer: the supervisor; it escalates: waiting on the person', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: BLOCKED\nNo diff.\n')
  await tick(w, $)
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', reason: 'the supervisor escalates: the plan does not say: Which one?' })
  expect(w.supervised[0]?.stdin).toContain('The reviewer was blocked (review round 1).')
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

// ---------------------------------------------------------------- the live round of Phase 3: a Stop while a process runs (F-1, F-2)

test('F-1 (live round): Stop during a review ends the reviewer; its round has no verdict, never an OK, and nothing is written as its answer', async ($, on) => {
  const w = world(on, { files: profile({ isolation: 'none' }) })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  await w.clock.settle()
  expect(cyclesOf(w)[0]?.phase).toBe('reviewing')
  expect(w.spawns.length).toBe(1)
  expect((await $.command.run(typed('stop plan'))).text).toContain('Stopped plan')
  await w.clock.settle()
  expect(w.spawns[0]?.killed).toBe(true)
  expect(runDoc(w).reviews[0]).toMatchObject({ part: 'A', n: 1, verdict: 'none', noResult: true, reason: 'cut: the plan was stopped while the reviewer ran' })
  expect(w.files[`${RUN}\\review-A-r1.md`]).toBe(undefined)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'closed', rounds: [{ n: 1, verdict: 'none' }] })
  expect(runDoc(w).transitions.some((t: { note?: string }) => t.note === 'the Stop cut the reviewer')).toBe(true)
  // later looks start no other review
  await tick(w, $)
  expect(w.spawns.length).toBe(1)
})

test('F-1 (live round): Stop while the supervisor runs ends it; nothing it says is carried out, and decisions.jsonl says so', async ($, on) => {
  const w = world(on, { files: profile({ isolation: 'none' }) })
  w.supervisorHangs = true
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'which file?', 'm1', 'question')
  await tick(w, $)
  await w.clock.settle()
  expect(cyclesOf(w)[0]?.phase).toBe('supervising')
  expect(w.supervised.length).toBe(1)
  await $.command.run(typed('stop plan'))
  await w.clock.settle()
  expect(w.supervised[0]?.killed).toBe(true)
  const last = JSON.parse((w.files[`${RUN}\\decisions.jsonl`] ?? '').trim().split('\n').at(-1) ?? '{}')
  expect(last).toMatchObject({ part: 'A', by: 'code', reason: 'cut: the plan was stopped while the supervisor ran; nothing was carried out' })
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('closed')
  expect(w.resumes.length).toBe(0)
  expect(w.supervised.length).toBe(1)
  expect(runDoc(w).transitions.some((t: { note?: string }) => t.note === 'the Stop cut the supervisor')).toBe(true)
})

test('F-2 (live round): a thread the person stopped after its turn ended stays stopped; a turn they start later moves it again', async ($, on) => {
  const w = world(on, { files: profile({ isolation: 'none' }) })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  expect(threadsOf(w)[0]?.state).toBe('ready')
  await $.command.run(typed('stop plan'))
  await w.clock.settle()
  expect(threadsOf(w)[0]).toMatchObject({ state: 'stopped', heldBy: 'person' })
  // the next looks read the same finished turn: it was before the Stop
  await tick(w, $)
  await tick(w, $)
  expect(threadsOf(w)[0]?.state).toBe('stopped')
  expect(runDoc(w).transitions.filter((t: { thread: string; to: string }) => t.thread === 'aaaa0001' && t.to === 'ready').length).toBe(1)
  // the person talks to it in its own chat later: a new turn, read as usual
  await w.clock.advance(60_000)
  implementerTurn(w, 'one more thing', 'done again', 'm2')
  await tick(w, $)
  expect(threadsOf(w)[0]?.state).toBe('ready')
})

// ---------------------------------------------------------------- Phase 3 criteria 7 and 9: rounds and runs that count as none

const LEFT_AT = iso(NOW_MS - 10_000)
const reviewingCycle = (): ForemanCycle => ({ id: 'plan:A', runId: 'plan', part: 'A', plan: 'docs/plan.md', base: 'abc1234', implThread: 'aaaa0001', maxCycles: 3, rounds: [{ n: 1, file: `${RUN}\\review-A-r1.md`, agentId: 'process:foreman:plan:reviewer-A:r1', verdict: 'none', findings: 0 }], phase: 'reviewing', phaseAt: LEFT_AT, reviewRequestedAt: LEFT_AT, owner: 'sess-me', startedAt: LEFT_AT, updatedAt: LEFT_AT })
const leftReview = { kind: 'review', runId: 'plan', part: 'A', n: 1, file: `${RUN}\\review-A-r1.md`, agentId: 'process:foreman:plan:reviewer-A:r1', owner: 'sess-me', startedAt: LEFT_AT, verdict: 'none', findings: 0, base: 'abc1234', plan: 'docs/plan.md' }

test('criterion 9: a review left without a result by a reload is started once more by the session that starts; it counts as no round', async ($, on) => {
  const w = world(on, { store: { 'v2:cycles:c:/demo': [reviewingCycle()], 'v2:reviews:c:/demo': [leftReview] } })
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await tick(w, $)
  await tick(w, $)
  expect(w.spawns.length).toBe(1)
  expect(cyclesOf(w)[0]?.rounds).toEqual([expect.objectContaining({ n: 1, free: 'lost' }), expect.objectContaining({ n: 2 })])
  expect(runDoc(w).notices.some((n: { text: string }) => n.text === 'plan:A: review r1 was lost when foreman reloaded; it runs once more, as no round')).toBe(true)
  // the new round answers NO: round 1 of 3 for the count, so the implementer applies it
  await reviewSays(w, 'Verdict: NO\n### C-01 · P1 · src/sum.js:1 · x\n')
  await tick(w, $)
  expect(cyclesOf(w)[0]?.phase).toBe('applying')
})

test('criterion 7: a gate the reviewer\'s permissions refused is "could not run": no verdict, no round, the review runs once more', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ gates: { checks: ['npm test'] } }) } })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm1')
  await tick(w, $)
  const refused = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.19, result: 'Verdict: OK\n\nLooks fine.', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -15' } }] })
  await reviewSays(w, { stdout: refused, code: 0 })
  await tick(w, $)
  const reviews = (w.store['v2:reviews:c:/demo'] ?? []) as { verdict: string; couldNotRun?: string[]; reason?: string }[]
  expect(reviews[0]).toMatchObject({ verdict: 'none', couldNotRun: ['npm test'], reason: 'could not run `npm test`: the reviewer\'s permissions refused it' })
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'reviewing' })
  expect(cyclesOf(w)[0]?.rounds[0]).toMatchObject({ free: 'could-not-run' })
  expect(w.spawns.length).toBe(2)
  // the retry is told how to run the gates; its previous review is none (the free round was no review)
  expect(w.spawns[1]?.prompt).toContain('Run each gate exactly as written, one command per call, nothing joined to it and nothing after it.')
  expect(w.spawns[1]?.prompt.includes('review-A-r1.md')).toBe(false)
  // the second time: the person, by the code
  await reviewSays(w, { stdout: refused, code: 0 })
  await tick(w, $)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person' })
  expect(cyclesOf(w)[0]?.reason).toContain('the gates cannot run here: review r2 could not run `npm test`')
  expect(w.supervised.length).toBe(0)
})

const supervisingCycle = (attempts: number): ForemanCycle => ({ ...reviewingCycle(), rounds: [], phase: 'supervising', reviewRequestedAt: undefined, supervising: { kind: 'question', part: 'A', text: 'Which one?', at: LEFT_AT }, supervisorRuns: 1, supervisorAttempts: attempts })

test('criterion 9: a supervisor run left without an answer by a reload runs once more, uncounted; lost twice, the person decides', async ($, on) => {
  const w = world(on, { store: { 'v2:cycles:c:/demo': [supervisingCycle(1)] } })
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await tick(w, $)
  await tick(w, $)
  expect(w.supervised.length).toBe(1)
  // its answer counts once: runs 1 before the loss, 2 now; nothing is left of the lost start
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', supervisorRuns: 2 })
  expect(cyclesOf(w)[0]?.supervisorAttempts).toBe(undefined)
})

test('criterion 9: a supervisor run lost twice: no third start, the person decides, by the code', async ($, on) => {
  const w = world(on, { store: { 'v2:cycles:c:/demo': [supervisingCycle(2)] } })
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await tick(w, $)
  await tick(w, $)
  expect(w.supervised.length).toBe(0)
  expect(cyclesOf(w)[0]).toMatchObject({ phase: 'waiting', waitingOn: 'person', supervisorRuns: 1 })
  expect(cyclesOf(w)[0]?.reason).toContain('its run ended twice without an answer (foreman was reloaded while it ran)')
})

// ---------------------------------------------------------------- Phase 4: the plan's worktree, its install command, its delivery (D-71, D-72, M4)

const TREE = 'C:\\demo\\.claude\\worktrees\\foreman-plan'
/** foreman-lab's rules and a Node repo with a lockfile. */
const NODE_REPO = {
  'C:\\demo\\CLAUDE.md': '# demo\n\n## Rules\n\n- One branch per task, named `fix/<slug>` or `feat/<slug>`, created from `main`.\n',
  'C:\\demo\\package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  'C:\\demo\\package-lock.json': '{}',
}
const ONE_PART = '# Fix login\n\nThe button does nothing.\n'
const profile = (o: Record<string, unknown>) => ({ 'C:\\demo\\.claude\\foreman.json': JSON.stringify(o) })

/** A plan of one part, implemented and reviewed OK: the plan is done, and its delivery runs. */
async function finishOnePart(w: World, $: Parameters<typeof tick>[1]) {
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'fixed', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  await tick(w, $)
}

test('Phase 4 criterion 1 (kit): go makes the plan\'s worktree on the branch the rules ask for, runs npm ci there first, then part A works there, told its branch', async ($, on) => {
  const w = world(on, { files: { ...NODE_REPO } })
  const out = (await $.command.run(typed('go docs/plan.md'))).text ?? ''
  // the dialog says where, on which branch, and the install command: no press of its own
  expect(w.asked[0]).toContain('In its own worktree, `.claude/worktrees/foreman-plan`, on the new branch `fix/plan` from `main`; first `npm ci` runs there (up to 10 minutes).')
  expect(w.asked[0]).toContain('When it is done: the branch `fix/plan` stays as it is, with the report; nothing is published.')
  expect(w.git[0]).toEqual(['git', 'worktree', 'add', '-b', 'fix/plan', TREE, 'HEAD'])
  expect(w.runs.find(r => r.argv[1] === 'worktree')?.cwd).toBe('C:\\demo')
  expect(w.files['C:\\demo\\.git\\info\\exclude']).toContain('/.claude/worktrees/')
  expect(out).toContain('Part A starts once `npm ci` is done in the worktree.')
  // npm ci, in the worktree, before any thread
  await w.clock.settle()
  const ci = w.runs.find(r => r.argv[0] === 'cmd.exe')
  expect(ci).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', 'npm ci'], cwd: TREE })
  expect(plansOf(w)[0]?.prepare).toMatchObject({ cmd: 'npm ci', state: 'done', exit: 0 })
  expect(runDoc(w).prepare).toMatchObject({ state: 'done', output: 'added 12 packages in 2s' })
  await tick(w, $)
  expect(w.launches.length).toBe(1)
  expect(w.runs.find(r => r.argv[1] === '--bg')?.cwd).toBe(TREE)
  expect(threadsOf(w)[0]?.cwd).toBe(TREE)
  expect(w.files[`${RUN}\\brief-A.md`]).toContain('## Where you work\n\nIn `C:\\demo\\.claude\\worktrees\\foreman-plan`, the worktree foreman made for this plan, on the branch `fix/plan`')
  // the part starts from the worktree's HEAD (the preflight read the checkout's)
  expect(w.runs.some(r => r.argv.join(' ') === 'git rev-parse HEAD' && r.cwd === TREE)).toBe(true)
})

test('a worktree whose npm ci fails: the plan stops with its last lines, and nothing is launched', async ($, on) => {
  const w = world(on, { files: { ...NODE_REPO } })
  w.prepareFails = 'npm ERR! code EUSAGE\nnpm ERR! The `npm ci` command can only install with an existing package-lock.json'
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.settle()
  await tick(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'stopped', prepare: { state: 'failed', exit: 1 } })
  expect(plansOf(w)[0]?.reason).toContain('the worktree\'s `npm ci` failed (exit 1): npm ERR! The `npm ci` command can only install')
  expect(w.launches.length).toBe(0)
})

test('Phase 4 criterion 2 (kit): the reviewer and the supervisor work in the plan\'s worktree', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'which file?', 'm1', 'question')
  await tick(w, $)
  await tick(w, $)
  expect(w.supervised[0]?.cwd).toBe(TREE)
  await $.command.run(typed('tell 1 "src/sum.js"'))
  w.agent = { pid: 7, status: 'busy', state: 'working' }
  await tick(w, $)
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'done', 'm2')
  await tick(w, $)
  await w.clock.settle()
  expect(w.spawns[0]?.cwd).toBe(TREE)
})

test('live round of Phase 4: a plan that ends is delivered at the watcher\'s next look, with no command to wake it', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART } })
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('go docs/plan.md'))
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'fixed', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await w.clock.settle()
  expect(plansOf(w)[0]?.status).toBe('done')
  // only the watcher from here: nothing open but the delivery, which must not wait for the idle listing (D-79)
  await w.clock.advance(30_000)
  await w.clock.advance(30_000)
  await w.clock.settle()
  expect(plansOf(w)[0]?.delivery).toMatchObject({ mode: 'branch', state: 'delivered' })
  expect(w.git.some(a => a[1] === 'worktree' && a[2] === 'remove')).toBe(true)
})

test('Phase 4 criterion 4 (kit): the default delivery leaves the branch: the worktree goes, report.md is written, nothing is published', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART } })
  await finishOnePart(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'done', branch: 'foreman/plan', delivery: { mode: 'branch', state: 'delivered', worktree: 'removed; the branch stays' } })
  expect(w.git.map(a => a.slice(0, 3).join(' '))).toEqual(['git worktree add', 'git worktree remove'])
  expect(w.git[1]).toEqual(['git', 'worktree', 'remove', TREE])
  const report = w.files[`${RUN}\\report.md`] ?? ''
  expect(report).toContain('# Fix login\n\nPlan `docs/plan.md` · 1 part(s) · branch `foreman/plan` from `main`.')
  expect(report).toContain('- Mode: branch')
  expect(w.logs.some(l => l.startsWith('plan: delivered, on branch `foreman/plan`'))).toBe(true)
  expect(runDoc(w).delivery).toMatchObject({ state: 'delivered' })
})

test('Phase 4 criterion 5 (kit): pr with a remote and gh signed in: push -u, gh pr create with the report as its body; the URL in the record and the chat; no merge', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART, ...profile({ delivery: { mode: 'pr' } }) } })
  w.remote = 'https://github.com/acme/demo.git'
  w.ghSignedIn = true
  await finishOnePart(w, $)
  expect(w.git.filter(a => a[0] === 'gh' || a[1] === 'push' || a[1] === 'merge')).toEqual([
    ['gh', 'auth', 'status'],
    ['git', 'push', '-u', 'origin', 'foreman/plan'],
    ['gh', 'pr', 'create', '--base', 'main', '--head', 'foreman/plan', '--title', 'Fix login', '--body-file', `${RUN}\\report.md`],
  ])
  expect(plansOf(w)[0]?.delivery).toMatchObject({ mode: 'pr', state: 'delivered', url: 'https://github.com/acme/demo/pull/7' })
  expect(w.logs.some(l => l.startsWith('plan: delivered, pull request https://github.com/acme/demo/pull/7'))).toBe(true)
})

test('Phase 4 criterion 7 (kit): gh not signed in, the delivery drops to branch and go says so; a push that fails leaves "Done, not delivered", and Retry delivery delivers', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART, ...profile({ delivery: { mode: 'pr' } }) } })
  w.remote = 'https://github.com/acme/demo.git'
  await $.command.run(typed('go docs/plan.md'))
  expect(w.asked[0]).toContain('(`gh` is missing or not signed in (`gh auth status`): the branch is left as it is, and no pull request is opened)')
  expect(plansOf(w)[0]?.delivery).toMatchObject({ mode: 'branch' })
})

test('Phase 4 criterion 7 (kit): a push that fails: Done, not delivered, in the pane with Retry delivery; Retry delivers', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART, ...profile({ delivery: { mode: 'pr' } }) } })
  w.remote = 'https://github.com/acme/demo.git'
  w.ghSignedIn = true
  w.gitFails = { push: 'fatal: unable to access https://github.com/acme/demo.git/: Could not resolve host' }
  await finishOnePart(w, $)
  expect(plansOf(w)[0]).toMatchObject({ status: 'done', delivery: { state: 'failed' } })
  expect(plansOf(w)[0]?.delivery?.reason).toContain('`git push -u` failed (exit 1): fatal: unable to access')
  expect(w.toasts.some(t => t.startsWith('plan: done, not delivered: `git push -u` failed'))).toBe(true)
  // the worktree stays until the plan is delivered
  expect(w.git.some(a => a[1] === 'worktree' && a[2] === 'remove')).toBe(false)
  w.gitFails = undefined
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: { title: 'foreman', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /^Done, not delivered: `git push -u` failed/ })).toBeDefined()
  await ui.press({ key: 'retry:plan' })
  await w.clock.settle()
  expect(plansOf(w)[0]?.delivery).toMatchObject({ state: 'delivered', url: 'https://github.com/acme/demo/pull/7' })
  expect(await ui.find({ type: 'Text', text: 'Pull request: https://github.com/acme/demo/pull/7' })).toBeDefined()
  expect(runDoc(w).presses.map((p: { element: string }) => p.element)).toContain('retry:plan')
  await ui.unmount()
})

test('Phase 4 criterion 6 (kit): merge: a checkout with changes not committed waits; clean and on main, git merge --no-ff and no push', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART, ...profile({ delivery: { mode: 'merge' } }) } })
  await $.command.run(typed('go docs/plan.md'))
  w.dirty = true
  await w.clock.advance(60_000)
  implementerTurn(w, 'TASK', 'fixed', 'm1')
  await tick(w, $)
  await reviewSays(w, 'Verdict: OK\n')
  await tick(w, $)
  await tick(w, $)
  expect(plansOf(w)[0]?.delivery).toMatchObject({ mode: 'merge', state: 'failed', reason: 'your checkout has changes not committed: the merge waits for a clean checkout (Retry delivery once it is)' })
  expect(w.git.some(a => a[1] === 'merge')).toBe(false)
  w.dirty = false
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: { title: 'foreman', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: 'The plan is done, but its delivery failed: your checkout has changes not committed: the merge waits for a clean checkout (Retry delivery once it is)' })).toBeDefined()
  await ui.press({ key: 'retry:plan' })
  await w.clock.settle()
  await ui.unmount()
  expect(w.git.filter(a => a[1] === 'merge' || a[1] === 'push')).toEqual([['git', 'merge', '--no-ff', 'foreman/plan']])
  expect(plansOf(w)[0]?.delivery).toMatchObject({ state: 'delivered' })
})

test('Phase 4 criterion 9 (kit): a repo with submodules: go proposes the plan\'s branch in the checkout, and makes no worktree', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\.gitmodules': '[submodule "lib"]\n\tpath = lib\n' } })
  await $.command.run(typed('go docs/plan.md'))
  expect(w.asked[0]).toContain('On the new branch `foreman/plan` in this checkout (this repo has submodules, which a fresh worktree would lack: the plan runs on its own branch in this checkout instead).')
  expect(w.git).toEqual([['git', 'switch', '-c', 'foreman/plan']])
  expect(plansOf(w)[0]).toMatchObject({ isolation: 'branch', tree: 'C:\\demo', branch: 'foreman/plan' })
  expect(w.runs.find(r => r.argv[1] === '--bg')?.cwd).toBe('C:\\demo')
})

test('a thread in a worktree whose committed settings do not enable foreman gets the plugin\'s folder (D-71)', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  expect(w.launches[0]?.includes('--plugin-dir')).toBe(true)
})

test('a thread in a worktree whose committed settings enable foreman loads it by itself: no plugin folder (D-71)', async ($, on) => {
  const w = world(on, { files: { [`${TREE}\\.claude\\settings.json`]: JSON.stringify({ enabledPlugins: { 'foreman@foreman': true } }) } })
  await $.command.run(typed('go docs/plan.md'))
  expect(w.launches[0]?.includes('--plugin-dir')).toBe(false)
})

// ---------------------------------------------------------------- Phase 4, review round 1: H-1, H-2, O-1, and what a stop keeps

test('H-1 (Phase 4 review): a merge that does not go clean is aborted: the checkout as it was, the branch and the worktree kept', async ($, on) => {
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART, ...profile({ delivery: { mode: 'merge' } }) } })
  w.gitFails = { merge: 'CONFLICT (content): Merge conflict in src/sum.js\nAutomatic merge failed; fix conflicts and then commit the result.' }
  await finishOnePart(w, $)
  expect(plansOf(w)[0]?.delivery).toMatchObject({ state: 'failed', reason: '`foreman/plan` does not merge cleanly into `main`: your checkout is as it was, and the branch stays' })
  expect(w.git.filter(a => a[1] === 'merge')).toEqual([['git', 'merge', '--no-ff', 'foreman/plan'], ['git', 'merge', '--abort']])
  expect(w.runs.find(r => r.argv.includes('MERGE_HEAD'))?.cwd).toBe('C:\\demo')
  expect(w.git.some(a => a[1] === 'worktree' && a[2] === 'remove')).toBe(false)
})

test('H-2 (Phase 4 review): a delivery a reload cut is "Done, not delivered", never published again by itself; Retry takes the pull request that exists', async ($, on) => {
  const at = iso(NOW_MS - 60_000)
  const cut: ForemanPlanRun = {
    id: 'plan', plan: 'docs/plan.md', title: 'Fix login', dir: RUN, parts: [{ id: '1', title: 'Fix login' }], current: 0, status: 'done', owner: 'sess-me', startedAt: at, updatedAt: at, finishedAt: at,
    isolation: 'worktree', tree: TREE, branch: 'foreman/plan', base: 'main', checkout: 'C:\\demo', delivery: { mode: 'pr', state: 'pending', at },
  }
  const w = world(on, { files: { 'C:\\demo\\docs\\plan.md': ONE_PART }, store: { 'plans:c:/demo': { v: 2, plans: [cut] } } })
  w.remote = 'https://github.com/acme/demo.git'
  w.ghSignedIn = true
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await tick(w, $)
  expect(plansOf(w)[0]?.delivery).toMatchObject({ state: 'failed', reason: 'foreman was reloaded during the delivery' })
  expect(w.toasts.some(t => t === 'plan: done, not delivered: foreman was reloaded during the delivery. Retry delivery is in the pane.')).toBe(true)
  await tick(w, $)
  expect(w.git).toEqual([])
  // the push had gone through and the pull request had been opened: gh says so, with its URL, and that one is the plan's
  w.ghPrExists = 'a pull request for branch "foreman/plan" into branch "main" already exists:\nhttps://github.com/acme/demo/pull/5'
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: { title: 'foreman', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await ui.press({ key: 'retry:plan' })
  await w.clock.settle()
  await ui.unmount()
  expect(plansOf(w)[0]?.delivery).toMatchObject({ state: 'delivered', url: 'https://github.com/acme/demo/pull/5' })
  expect(w.git.map(a => a.slice(0, 3).join(' '))).toEqual(['git push -u', 'gh pr create', 'git worktree remove'])
})

test('O-1 (Phase 4 review): a coordinator in an app worktree: the plan\'s worktree starts from its HEAD, and a merge lands in its checkout', async ($, on) => {
  const APP = 'C:\\demo\\.claude\\worktrees\\app-chat'
  const w = world(on, { files: { [`${APP}\\.git`]: 'gitdir: C:/demo/.git/worktrees/app-chat\n', [`${APP}\\docs\\plan.md`]: ONE_PART, [`${APP}\\.claude\\foreman.json`]: JSON.stringify({ delivery: { mode: 'merge' } }) } })
  w.sessionRoot = APP
  await finishOnePart(w, $)
  expect(w.runs.find(r => r.argv[1] === 'worktree' && r.argv[2] === 'add')?.cwd).toBe(APP)
  expect(plansOf(w)[0]).toMatchObject({ checkout: APP, delivery: { mode: 'merge', state: 'delivered' } })
  // the checks before the merge, and the merge, in the coordinator's checkout; the worktree's removal from the main tree
  const at = (cmd: string) => w.runs.filter(r => r.argv.join(' ') === cmd).map(r => r.cwd)
  expect(at('git status --porcelain --untracked-files=no')).toContain(APP)
  expect(at('git rev-parse --abbrev-ref HEAD')).toContain(APP)
  expect(at('git merge --no-ff foreman/plan')).toEqual([APP])
  expect(at(`git worktree remove ${TREE}`)).toEqual(['C:\\demo'])
})

test('a stopped plan keeps its branch and worktree, and says so in progress.md and the pane\'s Details', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('go docs/plan.md'))
  await $.command.run(typed('stop plan'))
  expect(w.files[`${RUN}\\progress.md`]).toContain(`Kept, with the work in them: the branch \`foreman/plan\` and foreman's worktree \`${TREE}\`. foreman never deletes them.`)
  expect(w.git.some(a => a[2] === 'remove')).toBe(false)
  const ui = await $.ui.mount({ plugin: 'foreman', surface: 'terminal', component: 'Pane', requestId: 'foreman', props: { title: 'foreman', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await ui.press({ key: 'details' })
  expect(await ui.find({ type: 'Text', text: `branch foreman/plan · worktree ${TREE} (kept)` })).toBeDefined()
  await ui.unmount()
})
