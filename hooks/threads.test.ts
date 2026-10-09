import { describe, expect, test } from 'claude-code/testing'
import type { ForemanAgentRow, ForemanThread } from '../types'
import { groupOf } from './lib/agents'
import { parseArgs, splitWords } from './lib/args'
import { ROLES, defaultProfile, isSafeId, parseProfile } from './lib/profile'
import { TELL_SUFFIX, checkSkills, composeBrief, fill } from './lib/roles'
import {
  busyIds, findThread, launchArgv, mergeThreads, parseLaunched, prune, resumeArgv, sendPlan, stripAnsi, syncThread, tailLines, threadName, trimResult, turnOver,
} from './lib/threads'
import { TAIL_PATH_ENV, encodeCwd, parseResultFence, readTranscript, tailArgv } from './lib/transcript'

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
    expect(parseResultFence(fence('{ "status": "done", ')).kind).toBe('invalid')
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
const u = (output: number) => ({ input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 })
// shaped like a real background transcript: one API message over several rows, each a little later (review C-06)
const TRANSCRIPT = [
  row({ type: 'custom-title', customTitle: 'foreman:spike' }),
  row({ type: 'user', timestamp: '2026-10-09T20:23:46.705Z', message: { role: 'user', content: 'escribe hola' } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:23:50.100Z', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }], usage: u(117) } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:23:51.300Z', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Write' }], usage: u(117) } }),
  row({ type: 'user', timestamp: '2026-10-09T20:23:52.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't' }] } }),
  row({ type: 'assistant', timestamp: '2026-10-09T20:24:10.000Z', message: { id: 'm2', content: [{ type: 'text', text: fence('{"status":"done","summary":"wrote it"}') }], usage: u(280) } }),
  row({ type: 'system', subtype: 'turn_duration', durationMs: 31224, timestamp: '2026-10-09T20:24:18.000Z' }),
]

describe('transcript', () => {
  test('encodes the cwd as the CLI does', async () => {
    expect(encodeCwd('C:\\MSG')).toBe('C--MSG')
    expect(encodeCwd('C:\\Users\\javi-\\source\\repos\\foreman\\.spike')).toBe('C--Users-javi--source-repos-foreman--spike')
  })
  test('last text, prompt time, turn ended, usage once per message id', async () => {
    const f = readTranscript(TRANSCRIPT.join('\n'), { isTail: false })
    expect(parseResultFence(f.lastText)).toEqual({ kind: 'ok', result: { status: 'done', summary: 'wrote it' } })
    expect(f.promptAt).toBe(Date.parse('2026-10-09T20:23:46.705Z'))
    expect(f.turnEnded).toBe(true)
    expect(f.usage).toEqual({ input: 4, output: 397, cacheRead: 2000, cacheWrite: 200, turns: 1 })
    expect(f.lastTs).toBe('2026-10-09T20:24:18.000Z')
    expect(f.lastId).toBe('m2')
    expect(readTranscript(TRANSCRIPT.join('\n'), { isTail: false, since: f.lastTs, lastId: f.lastId }).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })
  })
  test('C-06: a message split over rows read in two passes is counted once', async () => {
    const a = row({ type: 'assistant', timestamp: '2026-08-30T05:56:56.673Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: '' }], usage: u(1006) } })
    const b = row({ type: 'assistant', timestamp: '2026-08-30T05:56:57.380Z', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Read' }], usage: u(1006) } })
    const first = readTranscript(a, { isTail: false })
    const second = readTranscript([a, b].join('\n'), { isTail: false, since: first.lastTs, lastId: first.lastId })
    expect(first.usage.output + second.usage.output).toBe(1006)
    const all = TRANSCRIPT.join('\n')
    let since: string | undefined
    let lastId: string | undefined
    let output = 0
    for (let n = 1; n <= TRANSCRIPT.length; n++) {
      const f = readTranscript(TRANSCRIPT.slice(0, n).join('\n'), { isTail: false, since, lastId })
      output += f.usage.output
      since = f.lastTs
      lastId = f.lastId
    }
    expect(output).toBe(readTranscript(all, { isTail: false }).usage.output)
  })
  test('C-01: lastText is the current turn only; empty right after a new prompt', async () => {
    const f = readTranscript([...TRANSCRIPT, row({ type: 'user', timestamp: '2026-10-09T20:30:00.000Z', message: { content: 'next' } })].join('\n'), { isTail: false })
    expect(f.lastText).toBe('')
    expect(f.turnEnded).toBe(false)
    expect(f.promptAt).toBe(Date.parse('2026-10-09T20:30:00.000Z'))
  })
  test('a tail drops its cut first line and keeps going', async () => {
    expect(readTranscript(`{"type":"assi` + '\n' + TRANSCRIPT.join('\n'), { isTail: true }).usage.output).toBe(397)
  })
  test('C-08: the Windows tail takes its path from the environment, never from the script', async () => {
    expect(tailArgv('/h/x.jsonl', 10, false)).toEqual({ argv: ['tail', '-c', '10', '/h/x.jsonl'] })
    const path = "C:\\it's ’odd’\\x.jsonl"
    const w = tailArgv(path, 10, true)
    expect(w.argv[0]).toBe('powershell.exe')
    expect(w.argv.some(a => a.includes('odd'))).toBe(false)
    expect(w.argv.at(-1)).toContain(`$env:${TAIL_PATH_ENV}`)
    expect(w.env).toEqual({ [TAIL_PATH_ENV]: path })
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
  test('C-04: run ids and parts are safe file names; runsDir stays relative', async () => {
    for (const ok of ['r1', '20261006-fase2', 'A', 'a.b_c-d']) expect(isSafeId(ok)).toBe(true)
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', 'a..b', '', '-x', 'x'.repeat(65)]) expect(isSafeId(bad)).toBe(false)
    for (const bad of ['C:\\runs', '/abs', '\\abs', 'a/../b']) {
      const p = parseProfile(JSON.stringify({ runsDir: bad }))
      expect(p.profile.runsDir).toBe('.claude/runs')
      expect(p.warnings.length).toBe(1)
    }
  })
})

const T: ForemanThread = { id: 'aaaa0001', sessionId: 'aaaa0001-x', name: 'foreman:r1:implementer-A', role: 'implementer', runId: 'r1', part: 'A', cwd: 'C:\\r', model: 'opus', effort: 'high', startedAt: '2026-10-09T20:00:00.000Z', updatedAt: '2026-10-09T20:00:00.000Z', state: 'working' }
const R: ForemanAgentRow = { id: 'aaaa0001', sessionId: 'aaaa0001-x', cwd: 'C:\\r', kind: 'background', startedAt: 0, pid: 9 }
const NOW = '2026-10-09T20:10:00.000Z'
const facts = (text: string, extra: Partial<ReturnType<typeof readTranscript>> = {}) => ({ lastText: text, promptAt: Date.parse('2026-10-09T20:00:01.000Z'), turnEnded: true, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 }, lastTs: '2026-10-09T20:09:00.000Z', lastId: 'm9', limitHit: false, ...extra })

describe('sync: agents row + transcript -> thread state', () => {
  test('working stays working, usage adds up', async () => {
    const s = syncThread(T, { ...R, status: 'busy', state: 'working' }, facts(''), NOW)
    expect(s.thread.state).toBe('working')
    expect(s.thread.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 })
    expect(s.thread.usageSince).toBe('2026-10-09T20:09:00.000Z')
    expect(s.thread.usageLastId).toBe('m9')
  })
  test('done with a done block: ready for review (free: done)', async () => {
    const text = fence('{"status":"done","summary":"ok"}')
    const s = syncThread(T, { ...R, status: 'idle', state: 'done' }, facts(text), NOW)
    expect(s.thread.state).toBe('ready')
    expect(s.thread.lastResult?.summary).toBe('ok')
    expect(s.thread.updatedAt).toBe(NOW)
    expect(syncThread({ ...T, role: 'free' }, { ...R, state: 'done' }, facts(text), NOW).thread.state).toBe('done')
  })
  test('done without a block: waiting, noResult, never an invented done', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts('All good.'), NOW)
    expect(s.thread).toMatchObject({ state: 'waiting', noResult: true, waitingFor: 'no foreman-result' })
    expect(s.thread.lastResult).toBe(undefined)
  })
  test('done with a broken block: waiting, says why', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts(fence('{ "status": ')), NOW)
    expect(s.thread.state).toBe('waiting')
    expect(s.thread.waitingFor?.startsWith('invalid foreman-result: not JSON')).toBe(true)
  })
  test('question and blocked results wait for the user; failed fails', async () => {
    const q = fence('{"status":"question","summary":"s","question":"A or B?"}')
    expect(syncThread(T, { ...R, state: 'done' }, facts(q), NOW).thread).toMatchObject({ state: 'waiting', waitingFor: 'A or B?' })
    expect(syncThread(T, { ...R, state: 'done' }, facts(fence('{"status":"failed","summary":"build broke"}')), NOW).thread.state).toBe('failed')
  })
  test('a dialog: blocked with what it waits for; exited while blocked: stopped', async () => {
    expect(syncThread(T, { ...R, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }, undefined, NOW).thread).toMatchObject({ state: 'blocked', waitingFor: 'permission prompt' })
    const { pid: _p, ...exited } = R
    expect(syncThread(T, { ...exited, state: 'blocked' }, undefined, NOW).thread.state).toBe('stopped')
  })
  test('the session vanished while working: stopped; stopped by the CLI: stopped', async () => {
    expect(syncThread(T, undefined, undefined, NOW).thread.state).toBe('stopped')
    expect(syncThread(T, { ...R, state: 'stopped' }, undefined, NOW).thread.state).toBe('stopped')
  })
  test('C-03: the CLI says failed: the thread fails, with a reason, and frees its slot', async () => {
    const { pid: _p, ...exited } = R
    const s = syncThread(T, { ...exited, state: 'failed' }, undefined, NOW)
    expect(s.thread.state).toBe('failed')
    expect(s.thread.waitingFor).toContain('failed')
    expect(busyIds([s.thread], [{ ...exited, name: T.name, state: 'failed' }])).toEqual([])
  })
  test('a usage limit, from the API error row: limit, retried a minute after the reset', async () => {
    const resetsAt = Date.parse('2026-10-10T00:00:00.000Z')
    const s = syncThread(T, { ...R, state: 'done' }, facts("You've hit your session limit · resets 2am (Europe/Madrid)", { apiError: { kind: 'rate_limit', status: 429, resetsAt }, limitHit: true }), NOW)
    expect(s.thread).toMatchObject({ state: 'limit', retryAt: '2026-10-10T00:01:00.000Z' })
    expect(s.thread.waitingFor).toContain('usage limit')
  })
  test('another API error (401): failed, with the status', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts('Failed to authenticate.', { apiError: { kind: 'authentication_failed', status: 401 } }), NOW)
    expect(s.thread).toMatchObject({ state: 'failed', waitingFor: 'API error 401: authentication_failed' })
  })
  test('C-15: the model talking about rate limits is not a limit', async () => {
    const s = syncThread(T, { ...R, state: 'done' }, facts('Added rate limit middleware; usage limit reached errors now return 429.'), NOW)
    expect(s.thread).toMatchObject({ state: 'waiting', noResult: true })
  })
  test('the limit row in a real transcript shape is read structurally', async () => {
    const rows = [
      JSON.stringify({ type: 'user', timestamp: '2026-08-23T21:30:00.000Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-23T21:32:14.901Z', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { status: 'rejected', resetsAt: 1787529600, rateLimitType: 'five_hour' }, message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 2am (Europe/Madrid)" }] } }),
    ].join('\n')
    const f = readTranscript(rows, { isTail: false })
    expect(f.apiError).toEqual({ kind: 'rate_limit', status: 429, resetsAt: 1787529600000 })
    expect(f.limitHit).toBe(true)
    expect(readTranscript(rows.split('\n')[0] ?? '', { isTail: false }).apiError).toBe(undefined)
  })
  test('C-01: after a tell, a done row and the previous turn in the transcript keep it working', async () => {
    const told = { ...T, role: 'free' as const, sentAt: '2026-10-09T20:05:00.000Z' }
    const old = facts(fence('{"status":"done","summary":"OLD"}'))
    expect(turnOver(told, { ...R, status: 'idle', state: 'done' }, old)).toBe(false)
    const s = syncThread(told, { ...R, status: 'idle', state: 'done' }, old, NOW.replace('20:10', '20:05:02'))
    expect(s.thread.state).toBe('working')
    expect(s.thread.lastResult).toBe(undefined)
    // the new prompt and its answer land
    const fresh = facts(fence('{"status":"done","summary":"NEW"}'), { promptAt: Date.parse('2026-10-09T20:05:02.300Z') })
    const done = syncThread(told, { ...R, status: 'idle', state: 'done' }, fresh, NOW)
    expect(done.thread).toMatchObject({ state: 'done', lastResult: { status: 'done', summary: 'NEW' } })
  })
  test('C-01: a message that never reaches the transcript ends as waiting, not as a done', async () => {
    const told = { ...T, sentAt: '2026-10-09T20:00:30.000Z' }
    const s = syncThread(told, { ...R, status: 'idle', state: 'done' }, facts(fence('{"status":"done","summary":"OLD"}')), NOW)
    expect(s.thread.state).toBe('waiting')
    expect(s.thread.waitingFor).toContain('never reached')
  })
  test('done row but the turn has not ended: still working', async () => {
    expect(syncThread(T, { ...R, status: 'idle', state: 'done' }, facts('', { turnEnded: false }), NOW).thread.state).toBe('working')
  })
  test('nothing new: not changed', async () => {
    expect(syncThread(T, { ...R, status: 'busy', state: 'working' }, undefined, NOW).changed).toBe(false)
  })
  test('C-14: results are trimmed before they reach the registry', async () => {
    const long = 'x'.repeat(10_000)
    const r = trimResult({ status: 'question', summary: long, question: long, files: Array.from({ length: 200 }, (_, i) => `f${i}`) })
    expect(r.summary.length).toBe(2000)
    expect(r.question?.length).toBe(2000)
    expect(r.files?.length).toBe(50)
  })
})

describe('the shared registry', () => {
  const a = { ...T, id: 'aaaa0001', updatedAt: '2026-10-09T20:00:00.000Z' }
  const b = { ...T, id: 'bbbb0002', name: 'foreman:adhoc:free', updatedAt: '2026-10-09T20:01:00.000Z' }
  test('C-02: merging keeps every thread; the newer copy of one wins', async () => {
    expect(mergeThreads([a], [b]).map(t => t.id)).toEqual(['aaaa0001', 'bbbb0002'])
    const newer = { ...a, state: 'ready' as const, updatedAt: '2026-10-09T20:05:00.000Z' }
    expect(mergeThreads([newer], [a])[0]?.state).toBe('ready')
    expect(mergeThreads([a], [newer])[0]?.state).toBe('ready')
    const moreUsage = { ...a, usageSince: '2026-10-09T20:03:00.000Z' }
    expect(mergeThreads([moreUsage], [a])[0]?.usageSince).toBe('2026-10-09T20:03:00.000Z')
  })
  test('C-02: busy is what the CLI shows live under foreman names, from any chat', async () => {
    const live: ForemanAgentRow = { ...R, id: 'cccc0003', name: 'foreman:adhoc:free', status: 'busy', state: 'working' }
    const other: ForemanAgentRow = { ...R, id: 'dddd0004', name: 'my own chat', status: 'busy', state: 'working' }
    expect(busyIds([], [live, other])).toEqual(['cccc0003'])
    expect(busyIds([{ ...a, state: 'working' }], [])).toEqual(['aaaa0001'])
    expect(busyIds([{ ...a, state: 'working' }], [{ ...R, state: 'done', status: 'idle', name: a.name }])).toEqual([])
  })
  test('C-14: closed threads older than the window are pruned', async () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z')
    const list = [{ ...a, closed: true }, { ...b, closed: true, updatedAt: '2026-10-29T00:00:00.000Z' }, { ...T, id: 'eeee0005' }]
    expect(prune(list, now, 14 * 86_400_000).map(t => t.id)).toEqual(['bbbb0002', 'eeee0005'])
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

describe('panel groups', () => {
  test('C-03: failed has its own group; a blocked session that exited is not waiting for anyone', async () => {
    const base: ForemanAgentRow = { sessionId: 's', cwd: 'C:\\r', kind: 'background', startedAt: 0 }
    expect(groupOf({ ...base, state: 'failed' })).toBe('failed')
    expect(groupOf({ ...base, state: 'blocked' })).toBe('stopped')
    expect(groupOf({ ...base, pid: 1, status: 'waiting', state: 'blocked' })).toBe('waiting')
  })
})

describe('briefs', () => {
  test('placeholders: unset becomes -, empty disappears, common parts last', async () => {
    expect(fill('a {{x}} b {{y}} c', { y: '' })).toBe('a - b  c')
    const p = defaultProfile()
    p.roles.implementer.skills = ['msg-implement-plan']
    p.gates = { node: ['npm test'] }
    const brief = composeBrief('Do {{task}} of {{plan}} at {{level}} with {{skills}}; gates {{gates}}.\n\n{{extra}}', ['RULES', 'CONTRACT'], p, 'implementer', { task: 'X', level: 'N1' })
    expect(brief).toBe('Do X of - at N1 with msg-implement-plan; gates `npm test` (node).\n\nRULES\n\nCONTRACT\n')
  })
  test('C-05: every role\'s brief carries the no-push rule, and so does every tell', async () => {
    const rules = '## Rules for every foreman thread\n\n- No push, pull request, merge, tag or release unless this assignment says so in writing.'
    for (const role of ROLES) {
      expect(composeBrief('{{task}}', [rules, 'CONTRACT'], defaultProfile(), role, { task: 't' })).toContain('No push, pull request, merge')
    }
    expect(TELL_SUFFIX).toContain('no push, pull request or merge')
  })
  test('C-11: skills the session does not list are left out and reported', async () => {
    const known = new Set(['msg-implement-plan', 'engineering:debug', 'help'])
    expect(checkSkills(['msg-implement-plan', 'msg-run-state', 'debug'], known)).toEqual({ kept: ['msg-implement-plan', 'debug'], missing: ['msg-run-state'] })
    expect(checkSkills(['a'], undefined)).toEqual({ kept: ['a'], missing: [] })
    const p = defaultProfile()
    p.roles.implementer.skills = ['msg-implement-plan', 'msg-run-state']
    expect(composeBrief('{{skills}}', [], p, 'implementer', { task: 't', skills: ['msg-implement-plan'] })).toBe('msg-implement-plan\n\n\n')
  })
})
