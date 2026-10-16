// The `background` driver (D-69, D-85): a thread is a `claude --bg` session,
// known by its session id. It is watched through its `claude agents` row and
// its transcript, messaged by stop + `--bg --resume` (D-03), and put in the
// desktop app on demand with `claude --desktop --resume` (Open, F0-4).

import type { ForemanAgentRow, ForemanThread } from '../../../types'
import type { TranscriptFacts } from '../transcript'
import { transcriptPath } from '../transcript'
import type { DriverCommand, LaunchSpec, Steps, ThreadDriver } from './types'

/** The variable a thread's own Claude Code process carries: foreman loaded there runs in thread mode (D-51). */
export const THREAD_ENV = 'FOREMAN_THREAD'

/** The variables the Windows Open script reads, so no path or id is spliced into it (as the tail script, D-26). */
export const OPEN_EXE_ENV = 'FOREMAN_OPEN_EXE'
export const OPEN_ID_ENV = 'FOREMAN_OPEN_ID'

/**
 * What a thread may run without a dialog besides what the repo allows (M7):
 * reading, and the git commands a part needs to look and commit. The gates are
 * added one rule each. Nothing here widens what the repo's own rules deny.
 */
export const FOREMAN_ALLOW = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git rev-parse:*)'] as const

/** The inherited rules are cut at this many characters, so the launch's command line stays well under Windows' 32,767. */
export const ALLOW_MAX_CHARS = 8000

/** The repo's effective `permissions.allow` plus foreman's short list and one rule per gate, each once, cut to ALLOW_MAX_CHARS. */
export function inheritedAllow(repoAllow: unknown, gates: readonly string[]): string[] {
  const own = Array.isArray(repoAllow) ? repoAllow.filter((x): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= 500) : []
  const all = [...new Set([...own, ...FOREMAN_ALLOW, ...gates.filter(g => g.trim() !== '').map(g => `Bash(${g.trim()})`)])]
  const out: string[] = []
  let size = 0
  for (const rule of all) {
    size += rule.length + 3
    if (size > ALLOW_MAX_CHARS) break
    out.push(rule)
  }
  return out
}

/**
 * The settings a thread is launched with: Claude Code's own worktree off (the
 * thread works where foreman puts it, D-71), its thread-mode marker, and the
 * permissions it inherits (M7). A resume keeps them: the CLI saves them with the session.
 */
export function threadSettings(name: string, allow?: readonly string[]): string {
  return JSON.stringify({ worktree: { bgIsolation: 'none' }, env: { [THREAD_ENV]: name }, ...(allow && allow.length ? { permissions: { allow } } : {}) })
}

/** `claude --bg …`: the prompt is the positional argument (`--bg` refuses `-p`, SPIKE §1); `--session-id` is ignored with `--bg` (Phase 2 probe). */
export function launchArgv(s: LaunchSpec): string[] {
  const argv = [s.exe, '--bg', '--name', s.name, '--model', s.model, '--effort', s.effort, '--permission-mode', s.permissionMode]
  if (s.pluginDir) argv.push('--plugin-dir', s.pluginDir)
  argv.push('--settings', threadSettings(s.name, s.allow))
  argv.push(s.brief)
  return argv
}

/** `claude --bg --resume <sessionId> "<text>"`, no other flag: one would start a copy (SPIKE addendum). */
export function resumeArgv(exe: string, sessionId: string, text: string): string[] {
  return [exe, '--bg', '--resume', sessionId, text]
}

export const stopArgv = (exe: string, id: string) => [exe, 'stop', id]
export const logsArgv = (exe: string, id: string) => [exe, 'logs', id]

/** The short id `claude --bg` printed: `backgrounded · <id> · <name>`. */
export function parseLaunched(stdout: string): { id: string; isCopy: boolean } | undefined {
  const m = /backgrounded\s+·\s+([0-9a-f]{6,})/.exec(stdout)
  if (!m || !m[1]) return undefined
  return { id: m[1], isCopy: /started a copy as/.test(stdout) }
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Open (F0-4): on Windows `Start-Process claude --desktop --resume <id>`
 * through PowerShell, the executable and the id read from the environment
 * (`cmd /c start ""` loses its empty title and opens nothing); elsewhere
 * `claude --desktop --resume <id>` started and left to run.
 */
export function openCommand(exe: string, sessionId: string, isWindows: boolean): DriverCommand | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  if (!isWindows) return { argv: [exe, '--desktop', '--resume', sessionId], wait: false }
  const script = `Start-Process -FilePath $env:${OPEN_EXE_ENV} -ArgumentList '--desktop','--resume',$env:${OPEN_ID_ENV} -WindowStyle Hidden`
  return { argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env: { [OPEN_EXE_ENV]: exe, [OPEN_ID_ENV]: sessionId }, wait: true }
}

/**
 * What foreman sends a thread Open put in the app after cutting its pending
 * call (the stop that lets the app adopt it ends the call): the person should
 * not have to type to set it going again (Phase 2 acceptance, round 2).
 */
export const OPEN_RESUME_MESSAGE = 'foreman: your last tool call was cut when this thread was opened in the app. Check where you were (`git status`, the files you touched), run that call again, then go on with your part and end the turn with the foreman-result block.'

/** When to send it, after the app was asked to open the session: it takes a moment to exist there. */
export const OPEN_RESUME_DELAYS_MS = [3_000, 10_000, 30_000] as const

/** The app's id of a session Open put in its sidebar (F0-4): `local_` and the session id. */
export const appSessionId = (sessionId: string) => `local_${sessionId}`

const isLive = (row: ForemanAgentRow) => row.pid !== undefined
const isApp = (row: ForemanAgentRow) => row.kind === 'interactive'
const midTurn = (row: ForemanAgentRow) => row.state === 'working' || row.status === 'busy'
const asking = (row: ForemanAgentRow) => row.state === 'blocked' || row.status === 'waiting'

/** What a message to the thread takes: refused while it works; a stop first while its background process lives. */
export function sendPlan(row: ForemanAgentRow | undefined): Steps<'stop' | 'resume'> {
  if (row && isLive(row) && midTurn(row)) return { refuse: 'the thread is working; wait until it stops, or stop it first' }
  if (row && isApp(row)) return { steps: ['resume'] }
  return { steps: row && isLive(row) ? ['stop', 'resume'] : ['resume'] }
}

/**
 * What Open takes (F0-4): the app does not adopt a session whose background
 * process lives, so a live one is stopped first; a turn in progress is not cut.
 */
export function openPlan(row: ForemanAgentRow | undefined): Steps<'stop' | 'open'> {
  if (!row || !isLive(row) || isApp(row)) return { steps: ['open'] }
  if (midTurn(row)) return { refuse: 'the thread is working, and Open would cut its turn: wait until it stops or asks' }
  return { steps: ['stop', 'open'] }
}

/**
 * The thread's row: by session id, else by its short id. Once Open put the
 * thread in the app, the app's live (interactive) row comes first; the
 * background row, kept by the CLI, after it.
 */
export function rowOf(t: ForemanThread, rows: readonly ForemanAgentRow[]): ForemanAgentRow | undefined {
  const same = rows.filter(r => (t.sessionId !== '' && r.sessionId === t.sessionId) || (r.id !== undefined && r.id === t.id))
  return same.find(r => isApp(r) && isLive(r)) ?? same.find(r => r.kind === 'background') ?? same[0]
}

/** A background row without a pid that says `working` is a session starting up (seen for its first seconds) for this long. */
export const STARTING_MS = 2 * 60_000

export function isBusy(row: ForemanAgentRow, now: number): boolean {
  if (isLive(row)) return midTurn(row) || asking(row)
  return row.kind === 'background' && row.state === 'working' && now - row.startedAt < STARTING_MS
}

/**
 * Whether the turn foreman waits for is over: the session is not mid-turn, and
 * the transcript holds a prompt written at or after the thread's `sentAt` with a
 * turn end after it. A background turn ends with a `turn_duration` row; a turn
 * in the app (an opened thread the person answers there) writes none, so there
 * it is the last assistant row's `end_turn` with the row idle (F0-5, A-08). The
 * row alone cannot say: after a resume it keeps `done` from the previous turn (review C-01).
 */
export function isTurnOver(t: ForemanThread, row: ForemanAgentRow | undefined, facts: TranscriptFacts | undefined): boolean {
  if (!row || !facts) return false
  if (isApp(row)) {
    if (isLive(row) && row.status !== 'idle') return false
    if (!facts.endTurn) return false
  } else {
    if (row.state === 'working' || row.state === 'blocked' || row.state === 'failed' || row.status === 'busy' || row.status === 'waiting') return false
    if (!facts.turnEnded) return false
  }
  if (t.sentAt === undefined) return true
  return facts.promptAt !== undefined && facts.promptAt >= Date.parse(t.sentAt)
}

export function transcriptCandidates(projects: string, t: ForemanThread, row: ForemanAgentRow | undefined): string[] {
  if (!t.sessionId) return []
  const cwds = [row?.cwd, t.cwd].filter((c): c is string => typeof c === 'string' && c !== '')
  return [...new Set(cwds.map(cwd => transcriptPath(projects, cwd, t.sessionId)))]
}

export const background: ThreadDriver = {
  name: 'background',
  launchArgv,
  parseLaunched,
  resumeArgv,
  stopArgv,
  logsArgv,
  openCommand,
  sendPlan,
  openPlan,
  rowOf,
  isBusy,
  isTurnOver,
  transcriptCandidates,
}
