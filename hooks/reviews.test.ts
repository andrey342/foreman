// Reviews (plan D2, D-73): the verdict and the findings of a review file, the
// reviewer's brief, and /foreman review end to end with the reviewer as a
// `claude -p` process whose answer foreman writes to the review file.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanReview } from '../types'
import { defaultProfile } from './lib/profile'
import { countFindings, finalJson, nextNumber, readVerdict, settle } from './lib/reviews'
import { composeBrief, reviewerGatesText } from './lib/roles'
import { reviewFile } from './lib/storage'

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
  test('A-10: findings in other shapes are counted too; a "checked" or "gates" section is not one', async () => {
    expect(countFindings('Verdict: NO\n\n### 1. Off by one in sum.js:4\nx\n\n### 2. Missing test\ny\n\n### Gates\n`npm test` exit 1\n\n### What I checked\nall\n')).toBe(2)
    expect(countFindings('Verdict: NO\n\n**Finding 1**: x\n**Finding 2**: y\n**Finding 3**: z\n')).toBe(3)
    expect(countFindings('Veredicto: NO\n\n## Hallazgo 1\n## Hallazgo 2\n## Resumen\n')).toBe(2)
    expect(countFindings('Verdict: OK\n\nNothing blocks the part.\n')).toBe(0)
  })
  test('the final JSON of an answer, when one has it', async () => {
    expect(finalJson('done.\n{"verdict":"no","findings":2,"file":"x.md"}')).toEqual({ verdict: 'NO', findings: 2, file: 'x.md' })
    expect(finalJson('no json here')).toBe(undefined)
  })
  test('settling: the file decides; no file or no verdict is noResult, never OK', async () => {
    expect(settle('Verdict: NO\n### C-01 · P1 · a:1 · x', '{"verdict":"NO","findings":1}')).toEqual({ verdict: 'NO', findings: 1 })
    expect(settle(undefined, '{"verdict":"OK","findings":0}')).toMatchObject({ verdict: 'none', noResult: true, reason: 'the review file was not written' })
    expect(settle('Looks good to me', '{"verdict":"OK"}')).toMatchObject({ verdict: 'none', noResult: true })
    expect(settle('Verdict: NO\n### C-01', '{"verdict":"OK"}').reason).toContain('the file\'s first line, NO, stands')
    expect(settle('Verdict: NO\nThe test fails.', '{"verdict":"NO","findings":2}')).toEqual({ verdict: 'NO', findings: 2 })
  })
})

describe('the reviewer\'s brief (D-73)', () => {
  test('it names the base, the plan, the part, its criteria, the review file and the gates it runs', async () => {
    const brief = composeBrief('{{base}}..HEAD; plan {{plan}}; part {{part}}: {{partTitle}}\n{{criteria}}\nfile {{reviewFile}}\n{{gates}}', [], { ...defaultProfile(), gates: { checks: ['npm test', 'npm run lint'] } }, 'reviewer', { task: '', base: 'origin/develop', part: 'A', partTitle: 'Backend', criteria: ['tests pass'], reviewFile: 'C:\\r\\.git\\foreman\\plan\\review-A-r2.md', plan: 'docs/plan.md' })
    expect(brief).toBe('origin/develop..HEAD; plan docs/plan.md; part A: Backend\n- tests pass\nfile C:\\r\\.git\\foreman\\plan\\review-A-r2.md\n- `npm test`\n- `npm run lint`\n')
  })
  test('with no gates it says to run none; the gates found in the repo count when the profile names none', async () => {
    expect(reviewerGatesText([])).toBe('- None declared or found here: judge the diff and the criteria by reading; run no build and no test.')
    expect(composeBrief('{{gates}}', [], defaultProfile(), 'reviewer', { task: '', detectedGates: ['npm test'] })).toBe('- `npm test`\n')
  })
})

// ---------------------------------------------------------------- end to end

const NOW_MS = Date.parse('2026-10-10T01:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const K = (p: string) => p.split('/').join('\\')
const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
/** A run's files live under the repo's .git (D-70). */
const RUN = 'C:\\demo\\.git\\foreman\\r1'
const FILE = `${RUN}\\review-A-r1.md`

/** What a reviewer process prints: its result (the review's text), or raw output and an exit code. */
type ReviewerOut = { result: string; denials?: unknown[] } | { stdout: string; code: number }
const processJson = (result: string, denials: unknown[] = []) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 6, duration_ms: 60_000, total_cost_usd: 0.05, usage: { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, permission_denials: denials })

type World = {
  files: Record<string, string>
  store: Record<string, unknown>
  spawns: { argv: string[]; prompt: string; cwd?: string; finish: (out: ReviewerOut) => void; finished: boolean }[]
  toasts: string[]
  logs: string[]
  me: string
  sessions: { sessionId: string; pid?: number }[]
  clock: ReturnType<typeof mock.clock>
}

function world(on: On, files: Record<string, string> = {}): World {
  const w: World = { files: { ...files }, store: {}, spawns: [], toasts: [], logs: [], me: 'sess-me', sessions: [], clock: mock.clock(on, { now: NOW_MS }) }
  const isDir = (p: string) => Object.keys(w.files).some(f => f.startsWith(K(p).replace(/\\+$/, '') + '\\')) || ['C:\\demo', 'C:\\demo\\'].includes(K(p))
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => { w.store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.root', () => ({ value: 'C:\\demo' }))
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
    if (p in w.files) return { value: w.files[p] as string }
    if (p.includes('\\prompts\\')) return { value: 'BASE {{base}} FILE {{reviewFile}} PART {{part}} PLAN {{plan}}\n{{gates}}' }
    return { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => { w.files[K(e.path)] = e.text; return { value: undefined } })
  on('process.run', ($, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git' && e.argv.includes('origin/HEAD')) return ok('origin/main\n')
    if (e.argv[0] === 'git' && e.argv.includes('--git-common-dir')) return ok('C:/demo/.git\n')
    if (e.argv[1] === 'agents') return ok(JSON.stringify(w.sessions.map(x => ({ ...x, cwd: 'C:/demo', kind: 'interactive', startedAt: 0 }))))
    return ok('')
  })
  // the reviewer's `claude -p`: it runs until the test answers for it (reviewSays)
  on('process.spawn', async function* ($, e) {
    let finish: (out: ReviewerOut) => void = () => undefined
    const answered = new Promise<ReviewerOut>(resolve => { finish = resolve })
    w.spawns.push({ argv: [...e.argv], prompt: e.input ?? '', ...(e.cwd ? { cwd: e.cwd } : {}), finish, finished: false })
    const out = await answered
    const stdout = 'result' in out ? processJson(out.result, out.denials) : out.stdout
    if (stdout) yield { stream: 'stdout' as const, text: stdout }
    return { value: { code: 'result' in out ? 0 : out.code, signal: null } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'foreman' } }))
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  return w
}

const reviewsOf = (w: World) => (w.store['v2:reviews:c:/demo'] ?? []) as ForemanReview[]

/** The reviewer process that runs answers (D-73): foreman writes its result to the review file and settles it. */
async function reviewSays(w: World, out: string | ReviewerOut) {
  // the process starts when foreman first reads its output: let that happen
  await w.clock.settle()
  const r = w.spawns.find(s => !s.finished)
  if (!r) throw new Error('no reviewer is running')
  r.finished = true
  r.finish(typeof out === 'string' ? { result: out } : out)
  await w.clock.settle()
}

test('review: a fresh read-only reviewer process on the default base; foreman writes its answer, which settles the verdict', async ($, on) => {
  const w = world(on, { 'C:\\demo\\.claude\\foreman.json': JSON.stringify({ gates: { checks: ['npm test'] } }) })
  const out = (await $.command.run(typed('review --run r1 --part A'))).text ?? ''
  await w.clock.settle()
  expect(out).toContain(`Started foreman's reviewer (fable, a read-only process) on r1 part A, diff origin/main..HEAD. foreman writes its answer to ${FILE}`)
  // its flags hold it (D-73, D-112): dontAsk, read-only tools and the repo's gate, its thread-mode name; no Write, no Edit
  const argv = w.spawns[0]?.argv ?? []
  expect(argv.slice(0, 6)).toEqual(['claude', '-p', '--output-format', 'json', '--permission-mode', 'dontAsk'])
  expect(argv.slice(argv.indexOf('--max-turns'), argv.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '40'])
  expect(argv.slice(argv.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(npm test)'])
  expect(argv.join(' ')).toContain('"FOREMAN_THREAD":"foreman:r1:reviewer-A"')
  expect(w.spawns[0]?.cwd).toBe('C:\\demo')
  expect(w.spawns[0]?.prompt).toBe(`BASE origin/main FILE ${FILE} PART A PLAN none: review the diff on its own\n- \`npm test\`\n`)
  expect(reviewsOf(w)[0]).toMatchObject({ kind: 'review', agentId: 'process:foreman:r1:reviewer-A:r1', verdict: 'none', n: 1, model: 'fable' })
  expect((await $.command.run(typed('status'))).text).toContain(`- Review A r1: running (process:foreman:r1:reviewer-A:r1), writes ${FILE}`)
  // it answers with the review's text: foreman writes the file and settles the verdict from it
  await reviewSays(w, 'Verdict: NO\n\n### C-01 · P1 · src/sum.js:2 · off by one\n### C-02 · P3 · README.md:1 · typo\n### Gates\n`npm test`: exit 1\n')
  expect(w.files[FILE]).toBe('Verdict: NO\n\n### C-01 · P1 · src/sum.js:2 · off by one\n### C-02 · P3 · README.md:1 · typo\n### Gates\n`npm test`: exit 1\n')
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'NO', findings: 2, settledBy: 'answer', run: { exit: 0, costUsd: 0.05, turns: 6, durationMs: 60_000, usage: { input: 10, output: 400, cacheRead: 9000, cacheWrite: 0 } } })
  expect(reviewsOf(w)[0]?.finishedAt).toBeDefined()
  const doc = JSON.parse(w.files[`${RUN}\\foreman.json`] ?? '{}')
  expect(doc.reviews.at(-1)).toMatchObject({ kind: 'review', part: 'A', n: 1, verdict: 'NO', findings: 2, run: { costUsd: 0.05 } })
  expect(w.toasts.some(t => t.startsWith('Review A r1: NO, 2 finding(s)'))).toBe(true)
  expect((await $.command.run(typed('status'))).text).toContain(`- Review A r1: NO, 2 finding(s). ${FILE}`)
  // the next one is r2
  expect((await $.command.run(typed('review --run r1 --part A --base HEAD~3'))).text).toContain('review-A-r2.md')
})

test('no verdict on the first line, a failed or empty run: no result, never OK, each with why', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  await reviewSays(w, 'Looks fine overall.\n')
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', noResult: true, reason: 'the first line carries no verdict (OK/NO/BLOCKED)' })
  await $.command.run(typed('review --run r1 --part A --base main'))
  await reviewSays(w, { stdout: 'Error: not logged in', code: 1 })
  expect(reviewsOf(w)[1]).toMatchObject({ verdict: 'none', noResult: true, reason: 'the reviewer could not finish: exit 1: Error: not logged in' })
  expect(w.files[`${RUN}\\review-A-r2.md`]).toBe(undefined)
  await $.command.run(typed('review --run r1 --part A --base main'))
  await reviewSays(w, { stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '', num_turns: 40 }), code: 0 })
  expect(reviewsOf(w)[2]).toMatchObject({ verdict: 'none', noResult: true, reason: 'the reviewer could not finish: it used up its turns before it answered' })
  // the numbers stay taken though no file was written
  expect((await $.command.run(typed('review --run r1 --part A --base main'))).text).toContain('review-A-r4.md')
})

test('Phase 4 criterion 2, moved to Phase 3: a review past 20 minutes is cut and could not finish, never OK', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  await w.clock.advance(19 * 60_000)
  expect(reviewsOf(w)[0]?.finishedAt).toBe(undefined)
  await w.clock.advance(60_000)
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', noResult: true, settledBy: 'answer', reason: 'the reviewer could not finish: cut after 20 minutes' })
  expect(w.files[FILE]).toBe(undefined)
  // what it says after the cut changes nothing
  await reviewSays(w, 'Verdict: OK\n')
  expect(reviewsOf(w)[0]?.verdict).toBe('none')
})

test('a Write or an rm -rf the reviewer tried: refused by its flags, and kept with the review as denials', async ($, on) => {
  const w = world(on)
  await $.command.run(typed('review --run r1 --part A --base main'))
  await w.clock.settle()
  const argv = w.spawns[0]?.argv ?? []
  for (const tool of ['Write', 'Edit', 'Bash', 'Bash(rm:*)']) expect(argv.includes(tool)).toBe(false)
  await reviewSays(w, { result: 'Verdict: OK\n\nNothing blocks part A.\n', denials: [{ tool_name: 'Write', tool_input: { file_path: 'src/sum.js' } }, { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } }] })
  expect(reviewsOf(w)[0]?.run?.denials).toEqual(['Write {"file_path":"src/sum.js"}', 'Bash {"command":"rm -rf node_modules"}'])
  expect(reviewsOf(w)[0]?.verdict).toBe('OK')
})

test('the critic and --deep are gone: each says what replaces it', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(typed('critic --run r1 --part A --base main'))).text).toContain('The critic is gone in 0.2')
  expect((await $.command.run(typed('review --run r1 --part A --base main --deep'))).text).toBe('--deep is gone in 0.2: /foreman review starts one fresh reviewer.')
  expect(w.spawns.length).toBe(0)
})

test('review refuses unsafe names and refs, and a second one of the same part while one runs', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(typed('review --run .. --base main'))).text).toContain('--run takes')
  expect((await $.command.run(typed('review --run r1 --base "--output=x"'))).text).toContain('is not a git ref')
  await $.command.run(typed('review --run r1 --part A --base main'))
  expect((await $.command.run(typed('review --run r1 --part A --base main'))).text).toContain('still running')
  expect(w.spawns.length).toBe(1)
})

/** A review an earlier load of foreman started: its process ended with that load. */
const left = (owner: string): ForemanReview => ({ kind: 'review', runId: 'r1', part: 'A', n: 1, file: FILE, agentId: 'process:foreman:r1:reviewer-A:r1', owner, startedAt: iso(NOW_MS - 60_000), verdict: 'none', findings: 0, base: 'main' })

test('a review whose process ended with a reload is settled at the next start, without a verdict and with why', async ($, on) => {
  const w = world(on)
  w.store['v2:reviews:c:/demo'] = [left('sess-me')]
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', noResult: true, settledBy: 'file', reason: 'the reviewer\'s process ended before it answered (foreman was reloaded, or its chat closed)' })
})

test('C3-03: a review another live session owns is left alone; one that wrote its file before the reload keeps its verdict', async ($, on) => {
  const w = world(on)
  w.store['v2:reviews:c:/demo'] = [left('sess-A')]
  w.sessions = [{ sessionId: 'sess-A', pid: 11 }, { sessionId: 'sess-me', pid: 12 }]
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]?.finishedAt).toBe(undefined)
  // its owner is gone; foreman had written the answer before the reload: the verdict there stands
  w.sessions = [{ sessionId: 'sess-me', pid: 12 }]
  w.files[FILE] = 'Verdict: OK\n\nNothing blocks part A.\n'
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'OK', findings: 0, settledBy: 'file' })
  expect(reviewsOf(w)[0]?.noResult).toBe(undefined)
})

test('C3-03: an orphan another chat settled gives way to the answer of the process that was still running', async ($, on) => {
  const w = world(on)
  w.me = 'sess-A'
  await $.command.run(typed('review --run r1 --part A --base main'))
  // chat B starts while A is gone from the list: it settles the review as an orphan
  w.me = 'sess-B'
  await $.session.start({ cwd: 'C:\\demo', surface: 'terminal', isInteractive: true })
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'none', settledBy: 'file', noResult: true })
  // A's process answers after all: its answer is the review
  await reviewSays(w, 'Verdict: NO\n### C-01 · P1 · src/sum.js:4 · off by one\n')
  expect(reviewsOf(w)[0]).toMatchObject({ verdict: 'NO', findings: 1, settledBy: 'answer' })
  expect(reviewsOf(w)[0]?.noResult).toBe(undefined)
  expect(reviewsOf(w)[0]?.reason).toBe(undefined)
})
