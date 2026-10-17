// The profile's guards (plan §8) and their scope (D-78), thread mode (D-51), the session section;
// onRunCreate is gone (A-13).
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Guard } from './lib/profile'
import { callOf, evaluateGuards, globRe, guardMatches, relPath, shellWrites } from './lib/guards'

const WORK = 'C:\\demo'
const G = (g: Partial<Guard> & { when: Guard['when'] }): Guard => ({ mode: 'warn', ...g })
const IMPACT = G({ when: { tool: 'Edit|Write|MultiEdit', pathGlob: '**/*.cs' }, requireToolCalledBefore: 'mcp__gitnexus__impact', mode: 'warn', reason: 'impact first' })
const ADD_A = G({ when: { tool: 'Bash|PowerShell', commandRegex: 'git\\s+add\\s+(?:-A|--all|\\.)(?:\\s|$)' }, mode: 'deny', reason: 'explicit paths' })
const TESTS = G({ when: { tool: 'Edit|Write', pathGlob: 'test.js' }, mode: 'deny', reason: 'the tests are the acceptance' })

describe('globs and paths', () => {
  test('** spans folders, * stays in one, case does not matter', async () => {
    expect(globRe('**/*.cs').test('src/Api/Foo.cs')).toBe(true)
    expect(globRe('**/*.cs').test('Foo.CS')).toBe(true)
    expect(globRe('*.cs').test('src/Foo.cs')).toBe(false)
    expect(globRe('docs/shared/**').test('docs/shared/business/08.md')).toBe(true)
    expect(globRe('src/?.js').test('src/a.js')).toBe(true)
    expect(globRe('a.b').test('axb')).toBe(false)
  })
  test('paths are read relative to the work root, with forward slashes', async () => {
    expect(relPath('C:\\demo\\src\\a.cs', WORK)).toBe('src/a.cs')
    expect(relPath('c:/DEMO/src/a.cs', WORK)).toBe('src/a.cs')
    expect(relPath('./src/a.cs', WORK)).toBe('src/a.cs')
    expect(relPath('D:\\other\\a.cs', WORK)).toBe('D:/other/a.cs')
  })
  test('the path and command come from the tool input', async () => {
    expect(callOf('Edit', { file_path: 'C:\\demo\\a.cs', old_string: 'x' })).toEqual({ tool: 'Edit', path: 'C:\\demo\\a.cs' })
    expect(callOf('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual({ tool: 'NotebookEdit', path: 'n.ipynb' })
    expect(callOf('Bash', { command: 'git add -A' })).toEqual({ tool: 'Bash', command: 'git add -A' })
  })
})

describe('evaluating guards (plan §8)', () => {
  test('requireToolCalledBefore, warn: a warning until the tool was called, then nothing', async () => {
    const call = callOf('Edit', { file_path: 'C:\\demo\\src\\Api\\Foo.cs' })
    expect(evaluateGuards([IMPACT], call, new Set(['Read']), WORK)).toEqual({ warns: ['impact first: call mcp__gitnexus__impact before Edit on src/Api/Foo.cs'] })
    expect(evaluateGuards([IMPACT], call, new Set(['mcp__gitnexus__impact']), WORK)).toEqual({ warns: [] })
    expect(evaluateGuards([IMPACT], callOf('Edit', { file_path: 'C:\\demo\\README.md' }), new Set(), WORK)).toEqual({ warns: [] })
  })
  test('requireToolCalledBefore, deny: refused until the tool was called', async () => {
    const g = { ...IMPACT, mode: 'deny' as const }
    const call = callOf('Write', { file_path: 'src/Foo.cs' })
    expect(evaluateGuards([g], call, new Set(), WORK).deny).toBe('impact first: call mcp__gitnexus__impact before Write on src/Foo.cs')
    expect(evaluateGuards([g], call, new Set(['mcp__gitnexus__impact']), WORK).deny).toBe(undefined)
  })
  test('commandRegex, deny: git add -A, --all and . are refused; explicit paths pass', async () => {
    for (const bad of ['git add -A', 'git add --all', 'cd x && git add . && git commit -m y', 'git add -A src']) {
      expect(evaluateGuards([ADD_A], callOf('Bash', { command: bad }), new Set(), WORK).deny).toContain('explicit paths')
    }
    for (const ok of ['git add src/a.js docs/b.md', 'git add -p', 'git status']) {
      expect(evaluateGuards([ADD_A], callOf('Bash', { command: ok }), new Set(), WORK).deny).toBe(undefined)
    }
    expect(evaluateGuards([ADD_A], callOf('PowerShell', { command: 'git add -A' }), new Set(), WORK).deny).toBeDefined()
  })
  test('P5-03: a profile\'s git add -A rule also holds behind -C <dir> (submodules)', async () => {
    const msg = G({ when: { tool: 'Bash|PowerShell', commandRegex: '\\bgit(?:\\s+-C\\s+\\S+)*\\s+add\\s+(?:-A|--all|\\.)(?:\\s|$)' }, mode: 'deny', reason: 'Rutas explícitas' })
    for (const bad of ['git add -A', 'git -C Backend add -A', 'git -C a -C b add --all', 'git -C x add .']) {
      expect(evaluateGuards([msg], callOf('Bash', { command: bad }), new Set(), WORK).deny).toBeDefined()
    }
    for (const ok of ['git -C Backend add src/A.cs', 'git -C x status', 'legit add -A']) {
      expect(evaluateGuards([msg], callOf('Bash', { command: ok }), new Set(), WORK).deny).toBe(undefined)
    }
  })
  test('pathGlob, deny: the path decides; another tool is not matched', async () => {
    expect(evaluateGuards([TESTS], callOf('Edit', { file_path: 'C:\\demo\\test.js' }), new Set(), WORK).deny).toContain('the tests are the acceptance')
    expect(evaluateGuards([TESTS], callOf('Read', { file_path: 'C:\\demo\\test.js' }), new Set(), WORK).deny).toBe(undefined)
    expect(evaluateGuards([TESTS], callOf('Edit', { file_path: 'C:\\demo\\src\\test.js' }), new Set(), WORK).deny).toBe(undefined)
  })
  test('a path guard on the file tools also holds for a shell command that writes the path (seen live: sed -i on test.js)', async () => {
    const live = "printf -- '- sumTo(n) is O(n)\\n' > docs/known-limitations.md\nsed -i \"s/^console.log('ok')/assert.strictEqual(sumTo(5), 15)\\nconsole.log('ok')/\" test.js && node test.js"
    expect(shellWrites(live)).toEqual(['docs/known-limitations.md', 's/^console.log(\'ok\')/assert.strictEqual(sumTo(5), 15)\\nconsole.log(\'ok\')/', 'test.js'])
    expect(evaluateGuards([TESTS], callOf('Bash', { command: live }), new Set(), WORK).deny).toContain('the tests are the acceptance')
    for (const bad of ['echo x >> test.js', 'cp other.js test.js', 'rm test.js', 'tee test.js < x', 'perl -pi -e s/a/b/ test.js']) {
      expect(evaluateGuards([TESTS], callOf('Bash', { command: bad }), new Set(), WORK).deny).toBeDefined()
    }
    expect(evaluateGuards([TESTS], callOf('PowerShell', { command: 'Set-Content -Path test.js -Value x' }), new Set(), WORK).deny).toBeDefined()
    for (const ok of ['cat test.js', 'node test.js', 'git diff test.js', 'sed -n 1,5p test.js', 'node test.js 2>&1 | head -5', 'echo hi > out/other.txt']) {
      expect(evaluateGuards([TESTS], callOf('Bash', { command: ok }), new Set(), WORK).deny).toBe(undefined)
    }
    // a guard on Bash with its own commandRegex is not widened
    expect(guardMatches(ADD_A, callOf('Bash', { command: 'echo x > test.js' }), WORK)).toBe(false)
  })
  test('a guard with no condition matches nothing; every named condition must hold', async () => {
    expect(guardMatches(G({ when: {} }), { tool: 'Edit' }, WORK)).toBe(false)
    expect(guardMatches(G({ when: { tool: 'Edit', pathGlob: '*.cs' } }), { tool: 'Edit', path: 'a.md' }, WORK)).toBe(false)
  })
})

// ---------------------------------------------------------------- end to end

const NOW_MS = Date.parse('2026-10-10T03:00:00.000Z')
const K = (p: string) => p.split('/').join('\\')
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type World = { files: Record<string, string>; store: Record<string, unknown>; env: Record<string, string>; ran: string[][]; registered: string[]; toasts: string[]; statuses: string[]; hookExit: number; clock: ReturnType<typeof mock.clock> }

function world(on: On, o: { profile?: unknown; env?: Record<string, string>; files?: Record<string, string>; root?: string } = {}): World {
  const w: World = {
    files: { ...(o.profile !== undefined ? { 'C:\\demo\\.claude\\foreman.json': JSON.stringify(o.profile) } : {}), ...(o.files ?? {}) },
    store: {}, env: { USERPROFILE: 'C:\\home', ...(o.env ?? {}) }, ran: [], registered: [], toasts: [], statuses: [], hookExit: 0, clock: mock.clock(on, { now: NOW_MS }),
  }
  const isDir = (p: string) => ['c:\\demo', 'c:\\demo\\'].includes(K(p).toLowerCase()) || Object.keys(w.files).some(f => f.toLowerCase().startsWith(K(p).toLowerCase().replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: o.root ?? 'C:\\demo' }))
  on('session.cwd', () => ({ value: o.root ?? 'C:\\demo' }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('command.list', () => ({ value: [] }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('fs.exists', ($, e) => ({ value: K(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = K(e.path).replace(/\\+$/, '')
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    if (isDir(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => {
    const p = K(e.path)
    if (p in w.files) return { value: w.files[p] as string }
    if (p.includes('\\prompts\\')) return { value: 'TASK: {{task}}' }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    const a = [...e.argv]
    w.ran.push(a)
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[1] === 'agents') return ok('[]')
    if (a[1] === '--bg') return ok('backgrounded · aaaa0001 · foreman:r9:implementer')
    if (a[0] === 'powershell.exe') return ok(w.hookExit === 0 ? `DRY RUN: would create run ${a.at(-2)}` : 'boom', w.hookExit)
    return ok('')
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'base', scope: 'shared' }] }))
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', ($, e) => { if (typeof e.text === 'string') w.statuses.push(e.text); return { value: undefined } })
  return w
}

const denied = (r: unknown) => JSON.stringify(r).includes('foreman guard: ')
const RULES = [IMPACT, ADD_A, TESTS]
/** Guards that act in every session that loads foreman (the 0.1 behaviour, now opt-in, D-78). */
const EVERYWHERE = { guards: { scope: 'everywhere', rules: RULES } }
/** The 0.2 default scope: foreman's threads only. */
const THREADS = { guards: { rules: RULES } }
const THREAD_ENV = { FOREMAN_THREAD: 'foreman:r9:implementer-A' }
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }

test('guards in the main chat (scope everywhere): deny refuses, warn tells the model and the person and lets the call run', async ($, on) => {
  const w = world(on, { profile: EVERYWHERE })
  const rows = mock.session(on)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\test.js', old_string: 'a', new_string: 'b' } as never))).toBe(true)
  const warned = await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\Foo.cs', old_string: 'a', new_string: 'b' } as never)
  expect(denied(warned)).toBe(false)
  expect(w.toasts.some(t => t.includes('call mcp__gitnexus__impact before Edit on src/Foo.cs'))).toBe(true)
  expect(JSON.stringify(rows.appended())).toContain('foreman guard (warning from this repo\'s profile): impact first: call mcp__gitnexus__impact')
  // once the required tool ran, the warning stops
  await $.tool.call({ tool: 'mcp__gitnexus__impact', target: 'Foo' } as never)
  const before = w.toasts.length
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\Foo.cs', old_string: 'a', new_string: 'b' } as never)
  expect(w.toasts.length).toBe(before)
})

test('D-78: with the default scope the main chat\'s calls are not judged (Phase 1 criterion 4)', async ($, on) => {
  const w = world(on, { profile: THREADS })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\test.js', old_string: 'a', new_string: 'b' } as never))).toBe(false)
  expect(w.toasts.some(t => t.startsWith('guard:'))).toBe(false)
})

test('D-78: the same profile in a foreman thread denies (Phase 1 criterion 4)', async ($, on) => {
  world(on, { profile: THREADS, env: THREAD_ENV })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
})

test('Phase 4 criterion 3 (kit): a thread in a plan\'s worktree reads the main tree\'s profile, not committed: its deny guard acts there (D-71)', async ($, on) => {
  const tree = 'C:\\demo\\.claude\\worktrees\\foreman-r9'
  // the worktree holds the committed files only: no .claude/foreman.json there; the main tree has the person's
  const w = world(on, { profile: THREADS, env: THREAD_ENV, root: tree, files: { [`${tree}\\.git`]: 'gitdir: C:/demo/.git/worktrees/foreman-r9\n' } })
  // a plan the registry knows works there (O-2 of the Phase 4 review: the folder's name alone is not enough)
  w.store['plans:c:/demo'] = { v: 2, plans: [{ id: 'r9', plan: 'docs/plan.md', title: 'Plan', dir: 'C:\\demo\\.git\\foreman\\r9', parts: [{ id: 'A', title: 'A' }], current: 0, status: 'running', startedAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', isolation: 'worktree', tree }] }
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
})

test('live round of Phase 4, criterion 3: a thread loaded with --plugin-dir, whose store holds no plan, knows its plan\'s worktree by its name; a pathGlob deny acts on a file of the worktree', async ($, on) => {
  const tree = 'C:\\demo\\.claude\\worktrees\\foreman-r9'
  const LOCKED = { guards: { scope: 'threads', rules: [{ when: { tool: 'Write|Edit|MultiEdit', pathGlob: 'docs/locked/**' }, mode: 'deny', reason: 'docs/locked is frozen' }] } }
  // the main tree's profile, not committed; the worktree holds the committed files only; the store is empty (another plugin source)
  world(on, { profile: LOCKED, env: THREAD_ENV, root: tree, files: { [`${tree}\\.git`]: 'gitdir: C:/demo/.git/worktrees/foreman-r9\n', [`${tree}\\docs\\locked\\notes.md`]: '# Notes\n' } })
  const edit = await $.tool.call({ tool: 'Edit', file_path: `${tree}\\docs\\locked\\notes.md`, old_string: '# Notes', new_string: '# Notes\nmore' } as never)
  expect(denied(edit)).toBe(true)
  expect(JSON.stringify(edit)).toContain('docs/locked is frozen')
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: `${tree}\\README.md`, old_string: 'a', new_string: 'b' } as never))).toBe(false)
})

test('a thread of another plan in a foreman-<plan> folder that no plan names keeps that folder\'s own profile (O-2 still holds)', async ($, on) => {
  const other = 'C:\\demo\\.claude\\worktrees\\foreman-x1'
  world(on, { profile: THREADS, env: THREAD_ENV, root: other, files: { [`${other}\\.git`]: 'gitdir: C:/demo/.git/worktrees/foreman-x1\n' } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
})

test('a folder named like a plan\'s worktree that no plan names (foreman-p4) keeps its own profile (O-2)', async ($, on) => {
  const look = 'C:\\demo\\.claude\\worktrees\\foreman-p4'
  world(on, { profile: THREADS, env: THREAD_ENV, root: look, files: { [`${look}\\.git`]: 'gitdir: C:/demo/.git/worktrees/foreman-p4\n' } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
})

test('a worktree of the person\'s own is no plan worktree: its own profile holds there (D-29)', async ($, on) => {
  const mine = 'C:\\demo\\.claude\\worktrees\\mine'
  world(on, { profile: THREADS, env: THREAD_ENV, root: mine, files: { [`${mine}\\.git`]: 'gitdir: C:/demo/.git/worktrees/mine\n' } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
})

test('no profile, no guards: nothing is refused (D8)', async ($, on) => {
  world(on)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
})

test('thread mode: guards on; no /foreman, no watcher, no registry writes', async ($, on) => {
  const w = world(on, { profile: THREADS, env: THREAD_ENV })
  await $.session.start({ cwd: 'C:\\demo', surface: null, isInteractive: true } as never)
  await w.clock.advance(65_000)
  expect(w.registered).toEqual([])
  // no watcher: two minutes of ticks list no session
  expect(w.ran.filter(a => a[1] === 'agents').length).toBe(0)
  expect(Object.keys(w.store).length).toBe(0)
  expect(w.statuses).toContain("thread foreman:r9:implementer-A: the profile's guards are on (3)")
  expect((await $.command.run(typed('status'))).text).toBe('This session is the foreman thread foreman:r9:implementer-A: /foreman runs in the chat that coordinates it.')
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(true)
  expect(Object.keys(w.store).length).toBe(0)
})

test('thread mode without a profile: the status line says no guards act', async ($, on) => {
  const w = world(on, { env: { FOREMAN_THREAD: 'foreman:adhoc:free' } })
  await $.session.start({ cwd: 'C:\demo', surface: null, isInteractive: true } as never)
  expect(w.statuses).toContain('thread foreman:adhoc:free: no guards in the profile')
})

test('the main chat (no marker) starts its watcher: one look at the sessions, then the 5-minute pace while nothing is open (D-79)', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(65_000)
  expect(w.registered).toEqual(['foreman'])
  expect(w.ran.filter(a => a[1] === 'agents').length).toBe(1)
})

test('the session section: the thread knows its name, role and part, and nothing of handoff files', async ($, on) => {
  world(on, { env: THREAD_ENV })
  const composed = await $.prompt.compose(COMPOSE as never)
  const s = composed.sections.find(x => x.id === 'foreman:session')
  expect(s?.scope).toBe('session')
  expect(s?.text).toBe('You are the foreman thread `foreman:r9:implementer-A` (role implementer, part A). End every turn with the foreman-result block.')
})

test('the session section of foreman\'s processes: the reviewer answers with the review, the supervisor with its JSON, neither with a foreman-result block', async ($, on) => {
  world(on, { env: { FOREMAN_THREAD: 'foreman:r9:reviewer-A' } })
  const reviewer = (await $.prompt.compose(COMPOSE as never)).sections.find(x => x.id === 'foreman:session')?.text ?? ''
  expect(reviewer).toBe('You are foreman\'s reviewer `foreman:r9:reviewer-A`, a read-only process: your answer is the review, in the form your brief gives, and nothing after it (no foreman-result block).')
})

test('the session section of the supervisor process', async ($, on) => {
  world(on, { env: { FOREMAN_THREAD: 'foreman:r9:supervisor-A' } })
  const supervisor = (await $.prompt.compose(COMPOSE as never)).sections.find(x => x.id === 'foreman:session')?.text ?? ''
  expect(supervisor).toBe('You are foreman\'s supervisor `foreman:r9:supervisor-A`, a read-only process: end with the one decision JSON your brief asks for (no foreman-result block).')
})

test('the session section is left out in a main chat with nothing open', async ($, on) => {
  world(on)
  expect((await $.prompt.compose(COMPOSE as never)).sections.map(x => x.id)).toEqual(['engine'])
})

test('A-13: a 0.1 profile with hooks.onRunCreate runs nothing of the repo\'s, and setup --show says the key is retired', async ($, on) => {
  const w = world(on, {
    profile: { hooks: { onRunCreate: 'powershell.exe -NoProfile -File scripts/fake-new-run.ps1 -RunId {{runId}} -DryRun' } },
    files: { 'C:\\demo\\scripts\\fake-new-run.ps1': 'param()' },
  })
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('status'))
  expect(w.ran.some(a => a[0] === 'powershell.exe')).toBe(false)
  expect((await $.command.run(typed('setup --show'))).text).toContain('hooks: retired in 0.2 (hooks.onRunCreate ran a repo command on its own); ignored')
})

test('P4-01: a composer prompt shaped like a hand-back is never held back', async ($, on) => {
  world(on)
  const r = await $.prompt.submit({ text: '<agent-message from="agent1">[Subagent hand-back] x</agent-message>', origin: { kind: 'composer', from: 'agent1', senderTaskId: 'agent1', handback: true }, wait: false } as never)
  expect(r).toMatchObject({ text: expect.stringContaining('hand-back') })
})

test('P5-02: a profile that declared guards and then cannot be parsed refuses calls instead of running them unguarded', async ($, on) => {
  const w = world(on, { profile: EVERYWHERE })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "guards": [ broken'
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(JSON.stringify(r)).toContain('cannot be read or parsed')
})

test('P5-02: a thread that starts on a broken profile naming guards refuses calls; one that names none runs them', async ($, on) => {
  const w = world(on, { profile: THREADS, env: THREAD_ENV })
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "guards": [ broken'
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toContain('cannot be read or parsed')
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "roles": { broken'
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
})
