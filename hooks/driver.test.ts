// The background driver (D-69, D-85), pure: argv, rows by session id, the end
// of a turn in the background and in the app, transcripts under a worktree;
// with the preflight's trust reading (M3), the model's tool input (M2), and a
// plan heading that only mentions a stop (review O-1). Fixtures are rows and
// transcript lines of real sessions (2.1.295 app, 2.1.296 CLI), cut to the
// fields foreman reads and with paths and ids anonymised.
import { describe, expect, test } from 'claude-code/testing'
import type { ForemanAgentRow, ForemanThread } from '../types'
import {
  ALLOW_MAX_CHARS, FOREMAN_ALLOW, OPEN_EXE_ENV, OPEN_ID_ENV, STARTING_MS, background, inheritedAllow, isBusy, isTurnOver, launchArgv, openCommand, openPlan, rowOf, sendPlan, transcriptCandidates,
} from './lib/drivers/background'
import { parsePlan } from './lib/plan'
import { preflightMessage, trustOf } from './lib/preflight'
import { busyIds, syncThread } from './lib/threads'
import { TELL_SUFFIX, tellSuffix } from './lib/roles'
import { goArgs } from './lib/tools'
import { readTranscript } from './lib/transcript'

const SID = 'f5abdb33-763a-4ba6-a8b9-85e66d4a9447'
const NOW = Date.parse('2026-10-16T16:50:00.000Z')
const T: ForemanThread = { id: 'f5abdb33', sessionId: SID, name: 'foreman:plan:implementer-A', role: 'implementer', runId: 'plan', part: 'A', cwd: 'C:\\repos\\lab', model: 'haiku', effort: 'low', startedAt: '2026-10-16T16:46:17.000Z', updatedAt: '2026-10-16T16:46:17.000Z', sentAt: '2026-10-16T16:46:17.000Z', state: 'working' }

// `claude agents --json --all`, as printed (F0-4, F0-5, the Phase 2 probe)
const BG_STARTING: ForemanAgentRow = { id: 'f5abdb33', cwd: 'C:\\repos\\lab', kind: 'background', startedAt: Date.parse('2026-10-16T16:46:17.097Z'), sessionId: SID, name: 'foreman:plan:implementer-A', state: 'working' }
const BG_DONE: ForemanAgentRow = { pid: 93224, id: 'f5abdb33', cwd: 'C:\\repos\\lab', kind: 'background', startedAt: Date.parse('2026-10-16T16:46:20.959Z'), sessionId: SID, name: 'foreman:plan:implementer-A', status: 'idle', state: 'done' }
const BG_BLOCKED: ForemanAgentRow = { ...BG_DONE, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }
const BG_AFTER_OPEN: ForemanAgentRow = { id: 'f5abdb33', cwd: 'C:\\repos\\lab', kind: 'background', startedAt: BG_DONE.startedAt, sessionId: SID, name: 'foreman:plan:implementer-A', state: 'stopped' }
const APP_IDLE: ForemanAgentRow = { pid: 157872, cwd: 'C:\\repos\\lab', kind: 'interactive', startedAt: Date.parse('2026-10-16T16:48:00.000Z'), sessionId: SID, name: 'foreman:plan:implementer-A', status: 'idle' }
const APP_BUSY: ForemanAgentRow = { ...APP_IDLE, status: 'busy' }
const OTHER_APP: ForemanAgentRow = { pid: 1, cwd: 'C:\\repos\\lab', kind: 'interactive', startedAt: 0, sessionId: '0096aec5-0000-4000-8000-000000000000', name: 'Hola', status: 'idle' }

const line = (o: Record<string, unknown>) => JSON.stringify(o)
// a `claude --bg` turn: the prompt, the answer, then turn_duration (the probe f5abdb33)
const BG_TURN = [
  line({ type: 'last-prompt', leafUuid: 'u0', sessionId: SID }),
  line({ type: 'user', timestamp: '2026-10-16T16:46:21.379Z', promptSource: 'cli', message: { role: 'user', content: 'Reply with the single word PONG and nothing else.' } }),
  line({ type: 'attachment', timestamp: '2026-10-16T16:46:21.377Z', attachment: { type: 'skill_listing' } }),
  line({ type: 'assistant', timestamp: '2026-10-16T16:46:23.633Z', message: { id: 'msg_011C', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  line({ type: 'system', subtype: 'turn_duration', durationMs: 3808, timestamp: '2026-10-16T16:46:25.187Z' }),
  line({ type: 'cost-state', sessionId: SID }),
].join('\n')
// a turn in the desktop app: end_turn and a stop_hook_summary, no turn_duration (F0-5; this session counts 6 / 6 / 0)
const APP_TURN = [
  line({ type: 'user', timestamp: '2026-10-16T16:48:10.000Z', message: { role: 'user', content: 'npm test asked for permission; go on' } }),
  line({ type: 'assistant', timestamp: '2026-10-16T16:48:12.000Z', message: { id: 'msg_01A', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
  line({ type: 'user', timestamp: '2026-10-16T16:48:14.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'pass 5 fail 0' }] } }),
  line({ type: 'assistant', timestamp: '2026-10-16T16:48:16.000Z', message: { id: 'msg_01B', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tests pass.\n\n```foreman-result\n{"status":"done","summary":"tests pass"}\n```' }] } }),
  line({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, preventedContinuation: false, timestamp: '2026-10-16T16:48:16.050Z' }),
].join('\n')
const APP_MID_TURN = APP_TURN.split('\n').slice(0, 2).join('\n')

describe('the background driver: argv (D-69)', () => {
  test('launch carries the marker, Claude Code\'s worktree off and the inherited permissions in --settings (M7)', async () => {
    const allow = inheritedAllow(['Bash(npm test)', 'Bash(npm test)', 3, ''], ['npm run lint'])
    expect(allow).toEqual(['Bash(npm test)', ...FOREMAN_ALLOW, 'Bash(npm run lint)'])
    const argv = launchArgv({ exe: 'claude', name: 'foreman:plan:implementer-A', model: 'opus', effort: 'high', permissionMode: 'auto', brief: 'Read and follow the brief', allow })
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '')).toEqual({ worktree: { bgIsolation: 'none' }, env: { FOREMAN_THREAD: 'foreman:plan:implementer-A' }, permissions: { allow } })
    expect(argv.at(-1)).toBe('Read and follow the brief')
    // a repo with a huge allow list does not blow the command line
    const many = inheritedAllow(Array.from({ length: 2000 }, (_, i) => `Bash(tool-${i}:*)`), [])
    expect(many.join('   ').length).toBeLessThanOrEqual(ALLOW_MAX_CHARS)
    expect(background.resumeArgv('claude', SID, 'hi')).toEqual(['claude', '--bg', '--resume', SID, 'hi'])
    expect(background.stopArgv('claude', 'f5abdb33')).toEqual(['claude', 'stop', 'f5abdb33'])
  })
  test('Open: on Windows Start-Process with the executable and the id read from the environment; elsewhere --desktop --resume, not waited for', async () => {
    const win = openCommand('C:\\tools\\claude.exe', SID, true)
    expect(win?.argv).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath $env:${OPEN_EXE_ENV} -ArgumentList '--desktop','--resume',$env:${OPEN_ID_ENV} -WindowStyle Hidden`])
    expect(win?.env).toEqual({ FOREMAN_OPEN_EXE: 'C:\\tools\\claude.exe', FOREMAN_OPEN_ID: SID })
    expect(win?.wait).toBe(true)
    expect(openCommand('claude', SID, false)).toEqual({ argv: ['claude', '--desktop', '--resume', SID], wait: false })
    // nothing but a session id reaches the command
    expect(openCommand('claude', "x'; Remove-Item C:\\ -Recurse; '", true)).toBe(undefined)
    expect(openCommand('claude', 'f5abdb33', true)).toBe(undefined)
  })
  test('Open stops a live background process first (the app adopts no live one), never cuts a turn, and opens the rest as they are', async () => {
    expect(openPlan(BG_BLOCKED)).toEqual({ steps: ['stop', 'open'] })
    expect(openPlan(BG_DONE)).toEqual({ steps: ['stop', 'open'] })
    expect(openPlan({ ...BG_DONE, status: 'busy', state: 'working' })).toEqual({ refuse: 'the thread is working, and Open would cut its turn: wait until it stops or asks' })
    expect(openPlan(BG_AFTER_OPEN)).toEqual({ steps: ['open'] })
    expect(openPlan(APP_IDLE)).toEqual({ steps: ['open'] })
    expect(openPlan(undefined)).toEqual({ steps: ['open'] })
  })
  test('a message to a thread open in the app is a resume alone (no `claude stop` of an app session); refused while it works there', async () => {
    expect(sendPlan(APP_IDLE)).toEqual({ steps: ['resume'] })
    expect(sendPlan(APP_BUSY)).toEqual({ refuse: 'the thread is working; wait until it stops, or stop it first' })
    expect(sendPlan(BG_BLOCKED)).toEqual({ steps: ['stop', 'resume'] })
  })
})

describe('the background driver: rows and turns (A-08, F0-5)', () => {
  test('the row by session id: the app\'s live row once Open put it there, else the background one; never another session\'s', async () => {
    expect(rowOf(T, [OTHER_APP, BG_DONE])).toBe(BG_DONE)
    expect(rowOf(T, [BG_AFTER_OPEN, OTHER_APP, APP_IDLE])).toBe(APP_IDLE)
    expect(rowOf({ ...T, sessionId: '' }, [BG_STARTING])).toBe(BG_STARTING)
    expect(rowOf(T, [OTHER_APP])).toBe(undefined)
  })
  test('busy: live mid-turn or asking; a row with no pid yet is starting for its first minutes, then it is not', async () => {
    expect(isBusy(BG_STARTING, BG_STARTING.startedAt + 20_000)).toBe(true)
    expect(isBusy(BG_STARTING, BG_STARTING.startedAt + STARTING_MS + 1)).toBe(false)
    expect(isBusy(BG_DONE, NOW)).toBe(false)
    expect(isBusy(BG_BLOCKED, NOW)).toBe(true)
    expect(isBusy(APP_BUSY, NOW)).toBe(true)
    expect(isBusy(APP_IDLE, NOW)).toBe(false)
    // the limit on parallel threads counts a thread the app runs, found by its session id (criterion 1)
    expect(busyIds([{ ...T, state: 'working' }], [BG_AFTER_OPEN, APP_BUSY, OTHER_APP], NOW)).toEqual(['f5abdb33'])
    expect(busyIds([{ ...T, state: 'working' }], [BG_AFTER_OPEN, APP_IDLE], NOW)).toEqual([])
  })
  test('a background turn ends with turn_duration; an app turn with end_turn while the row is idle', async () => {
    const bg = readTranscript(BG_TURN, { isTail: false })
    expect(bg).toMatchObject({ turnEnded: true, endTurn: true, lastText: 'PONG' })
    expect(isTurnOver(T, BG_DONE, bg)).toBe(true)
    expect(isTurnOver(T, { ...BG_DONE, status: 'busy', state: 'working' }, bg)).toBe(false)
    const app = readTranscript(APP_TURN, { isTail: false })
    expect(app).toMatchObject({ turnEnded: false, endTurn: true })
    expect(isTurnOver(T, APP_IDLE, app)).toBe(true)
    expect(isTurnOver(T, APP_BUSY, app)).toBe(false)
    // the background rule alone would never see the app's turn end
    expect(isTurnOver(T, BG_AFTER_OPEN, app)).toBe(false)
    const mid = readTranscript(APP_MID_TURN, { isTail: false })
    expect(mid.endTurn).toBe(false)
    expect(isTurnOver(T, APP_IDLE, mid)).toBe(false)
  })
  test('sync through the app\'s row: working while busy, a dialog there is blocked, its turn\'s result read like any other', async () => {
    const nowIso = '2026-10-16T16:50:00.000Z'
    expect(syncThread(T, APP_BUSY, undefined, nowIso).thread.state).toBe('working')
    expect(syncThread(T, { ...APP_IDLE, status: 'waiting' }, undefined, nowIso).thread).toMatchObject({ state: 'blocked', waitingFor: 'a dialog in the app' })
    const done = syncThread({ ...T, openedAt: '2026-10-16T16:47:00.000Z' }, APP_IDLE, readTranscript(APP_TURN, { isTail: false }), nowIso)
    expect(done.thread).toMatchObject({ state: 'ready', lastResult: { status: 'done', summary: 'tests pass' } })
  })
  test('a background row with no pid that still says working: starting in its first minutes, a process that ended mid-turn after', async () => {
    expect(syncThread(T, BG_STARTING, undefined, new Date(BG_STARTING.startedAt + 20_000).toISOString()).thread.state).toBe('working')
    expect(syncThread(T, BG_STARTING, undefined, new Date(BG_STARTING.startedAt + STARTING_MS + 1).toISOString()).thread).toMatchObject({ state: 'stopped', waitingFor: 'its process ended mid-turn' })
  })
  test('a process that went after its turn ended: its result is read; with no turn end after the last prompt: stopped mid-turn (D-100)', async () => {
    const nowIso = '2026-10-16T16:50:00.000Z'
    const t = { ...T, sentAt: '2026-10-16T16:46:21.000Z' }
    const finished = syncThread(t, BG_AFTER_OPEN, readTranscript(BG_TURN, { isTail: false }), nowIso).thread
    expect(finished).toMatchObject({ state: 'waiting', noResult: true, waitingFor: 'no foreman-result' })
    const cut = syncThread(t, BG_AFTER_OPEN, readTranscript(BG_TURN.split('\n').slice(0, 3).join('\n'), { isTail: false }), nowIso).thread
    expect(cut).toMatchObject({ state: 'stopped', waitingFor: 'its process ended mid-turn' })
    // a session gone from the list is not "mid-turn": nothing says its process is what went
    expect(syncThread(t, undefined, undefined, nowIso).thread).toMatchObject({ state: 'stopped', waitingFor: 'its session is gone from claude agents' })
  })
  test('a background turn that ends on a question: the CLI marks the row blocked, waiting for input, and the result is still read (seen live, Phase 2)', async () => {
    // the job's timeline said `blocked`, "paused on even-length median…", as soon as the turn ended
    const row: ForemanAgentRow = { ...BG_DONE, status: 'waiting', waitingFor: 'input', state: 'blocked' }
    const asked = BG_TURN.replace('"text":"PONG"', '"text":"Which one?\\n\\n```foreman-result\\n{\\"status\\":\\"question\\",\\"summary\\":\\"s\\",\\"question\\":\\"Mean of the two middle values, or the lower one?\\"}\\n```"')
    const t = { ...T, sentAt: '2026-10-16T16:46:21.000Z' }
    expect(syncThread(t, row, readTranscript(asked, { isTail: false }), '2026-10-16T16:50:00.000Z').thread).toMatchObject({ state: 'waiting', waitingFor: 'Mean of the two middle values, or the lower one?', lastResult: { status: 'question' } })
    // between a Reply's stop and its resume the row keeps `blocked` with no pid: still the question, nothing to announce (round 2)
    const { pid: _pid, ...stoppedAsking } = row
    expect(syncThread(t, stoppedAsking, readTranscript(asked, { isTail: false }), '2026-10-16T16:50:00.000Z').thread).toMatchObject({ state: 'waiting', lastResult: { status: 'question' } })
    // a permission dialog is mid-turn: no turn end after the prompt, the thread is blocked
    expect(syncThread(t, BG_BLOCKED, readTranscript(BG_TURN.split('\n').slice(0, 3).join('\n'), { isTail: false }), '2026-10-16T16:50:00.000Z').thread).toMatchObject({ state: 'blocked', waitingFor: 'permission prompt' })
  })
  test('the transcript of a thread in a worktree lives in the worktree\'s own project folder: the row\'s cwd first (D-88)', async () => {
    const row: ForemanAgentRow = { ...BG_DONE, cwd: 'C:\\repos\\lab\\.claude\\worktrees\\foreman-plan' }
    expect(transcriptCandidates('C:\\home\\.claude\\projects', T, row)).toEqual([
      `C:\\home\\.claude\\projects\\C--repos-lab--claude-worktrees-foreman-plan\\${SID}.jsonl`,
      `C:\\home\\.claude\\projects\\C--repos-lab\\${SID}.jsonl`,
    ])
    expect(transcriptCandidates('C:\\home\\.claude\\projects', { ...T, sessionId: '' }, row)).toEqual([])
  })
})

describe('preflight and tools (M3, M2)', () => {
  test('trust: the folder or a folder above it accepted; untrusted otherwise; unknown when the config cannot be read', async () => {
    const config = JSON.stringify({ projects: { 'C:/repos': { hasTrustDialogAccepted: true }, 'C:/repos/lab/sub': { hasTrustDialogAccepted: false }, 'D:/x': {} } })
    expect(trustOf(config, 'C:\\repos\\lab\\sub')).toBe('trusted')
    expect(trustOf(config, 'C:\\Repos\\Lab')).toBe('trusted')
    expect(trustOf(config, 'D:\\x')).toBe('untrusted')
    expect(trustOf(undefined, 'C:\\repos')).toBe('unknown')
    expect(trustOf('{ not json', 'C:\\repos')).toBe('unknown')
    expect(preflightMessage({ problems: [], notes: ['x'] }, 'p.md')).toBe(undefined)
    expect(preflightMessage({ problems: ['a', 'b'], notes: [] }, 'p.md')).toBe('Not started: /foreman go p.md needs\n- a\n- b')
  })
  test('the go tool\'s input becomes a command line with every value quoted; no value passes for a flag', async () => {
    expect(goArgs({ plan: 'docs/my plan.md', mode: 'review', parts: 'A,B' })).toBe('go "docs/my plan.md" --mode "review" --parts "A,B"')
    expect(goArgs({ plan: 'docs\\plan.md', model: 'sonnet' })).toBe('go "docs\\plan.md" --model "sonnet"')
    expect(goArgs({})).toEqual({ error: 'Name the plan file (plan).' })
    expect(goArgs({ plan: 'p.md', parts: '--yes' })).toEqual({ error: 'parts cannot start with "-".' })
  })
})

describe('messages to a thread', () => {
  test('a Reply, a tell or an apply ends with a short re-brief: the part, the plan, the brief and the notes, then the rules', async () => {
    expect(tellSuffix({ part: 'A', plan: 'docs/plan.md', brief: 'B.md', progress: 'P.md' })).toBe(`(you work on part A of the plan \`docs/plan.md\`; your brief is \`B.md\`; foreman's notes are in \`P.md\`.)\n${TELL_SUFFIX}`)
    expect(tellSuffix({})).toBe(TELL_SUFFIX)
  })
})

describe('plan headings (review O-1)', () => {
  test('a heading that only mentions a stop is not a pause; one that starts with the word, or a segment of it, is', async () => {
    const plan = (between: string) => parsePlan(`# P\n\n## Part A\nDo A.\n\n${between}\nText.\n\n## Part B\nDo B.\n`, 'p.md').parts[1]?.pauseBefore === true
    expect(plan('## Reglas de parada')).toBe(false)
    expect(plan('## Los criterios y la pausa')).toBe(false)
    expect(plan('### Fase 2b — Stop the server first')).toBe(false)
    expect(plan('## 7. Pausa obligatoria')).toBe(true)
    expect(plan('## Revisión — pausa: el equipo mira A')).toBe(true)
    expect(plan('## Decisión humana')).toBe(true)
    expect(plan('## (pause) before B')).toBe(true)
  })
})
