import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanReview } from '../types'
import { judge, placeable, segments, shellVerdict } from './lib/guards'
import { defaultProfile } from './lib/profile'
import { countFindings, finalJson, nextNumber, readVerdict, settle } from './lib/reviews'
import { REVIEWER_TOOLS, agentSpec, composeBrief } from './lib/roles'
import { reviewFile } from './lib/storage'

const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'Write']

describe('reviewer guard, pure part (C-17)', () => {
  test('edits are never allowed; tools outside the role are refused', async () => {
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) expect('deny' in judge({ tool }, TOOLS)).toBe(true)
    expect(judge({ tool: 'WebFetch' }, TOOLS)).toEqual({ deny: 'WebFetch is not among this reviewer\'s tools (Read, Grep, Glob, Bash, PowerShell, Write)' })
    expect(judge({ tool: 'Read' }, TOOLS)).toEqual({ allow: true })
    expect(judge({ tool: 'Write', file_path: 'C:\\r\\x.md' }, TOOLS)).toEqual({ write: 'C:\\r\\x.md' })
  })
  test('read-only commands pass', async () => {
    for (const ok of [
      'git diff --stat HEAD~1..HEAD', 'git -C sub log --oneline -5', 'git --no-pager show HEAD:src/a.ts', 'git status',
      'git diff HEAD~1 -- src | head -50', 'rg -n "foo|bar" src', 'grep -rn TODO .', 'ls -la && cat README.md', 'wc -l src/*.ts',
      'Get-Content src\\a.ts', 'Get-ChildItem -Recurse src | Select-String foo', 'find . -name "*.ts"',
      'ls -R .claude/runs 2>/dev/null', 'git log -1 2>&1 | head -3', 'Get-ChildItem x 2>$null',
    ]) expect(shellVerdict(ok)).toBe(undefined)
  })
  test('anything that writes, runs or substitutes is refused', async () => {
    for (const bad of [
      'echo x > a.txt', 'cat a >> b', 'cat a 2>/dev/null > b', 'ls 2> err.txt', 'git diff 1>out.txt', 'git commit -m x', 'git push', 'git checkout -- .', 'git -c core.pager=evil log',
      'git diff --output=x.patch', 'git diff --ext-diff', 'rm -rf src', 'npm test', 'node -e "1"', 'sed -i s/a/b/ f',
      'find . -delete', 'find . -exec rm {} +', 'rg --pre evil x', 'ls $(whoami)', 'ls `whoami`', 'FOO=1 git diff',
      'Set-Content a.txt x', 'Remove-Item a', 'Get-ChildItem | ForEach-Object { rm $_ }', 'notepad &', 'sort -o out.txt in.txt',
      'git log; rm a', 'git status\nrm a', 'python x.py', 'powershell -c "rm a"', 'git branch -D main', 'tail -f log',
    ]) expect(shellVerdict(bad)).not.toBe(undefined)
  })
  test('pipes and lists split outside quotes only', async () => {
    expect(segments('rg "a|b" x | head -5 && ls')).toEqual(['rg "a|b" x', 'head -5', 'ls'])
  })
  test('a Write path must be placeable', async () => {
    expect(placeable('C:\\r\\.claude\\runs\\r1\\review-A-r1.md')).toEqual({ folder: 'C:\\r\\.claude\\runs\\r1\\', name: 'review-A-r1.md' })
    for (const bad of ['C:x.md', '\\\\server\\share\\x.md', '//x/y.md', 'C:\\r\\', 'C:\\r\\..']) expect('why' in placeable(bad)).toBe(true)
  })
  test('C3-01: PowerShell is not a reviewer tool (foreman fixes them, not the profile), and judge refuses it', async () => {
    expect([...REVIEWER_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write'])
    expect(judge({ tool: 'PowerShell', command: 'Get-Content a.txt' }, [...REVIEWER_TOOLS])).toEqual({ deny: 'PowerShell is not among this reviewer\'s tools (Read, Grep, Glob, Bash, Write)' })
  })
  test('C3-01: with PowerShell given by a profile, expressions, type literals and variables are refused', async () => {
    for (const bad of [
      "Get-Content ([IO.File]::WriteAllText('C:/x/pwned.txt','pwned'))", "Write-Output ([IO.File]::Delete('src/a.js'))", 'Get-Content $env:USERPROFILE\\x',
      'Get-Content @args', 'Get-ChildItem [x]', 'Get-Content "$(rm a)"', 'Get-Content "`$x"', 'Select-String -Path a -Pattern (Get-Date)',
    ]) expect(shellVerdict(bad, 'PowerShell')).not.toBe(undefined)
    for (const ok of ["Get-Content 'src\\a.ts'", "Select-String -Path src\\*.ts -Pattern 'foo(bar)'", 'Get-ChildItem -Recurse src', "Get-Content 'a[1].txt'"]) expect(shellVerdict(ok, 'PowerShell')).toBe(undefined)
    expect(judge({ tool: 'PowerShell', command: "Get-Content ([IO.File]::WriteAllText('x','y'))" }, [...TOOLS])).toMatchObject({ deny: expect.stringContaining('parentheses') })
  })
  test('C3-02: list programs that write or run something, programs by path, and .exe names are refused', async () => {
    for (const bad of [
      'uniq a.js b.js', 'tree -o F', 'file -C -m M', 'cat a | less -o F', 'sort --compress-program=P x', 'sort.exe /O F IN', 'more a',
      'rg --hostname-bin=P x', 'rg --pre=P x', 'rg -z x', 'rg -iz x', 'rg --search-zip x', './.claude/runs/r1/cat x', 'C:/tmp/evil/cat x',
      '/usr/bin/git log', 'git.exe log', 'tail -F log', 'tail -100f log',
    ]) expect(shellVerdict(bad)).not.toBe(undefined)
  })
  test('C3-05: searches with special characters inside quotes pass; the same characters outside quotes do not', async () => {
    for (const ok of ['rg "a > b" src', "rg 'function f() {' src", 'rg "=>" src', "rg 'List<T>' src", 'grep -rn "if (x)" .', "rg '$HOME' x", 'rg "a&b" x']) expect(shellVerdict(ok)).toBe(undefined)
    for (const bad of ['rg a > b', 'rg f() src', 'rg => src', 'rg List<T> src', 'rg "$HOME" x', 'rg "`id`" x', 'rg x & y', "rg 'unclosed x"]) expect(shellVerdict(bad)).not.toBe(undefined)
  })
})

describe('review files and verdicts', () => {
  test('names and numbers', async () => {
    expect(reviewFile('A', 2)).toBe('review-A-r2.md')
    expect(nextNumber(['review-A-r1.md', 'review-A-r3.md', 'review-B-r9.md', 'brief-A.md', 'foreman.json'], 'A')).toBe(4)
    expect(nextNumber([], 'A')).toBe(1)
  })
  test('the verdict is on the first non-empty line, English or Spanish, emphasis ignored', async () => {
    expect(readVerdict('\nVerdict: NO\n\n### C-01')).toBe('NO')
    expect(readVerdict('Veredicto: OK')).toBe('OK')
    expect(readVerdict('**Verdict: BLOCKED**')).toBe('BLOCKED')
    expect(readVerdict('Verdict: PASS')).toBe(undefined)
    expect(readVerdict('# Review\nVerdict: OK')).toBe(undefined)
    expect(readVerdict('Verdict: OKAY')).toBe(undefined)
  })
  test('findings are counted by their ids', async () => {
    expect(countFindings('Verdict: NO\n### C-01 · P1 · a.ts:1 · x\n### C-02 · P2 · b.ts:2 · y\nsee C-01 again\n- C-03 · P3')).toBe(3)
  })
  test('A-10: findings in other shapes are counted too; a "checked" section is not one', async () => {
    expect(countFindings('Verdict: NO\n\n### 1. Off by one in sum.js:4\nx\n\n### 2. Missing test\ny\n\n### What I checked\nall\n')).toBe(2)
    expect(countFindings('Verdict: NO\n\n**Finding 1**: x\n**Finding 2**: y\n**Finding 3**: z\n')).toBe(3)
    expect(countFindings('Veredicto: NO\n\n## Hallazgo 1\n## Hallazgo 2\n## Resumen\n')).toBe(2)
    expect(countFindings('Verdict: OK\n\nNothing blocks the part.\n')).toBe(0)
  })
  test('the final JSON of the answer', async () => {
    expect(finalJson('done.\n{"verdict":"no","findings":2,"file":"x.md"}')).toEqual({ verdict: 'NO', findings: 2, file: 'x.md' })
    expect(finalJson('no json here')).toBe(undefined)
  })
  test('settling: the file decides; no file or no verdict is noResult, never OK', async () => {
    expect(settle('Verdict: NO\n### C-01 · P1 · a:1 · x', '{"verdict":"NO","findings":1}')).toEqual({ verdict: 'NO', findings: 1 })
    expect(settle(undefined, '{"verdict":"OK","findings":0}')).toMatchObject({ verdict: 'none', noResult: true, reason: 'the review file was not written' })
    expect(settle('Looks good to me', '{"verdict":"OK"}')).toMatchObject({ verdict: 'none', noResult: true })
    expect(settle('Verdict: NO\n### C-01', '{"verdict":"OK"}').reason).toContain('the file\'s first line, NO, stands')
    // a NO whose findings the file does not shape is counted from the final JSON
    expect(settle('Verdict: NO\nThe test fails.', '{"verdict":"NO","findings":2}')).toEqual({ verdict: 'NO', findings: 2 })
  })
})

describe('agent types and briefs', () => {
  test('the profile sets model, effort and skills; the tools are foreman\'s', async () => {
    const p = defaultProfile()
    p.roles.reviewer = { ...p.roles.reviewer, model: 'opus', effort: 'xhigh', skills: ['review-skill'] }
    expect(agentSpec('reviewer', '  You review.  ', p, true)).toEqual({ name: 'reviewer', description: expect.any(String), prompt: 'You review.', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'], model: 'opus', effort: 'xhigh', permissionMode: 'auto', skills: ['review-skill'] })
    expect('skills' in agentSpec('reviewer', 'x', p, false)).toBe(false)
  })
  test('the reviewer brief names the base, the plan, the part and its criteria, and the file to write', async () => {
    const brief = composeBrief('{{base}}..HEAD; plan {{plan}}; part {{part}}: {{partTitle}}\n{{criteria}}\nwrite {{reviewFile}}', [], defaultProfile(), 'reviewer', { task: '', base: 'origin/develop', part: 'A', partTitle: 'Backend', criteria: ['tests pass'], reviewFile: 'C:\\r\\.git\\foreman\\plan\\review-A-r2.md', plan: 'docs/plan.md' })
    expect(brief).toBe('origin/develop..HEAD; plan docs/plan.md; part A: Backend\n- tests pass\nwrite C:\\r\\.git\\foreman\\plan\\review-A-r2.md\n')
  })
})

// ---------------------------------------------------------------- end to end

const NOW_MS = Date.parse('2026-10-10T01:00:00.000Z')
const K = (p: string) => p.split('/').join('\\')
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
/** A run's files live under the repo's .git (D-70). */
const RUN = 'C:\\demo\\.git\\foreman\\r1'
const FILE = `${RUN}\\review-A-r1.md`

type World = { files: Record<string, string>; store: Record<string, unknown>; spawns: { subagentType?: string; prompt: string; model?: string; cwd?: string }[]; registered: unknown[]; ran: string[]; toasts: string[]; logs: string[]; live: { id: string; type: string; description?: string }[]; breakProfile: boolean; me: string; sessions: { sessionId: string; pid?: number }[]; breakList: boolean; submitted: string[]; tools: string[]; clock?: ReturnType<typeof mock.clock> }

function world(on: On, files: Record<string, string> = {}): World {
  const w: World = { files: { ...files }, store: {}, spawns: [], registered: [], ran: [], toasts: [], logs: [], live: [], breakProfile: false, me: 'sess-me', sessions: [], breakList: false, submitted: [], tools: ['Read', 'Bash'] }
  w.clock = mock.clock(on, { now: NOW_MS })
  const isDir = (p: string) => Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\')) || ['C:\\demo', 'C:\\demo\\'].includes(K(p))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => (w.breakProfile ? { deny: 'session gone' } : { value: 'C:\\demo' }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.id', () => ({ value: w.me }))
  on('command.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: K(e.path) in w.files || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    const p = K(e.path).replace(/\\+$/, '')
    if (p in w.files) return { value: { kind: 'file', size: (w.files[p] ?? '').length, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    if (isDir(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: p } : {}) } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', ($, e) => ({ value: Object.keys(w.files).filter(f => f.startsWith(K(e.path) + '\\') && !f.slice(K(e.path).length + 1).includes('\\')).map(f => ({ name: f.slice(K(e.path).length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', ($, e) => {
    const p = K(e.path)
    if (w.breakProfile && p.endsWith('\\.claude\\foreman.json')) throw new Error('disk gone')
    if (p in w.files) return { value: w.files[p] as string }
    if (p.includes('\\prompts\\')) return { value: p.includes('\\agents\\') ? 'SYSTEM' : 'BASE {{base}} FILE {{reviewFile}} PART {{part}} PLAN {{plan}}' }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    w.ran.push(e.argv.join(' '))
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git' && e.argv.includes('origin/HEAD')) return ok('origin/main\n')
    if (e.argv[0] === 'git' && e.argv.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    if (e.argv[1] === 'agents') return ok(JSON.stringify(w.sessions.map(x => ({ ...x, cwd: 'C:/demo', kind: 'interactive', startedAt: 0 }))))
    return ok('')
  })
  on('agent.register', ($, e) => { w.registered.push(e); return { value: { agent: `foreman:${e.name}` } } })
  // the kit hands a plugin's spawn to this hook in the Agent tool's spelling, and keeps core's agentId to core:
  // the plugin finds the agent it started in the agent list
  on('agent.spawn', ($, e) => {
    const a = e as unknown as { subagentType?: string; subagent_type?: string; prompt: string; model?: string; cwd?: string; description: string }
    const type = a.subagentType ?? a.subagent_type ?? ''
    w.spawns.push({ subagentType: type, prompt: a.prompt, model: a.model, cwd: a.cwd })
    w.live.push({ id: `agent${w.spawns.length}`, type, description: a.description })
    return { model: 'claude-fable-5-1', agentId: `agent${w.spawns.length}` }
  })
  on('agent.list', () => (w.breakList ? { deny: 'list gone' } : { value: w.live.map(a => ({ id: a.id, description: a.description ?? '', type: a.type, status: 'running' })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // a plugin's $.agent.spawn reaches the bottom as the Agent tool, run in the background
  on('tool.call', ($, e) => {
    if (String(e.tool) !== 'Agent') return { result: 'ran' }
    const a = e as unknown as { subagent_type?: string; prompt: string; model?: string; cwd?: string; description: string }
    w.spawns.push({ subagentType: a.subagent_type, prompt: a.prompt, model: a.model, cwd: a.cwd })
    const agentId = `agent${w.spawns.length}`
    w.live.push({ id: agentId, type: a.subagent_type ?? '' })
    return { result: { status: 'async_launched', agentId, description: a.description, prompt: a.prompt, outputFile: '', resolvedModel: 'claude-fable-5-1' } } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('prompt.submit', ($, e) => { w.submitted.push(e.text); return { text: e.text } })
  on('tool.list', () => ({ value: w.tools.map(name => ({ name, description: '' })) as never }))
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  return w
}

const reviewsOf = (w: World) => (w.store['v2:reviews:c:/demo'] ?? []) as ForemanReview[]
const complete = (agentId: string, answer: string) => ({ answer, durationMs: 1000, isAborted: false, turnId: 't1', agentId, reason: 'answer' as const })
const denied = (r: unknown) => JSON.stringify(r).includes('foreman: ')

test('review: a fresh reviewer is spawned on the default base; its file settles the verdict', async ($, on) => {
  const w = world(on)
  const out = (await $.command.run(typed('review --run r1 --part A'))).text ?? ''
  expect(out).toContain(`Started foreman:reviewer (fable) on r1 part A, diff origin/main..HEAD. It writes ${FILE}`)
  expect(w.spawns[0]).toMatchObject({ subagentType: 'foreman:reviewer', model: 'fable', cwd: 'C:\\demo' })
  expect(w.spawns[0]?.prompt).toBe(`BASE origin/main FILE ${FILE} PART A PLAN none: review the diff on its own\n`)
  expect(w.registered.length).toBe(1)
  expect(reviewsOf(w)[0]).toMatchObject({ kind: 'review', agentId: 'agent1', verdict: 'none', n: 1 })
  // it writes its file and answers
  w.files[FILE] = 'Verdict: NO\n\n### C-01 · P1 · src/sum.js:2 · off by one\n### C-02 · P3 · README.md:1 · typo\n'
  await $.turn.complete(complete('agent1', 'Wrote the review.\n{"verdict":"NO","findings":2,"file":"x"}'))
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'NO', findings: 2 })
  expect(reviewsOf(w)[0]?.finishedAt).toBeDefined()
  const doc = JSON.parse(w.files[`${RUN}\\foreman.json`] ?? '{}')
  expect(doc.reviews).toEqual([expect.objectContaining({ kind: 'review', part: 'A', n: 1, verdict: 'NO', findings: 2, agentId: 'agent1' })])
  expect(w.toasts.some(t => t.startsWith('Review A r1: NO, 2 finding(s)'))).toBe(true)
  expect((await $.command.run(typed('status'))).text).toContain(`- Review A r1: NO, 2 finding(s). ${FILE}`)
  // the next one is r2
  expect((await $.command.run(typed('review --run r1 --part A --base HEAD~3'))).text).toContain('review-A-r2.md')
})

test('review: no file, or no verdict on its first line, is noResult; never OK', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  await $.turn.complete(complete('agent1', 'All good!\n{"verdict":"OK","findings":0}'))
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', noResult: true, reason: 'the review file was not written' })
  // the number stays taken though no file was written: the next one is r2
  expect((await $.command.run(typed('review --run r1 --part A --base main'))).text).toContain('review-A-r2.md')
  w.files[`${RUN}\\review-A-r2.md`] = 'Looks fine overall.\n'
  await $.turn.complete(complete('agent2', '{"verdict":"OK"}'))
  expect(reviewsOf(w)[1]).toMatchObject({ verdict: 'none', noResult: true })
})

test('the critic and --deep are gone: each says what replaces it', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(typed('critic --run r1 --part A --base main'))).text).toContain('The critic is gone in 0.2')
  expect((await $.command.run(typed('review --run r1 --part A --base main --deep'))).text).toBe('--deep is gone in 0.2: /foreman review starts one fresh reviewer.')
  expect(w.spawns.length).toBe(0)
  expect(w.submitted.length).toBe(0)
})

test('review refuses unsafe names and refs, and a second one of the same part while one runs', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(typed('review --run .. --base main'))).text).toContain('--run takes')
  expect((await $.command.run(typed('review --run r1 --base "--output=x"'))).text).toContain('is not a git ref')
  await $.command.run(typed('review --run r1 --part A --base main'))
  expect((await $.command.run(typed('review --run r1 --part A --base main'))).text).toContain('still running')
  expect(w.spawns.length).toBe(1)
})

test('C-17: the guard judges the reviewer\'s calls, and only the reviewer\'s', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  const asReviewer = { agentId: 'agent1' }
  expect(denied(await $.tool.call({ tool: 'Write', file_path: FILE, content: 'Verdict: OK', ...asReviewer } as never))).toBe(false)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: 'C:\\demo\\src\\sum.js', content: 'x', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: 'C:\\demo\\.git\\foreman\\other\\x.md', content: 'x', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${RUN}\\..\\..\\foreman.json`, content: 'x', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:\\demo\\n.ipynb', new_source: 'x', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git diff --stat main..HEAD', ...asReviewer } as never))).toBe(false)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git commit -am fix', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'PowerShell', command: 'Set-Content src\\sum.js x', ...asReviewer } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'C:\\demo\\src\\sum.js', ...asReviewer } as never))).toBe(false)
  // the main chat and other subagents are not this guard's business
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b' } as never))).toBe(false)
  w.live.push({ id: 'other9', type: 'general-purpose' })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'other9' } as never))).toBe(false)
  // a foreman reviewer the record does not know yet (spawned a moment ago, or by the model): guarded, and may not write
  w.live.push({ id: 'agentX', type: 'foreman:reviewer' })
  expect(denied(await $.tool.call({ tool: 'Write', file_path: FILE, content: 'x', agentId: 'agentX' } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git log -1', agentId: 'agentX' } as never))).toBe(false)
})

test('C-17: when the guard cannot judge a reviewer\'s call, the call is refused', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  // a foreman reviewer the record does not know yet, and the agent list fails mid-check: the hook throws, its .catch refuses
  // (0.2 keeps the session's roots for the session, A-04, so a root that fails mid-check no longer stands in for this)
  w.live.push({ id: 'agentX', type: 'foreman:reviewer' })
  w.breakList = true
  const r = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'agentX' } as never)
  expect(JSON.stringify(r)).toContain('foreman: ')
})

test('reviews whose subagent is gone at session start are settled without a verdict', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  w.live = []
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', noResult: true, settledBy: 'file', reason: 'the reviewer ended before it answered; the review file was not written' })
})

test('C3-03: a review another live session owns is left alone', async ($, on) => {
  const w = world(on)
  w.me = 'sess-A'
  await $.command.run(typed('review --run r1 --part A --base main'))
  expect(reviewsOf(w)[0]?.owner).toBe('sess-A')
  // chat B starts: A is alive, its subagent is not in B's agent list
  w.me = 'sess-B'
  w.sessions = [{ sessionId: 'sess-A', pid: 11 }, { sessionId: 'sess-B', pid: 12 }]
  w.live = []
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]?.finishedAt).toBe(undefined)
})

test('C3-03: an own review whose agent is gone is settled from its file; the verdict there stands', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  w.files[FILE] = 'Verdict: OK\n\nNothing blocks part A.\n'
  w.live = []
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'OK', findings: 0, settledBy: 'file' })
  expect(reviewsOf(w)[0]?.noResult).toBe(undefined)
})

test('C3-03: an orphan settled from its file gives way to the real answer when it comes', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  // another chat settled it as an orphan before the file was there
  w.me = 'sess-B'
  w.live = []
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', settledBy: 'file', noResult: true })
  // the owner's subagent writes and answers
  w.files[FILE] = 'Verdict: NO\n### C-01 · P1 · src/sum.js:4 · off by one\n'
  await $.turn.complete(complete('agent1', '{"verdict":"NO","findings":1}'))
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'NO', findings: 1, settledBy: 'answer' })
  expect(reviewsOf(w)[0]?.noResult).toBe(undefined)
  expect(reviewsOf(w)[0]?.reason).toBe(undefined)
})

test('C3-04: when the guard fails, a known foreign agent\'s call passes; a reviewer\'s or an unknown one\'s is refused', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  w.live.push({ id: 'other9', type: 'general-purpose' })
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b', agentId: 'other9' } as never))).toBe(false)
  w.breakList = true
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b', agentId: 'other9' } as never))).toBe(false)
  // the reviewer foreman knows is judged from its record, with no call that can fail: its edit is refused, its read passes
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b', agentId: 'agent1' } as never))).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'agent1' } as never))).toBe(false)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'C:\\demo\\src\\sum.js', old_string: 'a', new_string: 'b', agentId: 'stranger7' } as never))).toBe(true)
})

test('foreman\'s agent types are not offered to the model', async ($, on) => {
  on('agent.offer', () => ({ isOffered: true }))
  world(on)
  expect(await $.agent.offer({ agent: 'foreman:reviewer', description: 'x', source: 'plugin', provider: { plugin: 'foreman', tier: 'user' } } as never)).toEqual({ isOffered: false })
  expect(await $.agent.offer({ agent: 'general-purpose', description: 'x', source: 'builtin', provider: { plugin: 'engine', tier: 'core' } } as never)).toEqual({ isOffered: true })
})

test('a foreman reviewer\'s hand-back does not wake the chat\'s model; any other peer message does', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  w.files[FILE] = 'Verdict: OK\n'
  await $.turn.complete(complete('agent1', '{"verdict":"OK"}'))
  const handback = (from: string) => ({ text: `<agent-message from="${from}">[Subagent hand-back] Verdict OK.</agent-message>`, origin: { kind: 'peer', from, senderTaskId: from, name: 'foreman:reviewer', handback: true }, wait: false })
  const held = await $.prompt.submit(handback('agent1') as never)
  expect(held).toEqual({ drop: `foreman settles review A r1 from its file (${FILE}); its hand-back is not sent to this chat's model.` })
  const other = await $.prompt.submit(handback('someone-else') as never)
  expect(other).toMatchObject({ text: expect.stringContaining('someone-else') })
})
