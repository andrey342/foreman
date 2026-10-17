import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { detect } from './lib/detect'
import { parsePlan } from './lib/plan'
import { defaultProfile, parseProfile } from './lib/profile'
import { PLAN_TEMPLATE, deliveryQuestion, isolationQuestion, profileChanges, proposedChoices, setupProfile } from './lib/setup'

const NOW_MS = Date.parse('2026-10-17T09:00:00.000Z')
const K = (p: string) => p.split('/').join('\\')
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const PROFILE = 'C:\\demo\\.claude\\foreman.json'
const TEMPLATE = 'C:\\demo\\docs\\plans\\TEMPLATE.md'
const EXE = 'C:\\tools\\claude.exe'

/** foreman-lab's rules: branches by prefix, a pull request for each, a Node repo with a lockfile. */
const LAB = {
  'C:\\demo\\CLAUDE.md': '# demo\n\n## Rules\n\n- One branch per task, named `fix/<slug>` or `feat/<slug>`, created from `main`.\n- Open a pull request against `main` for each branch.\n',
  'C:\\demo\\package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
  'C:\\demo\\package-lock.json': '{}',
}

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  /** The labels the person picks, in order; `deny`: no dialog in this session (a -p run). */
  answers: string[]
  asked: { question: string; options: string[] }[]
  ran: string[][]
  /** What `<exe> --version` answers. */
  version: { exitCode: number; stdout: string }
  /** The session's root: the repo, or one of its worktrees. */
  root: string
}

/** A repo at C:\demo with the files given, and nothing else: the dialog answers from `answers`. */
function world(on: On, files: Record<string, string> = {}): World {
  const w: World = { files: { ...files }, store: {}, answers: [], asked: [], ran: [], version: { exitCode: 0, stdout: '2.1.296 (Claude Code)\n' }, root: 'C:\\demo' }
  mock.clock(on, { now: NOW_MS })
  const dirOf = (p: string) => K(p).replace(/\\+$/, '')
  const isDir = (p: string) => dirOf(p).toLowerCase() === 'c:\\demo' || Object.keys(w.files).some(f => f.startsWith(dirOf(p) + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: w.root }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('command.list', () => ({ value: [] }))
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\home' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.exists', ($, e) => ({ value: dirOf(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = dirOf(e.path)
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: 0, isLink: false } }
    if (isDir(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', ($, e) => {
    const dir = dirOf(e.path)
    const names = Object.keys(w.files).filter(f => f.startsWith(dir + '\\')).map(f => f.slice(dir.length + 1).split('\\')[0] as string)
    return { value: [...new Set(names)].map(name => ({ name, kind: `${dir}\\${name}` in w.files ? 'file' : 'dir', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => (K(e.path) in w.files ? { value: w.files[K(e.path)] as string } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    const a = [...e.argv]
    w.ran.push(a)
    if (a[1] === '--version') return { value: { exitCode: w.version.exitCode, stdout: w.version.stdout, stderr: w.version.exitCode ? 'not a claude' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[1] === 'agents') return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected ${a.join(' ')}`, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // $.ui.ask is a tool.call of AskUserQuestion: answered with the next label the person picks
  on('tool.call', ($, e) => {
    if (String(e.tool) !== 'AskUserQuestion') return { result: 'ran' }
    const q = (e as unknown as { questions: { question: string; options?: { label: string }[] }[] }).questions[0]
    w.asked.push({ question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label) })
    const answer = w.answers.shift()
    if (answer === undefined || answer === 'deny') return { deny: 'no one to ask in a -p run' }
    return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q?.question ?? '']: answer } } } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  return w
}

const said = async ($: { command: { run: (i: ReturnType<typeof typed>) => Promise<{ text?: string }> } }, args: string) => (await $.command.run(typed(args))).text ?? ''
const repo = (root: string[], texts: Record<string, string> = {}) => detect({ root, claude: [], texts })

// ---------------------------------------------------------------- the pure part: questions, choices, the file

test('the questions: delivery only when the rules ask for pull requests and nothing else decides it; isolation only with submodules or compose files', () => {
  const p = defaultProfile()
  expect(deliveryQuestion(repo([]), p)).toBe(undefined)
  const lab = repo(['CLAUDE.md'], { 'CLAUDE.md': 'Open a pull request for each branch.' })
  expect(deliveryQuestion(lab, p)?.answers.map(a => a.value)).toEqual(['pr', 'branch', 'merge'])
  expect(deliveryQuestion(lab, p)?.text).toContain('CLAUDE.md: "pull request"')
  // a person approves before anything is published: no question, the branch stays
  expect(deliveryQuestion(repo(['CLAUDE.md'], { 'CLAUDE.md': 'Open a pull request. Ask before you push.' }), p)).toBe(undefined)
  // the profile already says it
  expect(deliveryQuestion(lab, { ...p, delivery: { ...p.delivery, mode: 'pr' } })).toBe(undefined)
  expect(isolationQuestion(repo(['.gitmodules']), p)?.answers.map(a => a.value)).toEqual(['branch', 'worktree', 'none'])
  expect(isolationQuestion(repo(['docker-compose.yml']), p)?.text).toContain('compose files')
  expect(isolationQuestion(repo([]), p)).toBe(undefined)
  expect(isolationQuestion(repo(['.gitmodules']), { ...p, isolation: 'none' })).toBe(undefined)
})

test('the choices before any answer: what the rules and the layout make safe', () => {
  const p = defaultProfile()
  expect(proposedChoices(repo([]), p)).toEqual({ delivery: 'branch', isolation: 'worktree' })
  expect(proposedChoices(repo(['CLAUDE.md', '.gitmodules'], { 'CLAUDE.md': 'gh pr create for each.' }), p)).toEqual({ delivery: 'pr', isolation: 'branch' })
})

test('what a write changes, by content: one line a key, with what it was (review S-1, S-2)', () => {
  expect(profileChanges(undefined, { version: 2, delivery: { mode: 'pr' } })).toEqual(['delivery.mode: pr, was branch'])
  expect(profileChanges({ notify: { toast: false } }, { version: 2, notify: { toast: false }, isolation: 'none' })).toEqual(['isolation: none, was worktree'])
  // order, version and mode "auto" are no change; another mode is one
  expect(profileChanges({ isolation: 'branch', delivery: { mode: 'pr' } }, { version: 2, delivery: { mode: 'pr' }, isolation: 'branch' })).toEqual([])
  expect(profileChanges({ mode: 'auto', delivery: { mode: 'pr' } }, { version: 2, delivery: { mode: 'pr' } })).toEqual([])
  expect(profileChanges({ mode: 'review', delivery: { mode: 'pr' } }, { version: 2, delivery: { mode: 'pr' } })).toEqual(['mode: removed, was review'])
  expect(profileChanges({ delivery: { mode: 'pr' } }, { version: 2 })).toEqual(['delivery.mode: branch (the default), was pr'])
})

test('the file setup writes: the defaults left out, the file\'s own keys kept, mode dropped, nothing when nothing differs', () => {
  expect(setupProfile(undefined, { delivery: 'branch', isolation: 'worktree' })).toBe(undefined)
  expect(setupProfile(undefined, { delivery: 'pr', isolation: 'worktree' })).toEqual({ version: 2, delivery: { mode: 'pr' } })
  expect(setupProfile({ mode: 'auto', notify: { toast: false } }, { delivery: 'branch', isolation: 'none' })).toEqual({ version: 2, notify: { toast: false }, isolation: 'none' })
  expect(setupProfile({ version: 2, delivery: { mode: 'pr', handoffToApp: true } }, { delivery: 'branch', isolation: 'worktree' })).toEqual({ version: 2, delivery: { handoffToApp: true } })
  expect(setupProfile({ version: 2, mode: 'auto' }, { delivery: 'branch', isolation: 'worktree' })).toBe(undefined)
  // what it writes parses clean
  expect(parseProfile(JSON.stringify(setupProfile({ notify: { toast: false } }, { delivery: 'merge', isolation: 'branch' }))).warnings).toEqual([])
})

test('the plan template reads as three parts with their criteria, and a pause before part C (D-76)', () => {
  const plan = parsePlan(PLAN_TEMPLATE, 'TEMPLATE')
  expect(plan.how).toBe('headings')
  expect(plan.parts.map(p => [p.id, p.pauseBefore])).toEqual([['A', false], ['B', false], ['C', true]])
  expect(plan.parts[0]?.criteria.length).toBe(2)
})

// ---------------------------------------------------------------- /foreman setup

test('setup in a repo with nothing to settle: one question, the template; no profile', async ($, on) => {
  const w = world(on)
  w.answers = ['Add the template']
  const out = await said($, 'setup')
  expect(w.asked.map(q => q.question)).toEqual(['Nothing here differs from foreman\'s defaults, so no profile is needed. Add docs/plans/TEMPLATE.md, a plan template?'])
  expect(out).toContain('No .claude/foreman.json: foreman runs on its defaults here.')
  expect(out).toContain('Added docs/plans/TEMPLATE.md')
  expect(w.files[TEMPLATE]).toBe(PLAN_TEMPLATE)
  expect(PROFILE in w.files).toBe(false)
  // run again: the template is there, nothing differs: no question at all
  w.asked = []
  expect(await said($, 'setup')).toContain('Nothing to write: the defaults fit this repo.')
  expect(w.asked.length).toBe(0)
})

test('setup in a repo like foreman-lab: what it finds, the pull request question, then one to write both', async ($, on) => {
  const w = world(on, LAB)
  w.answers = ['Open a pull request', 'Write both']
  const out = await said($, 'setup')
  expect(out).toContain('- Stack: node.')
  expect(out).toContain('- Gates: `npm test`.')
  expect(out).toContain('- Install in a fresh worktree: `npm ci`.')
  expect(out).toContain('- The repo\'s own rules: CLAUDE.md.')
  expect(out).toContain('- Where a plan works: its own worktree, under .claude/worktrees/; branch `fix/plan-slug` (the rules name `fix/`, `feat/`).')
  expect(w.asked.map(q => q.options)).toEqual([['Open a pull request', 'Leave the branch', 'Merge it here'], ['Write both', 'Only the profile', 'Neither']])
  expect(w.asked[1]?.question).toBe('Write .claude/foreman.json: delivery.mode: pr, was branch? And add docs/plans/TEMPLATE.md, a plan template?')
  expect(JSON.parse(w.files[PROFILE] ?? '{}')).toEqual({ version: 2, delivery: { mode: 'pr' } })
  expect(w.files[TEMPLATE]).toBe(PLAN_TEMPLATE)
  expect(out).toContain('Wrote .claude/foreman.json: delivery.mode: pr, was branch.')
  // the profile in effect now says it
  expect(await said($, 'setup --show')).toContain('"mode": "pr"')
})

test('setup with submodules and a pull request rule: three questions at most, each answer where it belongs', async ($, on) => {
  const w = world(on, { ...LAB, 'C:\\demo\\.gitmodules': '[submodule "lib"]\n', [TEMPLATE]: '# mine\n' })
  w.answers = ['Merge it here', 'In this checkout as it is', 'Write it']
  const out = await said($, 'setup')
  expect(w.asked.length).toBe(3)
  expect(w.asked[1]?.question).toBe('This repo has submodules, which a fresh worktree would lack. Where should a plan work?')
  // the repo has a template already: the last question only asks about the profile
  expect(w.asked[2]?.options).toEqual(['Write it', 'Do not write'])
  expect(JSON.parse(w.files[PROFILE] ?? '{}')).toEqual({ version: 2, delivery: { mode: 'merge' }, isolation: 'none' })
  // the template the repo has is its own
  expect(w.files[TEMPLATE]).toBe('# mine\n')
  expect(out).toContain('Wrote .claude/foreman.json: delivery.mode: merge, was branch; isolation: none, was worktree.')
})

test('setup keeps the keys a profile already has, names only what it changes, and writes nothing on Neither (review S-1)', async ($, on) => {
  const RULE = 'Every function the diff adds has a JSDoc block above it; report each one that does not as a finding.'
  const file = `// the team's\n{ "mode": "auto", "notify": { "toast": false }, "roles": { "reviewer": { "extra": "${RULE}" } } }\n`
  const w = world(on, { ...LAB, [PROFILE]: file })
  w.answers = ['Open a pull request', 'Neither']
  expect(await said($, 'setup')).toContain('Nothing written.')
  // the reviewer's long rule stays out of the dialog: only what changes is named
  expect(w.asked[1]?.question).toBe('Change .claude/foreman.json: delivery.mode: pr, was branch? And add docs/plans/TEMPLATE.md, a plan template? The file\'s other keys stay as they are, and its comments go.')
  expect(w.files[PROFILE]).toBe(file)
  w.answers = ['Open a pull request', 'Only the profile']
  await said($, 'setup')
  expect(JSON.parse(w.files[PROFILE] ?? '{}')).toEqual({ version: 2, notify: { toast: false }, roles: { reviewer: { extra: RULE } }, delivery: { mode: 'pr' } })
  expect(TEMPLATE in w.files).toBe(false)
})

test('a profile that says what setup would write, in another order or with no version, asks nothing about writing it (review S-2)', async ($, on) => {
  const w = world(on, { ...LAB, [TEMPLATE]: '# mine\n' })
  for (const file of ['{ "delivery": { "mode": "pr" } }', '{ "delivery": { "mode": "pr" }, "version": 2 }', '{ "mode": "auto", "version": 2, "delivery": { "mode": "pr" } }']) {
    w.files[PROFILE] = file
    w.asked = []
    expect(await said($, 'setup')).toContain('Nothing to write: .claude/foreman.json already says it.')
    expect(w.asked.length).toBe(0)
    expect(w.files[PROFILE]).toBe(file)
  }
})

test('setup in a plan\'s worktree refuses: the profile there is the main checkout\'s (review S-3); --show still says what holds', async ($, on) => {
  const TREE = 'C:\\demo\\.claude\\worktrees\\foreman-plan'
  const w = world(on, { [`${TREE}\\.git`]: 'gitdir: C:/demo/.git/worktrees/foreman-plan\n', [PROFILE]: '{ "delivery": { "mode": "pr" } }' })
  w.root = TREE
  w.store['plans:c:/demo'] = { v: 2, plans: [{ id: 'plan', plan: 'docs/plan.md', title: 'Plan', dir: 'C:\\demo\\.git\\foreman\\plan', parts: [{ id: '1', title: 'Plan' }], current: 0, status: 'running', owner: 'sess-me', startedAt: '2026-10-17T09:00:00.000Z', updatedAt: '2026-10-17T09:00:00.000Z', isolation: 'worktree', tree: TREE }] }
  expect(await said($, 'setup')).toBe('This is a plan\'s worktree: foreman reads the profile of the main checkout here. Run /foreman setup from the main checkout, C:\\demo.')
  expect(w.asked.length).toBe(0)
  expect(Object.keys(w.files).some(f => f.startsWith(`${TREE}\\.claude`) || f.startsWith(`${TREE}\\docs`))).toBe(false)
  const show = await said($, 'setup --show')
  expect(show).toContain('A plan\'s worktree: the profile in effect is the main checkout\'s')
  expect(show).toContain('"mode": "pr"')
})

test('setup with a profile that is not JSON says so and asks nothing', async ($, on) => {
  const w = world(on, { [PROFILE]: '{ "delivery": ' })
  expect(await said($, 'setup')).toContain('.claude/foreman.json is not valid JSON: fix it or remove it, then run /foreman setup again.')
  expect(w.asked.length).toBe(0)
})

test('setup with no dialog to ask in (a -p run): what it finds, and nothing written', async ($, on) => {
  const w = world(on, LAB)
  w.answers = ['deny']
  const out = await said($, 'setup')
  expect(out).toContain('Nothing written: there is no dialog here to ask you.')
  expect(PROFILE in w.files || TEMPLATE in w.files).toBe(false)
})

test('setup --show asks nothing and writes nothing; the foreman_setup tool answers the same', async ($, on) => {
  const w = world(on, LAB)
  const out = await said($, 'setup --show')
  expect(out).toContain('What foreman finds here:')
  expect(out).toContain('- Delivery: branch (the rules suggest pr: CLAUDE.md: "pull request").')
  expect(out).toContain('The profile in effect:')
  expect(w.asked.length).toBe(0)
  const tool = String(((await $.tool.call({ tool: 'mcp__foreman__setup', show: true } as never)) as { result?: unknown }).result)
  expect(tool).toContain('What foreman finds here:')
  expect(tool).toContain('The profile in effect:')
  expect(Object.keys(w.files).sort()).toEqual(Object.keys(LAB).sort())
})

// ---------------------------------------------------------------- the claude foreman runs (D-132)

test('setup --claude-exe: a path that answers --version is kept for every session; one that does not is refused', async ($, on) => {
  const w = world(on, { [EXE]: 'MZ', 'C:\\tools\\other.exe': 'MZ' })
  expect(await said($, 'setup --claude-exe C:\\tools\\nope.exe')).toBe('C:\\tools\\nope.exe: no such file. Give the full path to the claude executable.')
  w.version = { exitCode: 1, stdout: '' }
  expect(await said($, 'setup --claude-exe C:\\tools\\other.exe')).toContain('did not answer --version (exit 1): not a claude')
  expect(w.store.claudeExe).toBe(undefined)
  w.version = { exitCode: 0, stdout: '2.1.296 (Claude Code)\n' }
  expect(await said($, `setup --claude-exe ${EXE}`)).toBe(`foreman runs ${EXE} (2.1.296 (Claude Code)) from now on, in every session.`)
  expect(w.store.claudeExe).toBe(EXE)
  await said($, 'status')
  expect(w.ran.some(a => a[0] === EXE && a[1] === 'agents')).toBe(true)
  expect(await said($, 'setup --claude-exe')).toContain(`foreman runs ${EXE}.`)
  expect(await said($, 'setup --claude-exe ""')).toBe('claudeExe cleared: foreman runs `claude` from PATH.')
  expect(w.store.claudeExe).toBe('')
})

test('the claude set from the chat holds from the session start over the plugin setting', { options: { claudeExe: 'C:/plugin/claude.exe' } }, async ($, on) => {
  const w = world(on)
  w.store.claudeExe = EXE
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await said($, 'status')
  expect(w.ran.filter(a => a[1] === 'agents').map(a => a[0])).toContain(EXE)
  expect(w.ran.some(a => a[0] === 'C:/plugin/claude.exe')).toBe(false)
  expect(await said($, 'setup --claude-exe ""')).toBe('claudeExe cleared: foreman runs C:/plugin/claude.exe.')
})
