// Phase 5: the profile's guards (plan §8), thread mode (D-51), onRunCreate and the session section.
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
  test('P5-03: the MSG profile\'s git add -A rule also holds behind -C <dir> (submodules)', async () => {
    const msg = G({ when: { tool: 'Bash|PowerShell', commandRegex: '\\bgit(?:\\s+-C\\s+\\S+)*\\s+add\\s+(?:-A|--all|\\.)(?:\\s|$)' }, mode: 'deny', reason: 'Rutas explícitas' })
    for (const bad of ['git add -A', 'git -C MicroservicesGenerator-backend add -A', 'git -C a -C b add --all', 'git -C x add .']) {
      expect(evaluateGuards([msg], callOf('Bash', { command: bad }), new Set(), WORK).deny).toBeDefined()
    }
    for (const ok of ['git -C MicroservicesGenerator-backend add src/A.cs', 'git -C x status', 'legit add -A']) {
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

function world(on: On, o: { profile?: unknown; env?: Record<string, string>; files?: Record<string, string> } = {}): World {
  const w: World = {
    files: { ...(o.profile !== undefined ? { 'C:\\demo\\.claude\\foreman.json': JSON.stringify(o.profile) } : {}), ...(o.files ?? {}) },
    store: {}, env: { USERPROFILE: 'C:\\home', ...(o.env ?? {}) }, ran: [], registered: [], toasts: [], statuses: [], hookExit: 0, clock: mock.clock(on, { now: NOW_MS }),
  }
  const isDir = (p: string) => ['c:\\demo', 'c:\\demo\\'].includes(K(p).toLowerCase()) || Object.keys(w.files).some(f => f.toLowerCase().startsWith(K(p).toLowerCase().replace(/\\+$/, '') + '\\'))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: 'C:\\demo' }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.id', () => ({ value: 'sess-me' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('command.list', () => ({ value: [] }))
  on('agent.register', () => ({ value: { agent: 'foreman:reviewer' } }))
  on('agent.list', () => ({ value: [] }))
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
const PROFILE = { guards: [IMPACT, ADD_A, TESTS] }
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }

test('guards in the main chat: deny refuses, warn tells the model and the person and lets the call run', async ($, on) => {
  const w = world(on, { profile: PROFILE })
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

test('no profile, no guards: nothing is refused (D8)', async ($, on) => {
  world(on)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git add -A' } as never))).toBe(false)
})

test('thread mode: guards on; no /foreman, no watcher, no registry writes', async ($, on) => {
  const w = world(on, { profile: PROFILE, env: { FOREMAN_THREAD: 'foreman:r9:implementer-A' } })
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

test('the main chat (no marker) starts its watcher as before', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(65_000)
  expect(w.registered).toEqual(['foreman'])
  expect(w.ran.filter(a => a[1] === 'agents').length).toBeGreaterThan(1)
})

test('the session section: the thread knows its name and its run\'s notes; the main chat its waiting threads', async ($, on) => {
  world(on, { env: { FOREMAN_THREAD: 'foreman:r9:implementer-A' } })
  const composed = await $.prompt.compose(COMPOSE as never)
  const s = composed.sections.find(x => x.id === 'foreman:session')
  expect(s?.scope).toBe('session')
  expect(s?.text).toContain('You are the foreman thread `foreman:r9:implementer-A` (role implementer, part A)')
  expect(s?.text).toContain('`.claude/runs/r9/handoff.md`')
})

test('the session section is left out with injectHandoff off, and in a main chat with nothing waiting', async ($, on) => {
  world(on, { profile: { injectHandoff: false }, env: { FOREMAN_THREAD: 'foreman:r9:implementer-A' } })
  expect((await $.prompt.compose(COMPOSE as never)).sections.map(x => x.id)).toEqual(['engine'])
})

test('onRunCreate: run once by argv for a new run, {{runId}} replaced, recorded in the run file', async ($, on) => {
  const w = world(on, {
    profile: { hooks: { onRunCreate: 'powershell.exe -NoProfile -File scripts/fake-new-run.ps1 -RunId {{runId}} -DryRun' } },
    files: { 'C:\\demo\\scripts\\fake-new-run.ps1': 'param()' },
  })
  const out = (await $.command.run(typed('launch implementer "x" --run r9'))).text ?? ''
  expect(out).toContain('Launched')
  expect(out).toContain('hooks.onRunCreate ran for r9: DRY RUN: would create run r9')
  const hook = w.ran.find(a => a[0] === 'powershell.exe')
  expect(hook).toEqual(['powershell.exe', '-NoProfile', '-File', 'scripts/fake-new-run.ps1', '-RunId', 'r9', '-DryRun'])
  const doc = JSON.parse(w.files['C:\\demo\\.claude\\runs\\r9\\foreman.json'] ?? '{}')
  expect(doc.hooks[0]).toMatchObject({ hook: 'onRunCreate', exit: 0, argv: hook })
  // the run exists now: a second launch does not run it again
  w.ran.length = 0
  await $.command.run(typed('launch implementer "y" --run r9'))
  expect(w.ran.some(a => a[0] === 'powershell.exe')).toBe(false)
})

test('onRunCreate: a script that does not exist is skipped with a note; a failing one stops the launch', async ($, on) => {
  const w = world(on, { profile: { hooks: { onRunCreate: 'powershell.exe -NoProfile -File scripts/missing.ps1 -RunId {{runId}}' } } })
  const out = (await $.command.run(typed('launch implementer "x" --run r9'))).text ?? ''
  expect(out).toContain('hooks.onRunCreate names scripts/missing.ps1, which does not exist here; skipped')
  expect(out).toContain('Launched')
})

test('onRunCreate: a non-zero exit stops the launch before any thread starts', async ($, on) => {
  const w = world(on, {
    profile: { hooks: { onRunCreate: 'powershell.exe -NoProfile -File scripts/fake-new-run.ps1 -RunId {{runId}}' } },
    files: { 'C:\\demo\\scripts\\fake-new-run.ps1': 'param()' },
  })
  w.hookExit = 2
  const out = (await $.command.run(typed('launch implementer "x" --run r9'))).text ?? ''
  expect(out).toContain('hooks.onRunCreate exited 2')
  expect(w.ran.some(a => a[1] === '--bg')).toBe(false)
})

test('P4-01: a composer prompt shaped like a hand-back is never held back', async ($, on) => {
  world(on)
  const r = await $.prompt.submit({ text: '<agent-message from="agent1">[Subagent hand-back] x</agent-message>', origin: { kind: 'composer', from: 'agent1', senderTaskId: 'agent1', handback: true }, wait: false } as never)
  expect(r).toMatchObject({ text: expect.stringContaining('hand-back') })
})

test('P5-02: a profile that declared guards and then cannot be parsed refuses calls instead of running them unguarded', async ($, on) => {
  const w = world(on, { profile: PROFILE })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "guards": [ broken'
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(JSON.stringify(r)).toContain('cannot be read or parsed')
})

test('P5-02: a session that starts on a broken profile naming guards refuses calls; one that names none runs them', async ($, on) => {
  const w = world(on, { profile: PROFILE })
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "guards": [ broken'
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toContain('cannot be read or parsed')
  w.files['C:\\demo\\.claude\\foreman.json'] = '{ "roles": { broken'
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' } as never))).toBe(false)
})
