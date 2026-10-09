import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { ForemanAgentRow, ForemanThread } from '../types'
import { parseArgs, splitWords } from './lib/args'
import { defaultProfile } from './lib/profile'
import { composeBrief, fill } from './lib/roles'
import { findThread, launchArgv, parseLaunched, resumeArgv, sendPlan, stripAnsi, syncThread, tailLines, threadName } from './lib/threads'
import { encodeCwd, parseResultFence, readTranscript, tailArgv } from './lib/transcript'

const fence = (body: string) => `Done.\n\n\`\`\`foreman-result\n${body}\n\`\`\``

describe('foreman-result fence', () => {
  test('a valid block', async () => {
    const r = parseResultFence(fence('{ "status": "done", "summary": "ok", "commits": ["3dfb3199"], "gates": [{"cmd":"npm test","exit":0}], "junk": 1 }'))
    expect(r).toEqual({ kind: 'ok', result: { status: 'done', summary: 'ok', commits: ['3dfb3199'], gates: [{ cmd: 'npm test', exit: 0 }] } })
  })
  test('no block', async () => {
    expect(parseResultFence('All done, files listed above.')).toEqual({ kind: 'none' })
  })
  test('broken JSON', async () => {
    const r = parseResultFence(fence('{ "status": "done", '))
    expect(r.kind).toBe('invalid')
  })
  test('bad status, missing summary', async () => {
    expect(parseResultFence(fence('{ "status": "great", "summary": "x" }')).kind).toBe('invalid')
    expect(parseResultFence(fence('{ "status": "done" }')).kind).toBe('invalid')
  })
  test('the last block wins', async () => {
    const r = parseResultFence(`${fence('{"status":"blocked","summary":"a"}')}\nthen\n${fence('{"status":"question","summary":"b","question":"which?"}')}`)
    expect(r).toEqual({ kind: 'ok', result: { status: 'question', summary: 'b', question: 'which?' } })
  })
})

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const TRANSCRIPT = [
  row({ type: 'custom-title', customTitle: 'foreman:spike' }),
  row({ type: 'user', timestamp: '2026-10-09T20:23:46Z', message: { role: 'user', content: 'escribe hola' } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:23:50Z', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }], usage: { input_tokens: 2, output_tokens: 117, cache_creation_input_tokens: 45299, cache_read_input_tokens: 0 } } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:23:50Z', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Write' }], usage: { input_tokens: 2, output_tokens: 117, cache_creation_input_tokens: 45299, cache_read_input_tokens: 0 } } }),
  row({ type: 'user', timestamp: '2026-10-09T20:23:51Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't' }] } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:24:10Z', message: { id: 'm2', content: [{ type: 'text', text: fence('{"status":"done","summary":"wrote it"}') }], usage: { input_tokens: 2, output_tokens: 280, cache_creation_input_tokens: 458, cache_read_input_tokens: 50728 } } }),
  row({ type: 'system', subtype: 'turn_duration', durationMs: 31224, timestamp: '2026-10-09T20:24:18Z' }),
].join('\n')

describe('transcript', () => {
  test('encodes the cwd as the CLI does', async () => {
    expect(encodeCwd('C:\\MSG')).toBe('C--MSG')
    expect(encodeCwd('C:\\Users\\javi-\\source\\repos\\foreman\\.spike')).toBe('C--Users-javi--source-repos-foreman--spike')
  })
  test('last text, turn ended, usage once per message id', async () => {
    const f = readTranscript(TRANSCRIPT, { isTail: false })
    expect(parseResultFence(f.lastText)).toEqual({ kind: 'ok', result: { status: 'done', summary: 'wrote it' } })
    expect(f.turnEnded).toBe(true)
    expect(f.usage).toEqual({ input: 4, output: 397, cacheRead: 50728, cacheWrite: 45757, turns: 1 })
    expect(f.lastTs).toBe('2026-10-09T20:24:18Z')
    // read again from where it stopped: nothing counted twice, the turn end included
    expect(readTranscript(TRANSCRIPT, { isTail: false, since: f.lastTs }).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })
    expect(f.limitHit).toBe(false)
  })
  test('since: only newer messages are counted', async () => {
    const f = readTranscript(TRANSCRIPT, { isTail: false, since: '2026-10-09T20:23:50Z' })
    expect(f.usage.output).toBe(280)
  })
  test('a tail drops its cut first line and keeps going', async () => {
    const f = readTranscript(`{"type":"assi` + '\n' + TRANSCRIPT, { isTail: true })
    expect(f.usage.output).toBe(397)
  })
  test('a turn that has not ended', async () => {
    const f = readTranscript(TRANSCRIPT + '\n' + row({ type: 'user', message: { content: 'next' } }), { isTail: false })
    expect(f.turnEnded).toBe(false)
  })
  test('tail argv per platform', async () => {
    expect(tailArgv('/h/x.jsonl', 10, false)).toEqual(['tail', '-c', '10', '/h/x.jsonl'])
    const w = tailArgv("C:\\it's\\x.jsonl", 10, true)
    expect(w[0]).toBe('powershell.exe')
    expect(w.at(-1)).toContain("'C:\\it''s\\x.jsonl'")
  })
})

describe('CLI argv and output', () => {
  test('launch: --bg, no -p, isolation off by settings, prompt last', async () => {
    const argv = launchArgv({ exe: 'claude', name: threadName('r1', 'implementer', 'A'), model: 'opus', effort: 'high', permissionMode: 'auto', isolation: 'none', brief: 'do it' })
    expect(argv).toEqual(['claude', '--bg', '--name', 'foreman:r1:implementer-A', '--model', 'opus', '--effort', 'high', '--permission-mode', 'auto', '--settings', '{"worktree":{"bgIsolation":"none"}}', 'do it'])
    expect(argv.includes('-p')).toBe(false)
    expect(launchArgv({ exe: 'claude', name: 'n', model: 'm', effort: 'e', permissionMode: 'auto', isolation: 'worktree', brief: 'b' }).includes('--settings')).toBe(false)
    expect(threadName(undefined, 'free', undefined)).toBe('foreman:adhoc:free')
  })
  test('resume carries no other flag', async () => {
    expect(resumeArgv('claude', 'sid', 'hi')).toEqual(['claude', '--bg', '--resume', 'sid', 'hi'])
  })
  test('parses the id the CLI printed', async () => {
    expect(parseLaunched('backgrounded · 638b3576 · foreman:spike\n  claude agents ...')).toEqual({ id: '638b3576', isCopy: false })
    expect(parseLaunched('note: session 638b3576 is already running in the background, so this started a copy as 628f2bbf.\nbackgrounded · 628f2bbf')).toEqual({ id: '628f2bbf', isCopy: true })
    expect(parseLaunched('Workspace not trusted.')).toBe(undefined)
  })
  test('send: refused while working; stop first while live; resume alone once exited', async () => {
    const base: ForemanAgentRow = { id: 'a', sessionId: 's', cwd: 'C:\\r', kind: 'background', startedAt: 0 }
    expect('refuse' in sendPlan({ ...base, pid: 1, status: 'busy', state: 'working' })).toBe(true)
    expect(sendPlan({ ...base, pid: 1, status: 'idle', state: 'done' })).toEqual({ steps: ['stop', 'resume'] })
    expect(sendPlan({ ...base, pid: 1, status: 'waiting', state: 'blocked' })).toEqual({ steps: ['stop', 'resume'] })
    expect(sendPlan({ ...base, state: 'done' })).toEqual({ steps: ['resume'] })
    expect(sendPlan(undefined)).toEqual({ steps: ['resume'] })
  })
  test('the screen dump loses its escapes', async () => {
    const raw = '\x1b[38;2;78;186;101m●\x1b[m \x1b[1m\x1b[97mWrite\x1b[m(spike.txt)\x1b[92X\x1b[48;2;38;38;38m\x1b[92C│\x1b[K\x1b[m\r\n\n   \nlast'
    expect(stripAnsi(raw).split('\n')[0]).toBe('● Write(spike.txt)│')
    expect(tailLines(raw, 1)).toEqual(['last'])
  })
  test('words and flags', async () => {
    expect(splitWords('launch free "lista los archivos de docs/plans" --part A')).toEqual(['launch', 'free', 'lista los archivos de docs/plans', '--part', 'A'])
    expect(parseArgs('launch implementer "fix it" --run r1 --level=N1')).toEqual({ positional: ['launch', 'implementer', 'fix it'], flags: { run: 'r1', level: 'N1' } })
  })
})

const T: ForemanThread = { id: 'aaaa0001', sessionId: 'aaaa0001-x', name: 'foreman:r1:implementer-A', role: 'implementer', runId: 'r1', part: 'A', cwd: 'C:\\r', model: 'opus', effort: 'high', startedAt: '2026-10-09T20:00:00Z', updatedAt: '2026-10-09T20:00:00Z', state: 'working' }
const R: ForemanAgentRow = { id: 'aaaa0001', sessionId: 'aaaa0001-x', cwd: 'C:\\r', kind: 'background', startedAt: 0, pid: 9 }
const NOW = '2026-10-09T20:10:00Z'
const facts = (text: string) => ({ lastText: text, turnEnded: true, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 }, lastTs: '2026-10-09T20:09:00Z', limitHit: false })

describe('sync: agents row + transcript -> thread state', () => {
  test('working stays working, usage adds up', async () => {
    const s = syncThread(T, { ...R, status: 'busy', state: 'working' }, facts(''), undefined, NOW)
    expect(s.thread.state).toBe('working')
    expect(s.thread.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 })
    expect(s.thread.usageSince).toBe('2026-10-09T20:09:00Z')
  })
  test('done with a done block: ready for review (free: done)', async () => {
    const text = fence('{"status":"done","summary":"ok"}')
    const s = syncThread(T, { ...R, status: 'idle', state: 'done' }, facts(text), parseResultFence(text), NOW)
    expect(s.thread.state).toBe('ready')
    expect(s.thread.lastResult?.summary).toBe('ok')
    expect(s.thread.updatedAt).toBe(NOW)
    expect(syncThread({ ...T, role: 'free' }, { ...R, state: 'done' }, facts(text), parseResultFence(text), NOW).thread.state).toBe('done')
  })
  test('done without a block: waiting, noResult, never an invented done', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts('All good.'), { kind: 'none' }, NOW)
    expect(s.thread.state).toBe('waiting')
    expect(s.thread.noResult).toBe(true)
    expect(s.thread.waitingFor).toBe('no foreman-result')
    expect(s.thread.lastResult).toBe(undefined)
  })
  test('done with a broken block: waiting, says why', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts(''), { kind: 'invalid', reason: 'not JSON: x' }, NOW)
    expect(s.thread.state).toBe('waiting')
    expect(s.thread.waitingFor).toBe('invalid foreman-result: not JSON: x')
  })
  test('question and blocked results wait for the user; failed fails', async () => {
    const q = fence('{"status":"question","summary":"s","question":"A or B?"}')
    expect(syncThread(T, { ...R, state: 'done' }, facts(q), parseResultFence(q), NOW).thread).toMatchObject({ state: 'waiting', waitingFor: 'A or B?' })
    const f = fence('{"status":"failed","summary":"build broke"}')
    expect(syncThread(T, { ...R, state: 'done' }, facts(f), parseResultFence(f), NOW).thread.state).toBe('failed')
  })
  test('a dialog: blocked with what it waits for', async () => {
    const s = syncThread(T, { ...R, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }, undefined, undefined, NOW)
    expect(s.thread).toMatchObject({ state: 'blocked', waitingFor: 'permission prompt' })
  })
  test('the session vanished while working: stopped; stopped by the CLI: stopped', async () => {
    expect(syncThread(T, undefined, undefined, undefined, NOW).thread.state).toBe('stopped')
    expect(syncThread(T, { ...R, state: 'stopped' }, undefined, undefined, NOW).thread.state).toBe('stopped')
  })
  test('a usage-limit answer: limit', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, { ...facts("You've hit your usage limit · resets 3am"), limitHit: true }, { kind: 'none' }, NOW)
    expect(s.thread).toMatchObject({ state: 'limit', waitingFor: 'usage limit' })
  })
  test('done row but no fence read yet (the new turn has not ended): still working', async () => {
    const s = syncThread(T, { ...R, status: 'idle', state: 'done' }, { ...facts(''), turnEnded: false }, undefined, NOW)
    expect(s.thread.state).toBe('working')
  })
  test('nothing new: not changed', async () => {
    const s = syncThread(T, { ...R, status: 'busy', state: 'working' }, undefined, undefined, NOW)
    expect(s.changed).toBe(false)
  })
})

describe('finding a thread', () => {
  const list = [T, { ...T, id: 'bbbb0002', sessionId: 'bbbb0002-y', name: 'foreman:adhoc:free' }]
  test('by id, number, name and suffix', async () => {
    expect(findThread(list, 'bbbb0002')).toEqual({ thread: list[1] })
    expect(findThread(list, '1')).toEqual({ thread: T })
    expect(findThread(list, 'implementer-A')).toEqual({ thread: T })
    expect(findThread(list, 'free')).toEqual({ thread: list[1] })
    expect('error' in findThread(list, 'zzz')).toBe(true)
    expect('error' in findThread(list, undefined)).toBe(true)
    expect(findThread([T], undefined)).toEqual({ thread: T })
  })
})

describe('briefs', () => {
  test('placeholders: unset becomes -, empty disappears, contract last', async () => {
    expect(fill('a {{x}} b {{y}} c', { y: '' })).toBe('a - b  c')
    const p = defaultProfile()
    p.roles.implementer.skills = ['msg-implement-plan']
    p.gates = { node: ['npm test'] }
    const brief = composeBrief('Do {{task}} of {{plan}} at {{level}} with {{skills}}; gates {{gates}}.\n\n{{extra}}', 'CONTRACT', p, 'implementer', { task: 'X', level: 'N1' })
    expect(brief).toBe('Do X of - at N1 with msg-implement-plan; gates `npm test` (node).\n\nCONTRACT\n')
  })
})

// ---------------------------------------------------------------- end to end with the CLI mocked

const NOW_MS = Date.parse('2026-10-09T21:00:00Z')

function cli(on: On, runs: string[][], agents: () => unknown[]) {
  mock.store(on)
  mock.clock(on, { now: NOW_MS })
  const files: Record<string, string> = {}
  on('session.repo', () => ({ value: { root: 'C:\\demo', remote: null, internal: false, name: null, id: 'demo' } }))
  on('session.cwd', () => ({ value: 'C:\\demo' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] as string } : e.path.includes('prompts') ? { value: e.path.endsWith('_result.md') ? 'END WITH foreman-result' : 'TASK: {{task}}' } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[1] === 'agents') return ok(JSON.stringify(agents()))
    if (e.argv[1] === '--bg' && e.argv[2] === '--resume') return ok('note: woke session aaaa0001 with its saved options\nbackgrounded · aaaa0001 · foreman:r1:free')
    if (e.argv[1] === '--bg') return ok('backgrounded · aaaa0001 · foreman:r1:free\n  claude agents  list sessions')
    if (e.argv[1] === 'stop') return ok('stopped aaaa0001')
    if (e.argv[1] === 'logs') return ok('\x1b[1mline one\x1b[m\n\nline two\n')
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return files
}

const typed = (args: string) => ({ command: 'foreman', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

test('launch -> status -> tell -> log -> stop -> close, against a mocked CLI', async ($, on) => {
  const runs: string[][] = []
  let state: Record<string, unknown> = { pid: 7, status: 'busy', state: 'working' }
  const files = cli(on, runs, () => [{ id: 'aaaa0001', sessionId: 'aaaa0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, name: 'foreman:r1:free', ...state }])

  const launched = await $.command.run(typed('launch free "lista los archivos de docs/plans" --run r1'))
  expect(launched.text).toContain('Launched foreman:r1:free as aaaa0001')
  const bg = runs.find(r => r[1] === '--bg')
  expect(bg?.slice(0, 4)).toEqual(['claude', '--bg', '--name', 'foreman:r1:free'])
  expect(bg?.at(-1)).toBe('TASK: lista los archivos de docs/plans\n\nEND WITH foreman-result\n')
  const runFile = Object.keys(files).find(p => p.replace(/\\/g, '/').endsWith('.claude/runs/r1/foreman.json'))
  expect(runFile).toBeDefined()
  expect(JSON.parse(files[runFile ?? ''] ?? '{}').transitions[0]).toMatchObject({ thread: 'aaaa0001', from: 'none', to: 'working', note: 'launched' })

  expect((await $.command.run(typed('status'))).text).toContain('| 1 | aaaa0001 | foreman:r1:free | free | Working |')
  expect((await $.command.run(typed('tell 1 "go on"'))).text).toContain('Not sent: the thread is working')

  state = { pid: 7, status: 'idle', state: 'done' }
  runs.length = 0
  const told = await $.command.run(typed('tell aaaa0001 "y ahora cuenta los archivos"'))
  expect(told.text).toContain('Sent to foreman:r1:free (aaaa0001)')
  expect(runs.map(r => r[1])).toEqual(['agents', 'stop', '--bg'])
  expect(runs[2]?.slice(0, 4)).toEqual(['claude', '--bg', '--resume', 'aaaa0001-s'])
  expect(runs[2]?.length).toBe(5)

  expect((await $.command.run(typed('log 1 5'))).text).toBe('```\nline one\nline two\n```')
  expect((await $.command.run(typed('open 1'))).text).toContain('claude attach aaaa0001')
  expect((await $.command.run(typed('stop 1'))).text).toContain('Stopped foreman:r1:free')
  expect((await $.command.run(typed('close 1'))).text).toContain('Closed foreman:r1:free')
  expect((await $.command.run(typed('status'))).text).toContain('No threads')
})

test('launch refuses past maxParallelThreads and on bad flags', async ($, on) => {
  const runs: string[][] = []
  cli(on, runs, () => [{ id: 'aaaa0001', sessionId: 'aaaa0001-s', cwd: 'C:\\demo', kind: 'background', startedAt: NOW_MS, pid: 7, status: 'busy', state: 'working' }])
  expect((await $.command.run(typed('launch wizard "x"'))).text).toContain('Name a role')
  expect((await $.command.run(typed('launch free "x" --level N7'))).text).toContain('--level is one of')
  expect((await $.command.run(typed('launch free "x" --model gpt'))).text).toContain('is not a model')
  expect((await $.command.run(typed('launch free "first"'))).text).toContain('Launched')
  expect((await $.command.run(typed('launch free "second"'))).text).toContain('maxParallelThreads is 1')
})
