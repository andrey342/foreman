// The registry of threads: a thread's state from one look at its row and its
// transcript (through the driver, drivers/background.ts), merging the copies
// every chat of the repo keeps, finding one by what the person typed, and the
// table /foreman status prints. Pure.

import type { ForemanAgentRow, ForemanRole, ForemanThread, ForemanThreadResult, ForemanThreadState } from '../../types'
import { STARTING_MS, background } from './drivers/background'
import type { FenceRead, TranscriptFacts } from './transcript'
import { addUsage, parseResultFence } from './transcript'

export function threadName(runId: string | undefined, role: ForemanRole, part: string | undefined): string {
  return `foreman:${runId ?? 'adhoc'}:${role}${part ? `-${part}` : ''}`
}

/** `foreman:<run>:<role>-<part>` back to its parts (thread mode reads its own name). */
export function parseThreadName(name: string): { runId?: string; role?: string; part?: string } {
  const m = /^foreman:([^:]+):([a-z]+)(?:-(.+))?$/.exec(name)
  if (!m) return {}
  return { ...(m[1] && m[1] !== 'adhoc' ? { runId: m[1] } : {}), ...(m[2] ? { role: m[2] } : {}), ...(m[3] ? { part: m[3] } : {}) }
}

export function stripAnsi(text: string): string {
  // CSI and OSC sequences, then the cursor-forward fill the screen dump uses
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '')
}

export function tailLines(text: string, n: number): string[] {
  return stripAnsi(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '').slice(-n)
}

export type Sync = { thread: ForemanThread; from: ForemanThreadState; changed: boolean }

/** How long a sent message may take to reach the transcript before the thread is shown as waiting. */
export const UNDELIVERED_MS = 3 * 60_000
/** Texts kept in the registry are cut to this (the store holds 4 MiB in all, D-27). */
export const TEXT_MAX = 2000

const cut = (s: string, n = TEXT_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A result as the registry keeps it: every text cut to TEXT_MAX, lists to 50 entries. */
export function trimResult(r: ForemanThreadResult): ForemanThreadResult {
  const out: ForemanThreadResult = { status: r.status, summary: cut(r.summary) }
  if (r.question !== undefined) out.question = cut(r.question)
  if (r.commits) out.commits = r.commits.slice(0, 50).map(c => cut(c, 100))
  if (r.files) out.files = r.files.slice(0, 50).map(f => cut(f, 300))
  if (r.gates) out.gates = r.gates.slice(0, 50).map(g => ({ cmd: cut(g.cmd, 300), exit: g.exit }))
  return out
}

/** The last line of the thread's latest answer worth showing: not blank, not inside the foreman-result block, cut to 160. */
export function lastLine(text: string): string | undefined {
  const body = text.replace(/```foreman-result[\s\S]*?(?:```|$)/g, '')
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !/^`{3}/.test(l))
  const last = lines.at(-1)
  return last === undefined ? undefined : last.length > 160 ? `${last.slice(0, 159)}…` : last
}

/** A usage limit is retried this long after its reset; with no reset in the row, after the fallback. */
export const LIMIT_SLACK_MS = 60_000
export const LIMIT_FALLBACK_MS = 30 * 60_000

/** The transcript's last prompt is the one foreman sent (or foreman sent none it waits for). */
function currentTurn(t: ForemanThread, facts: TranscriptFacts): boolean {
  return t.sentAt === undefined || (facts.promptAt !== undefined && facts.promptAt >= Date.parse(t.sentAt))
}

/** The message foreman sends a thread whose usage limit has reset. */
export const LIMIT_RESUME = 'The usage limit has reset. Go on where you stopped, and end your turn with the foreman-result block.'

/** Whether the turn foreman waits for is over (the driver's rule, drivers/background.ts). */
export const turnOver = background.isTurnOver

/** Why a thread is stopped when its process ended and its transcript has no turn end after the last prompt: what foreman revives (D-100). */
export const MID_TURN = 'its process ended mid-turn'

/** The transcript holds a turn end (either kind) after the prompt foreman sent: the turn finished before the process went. */
function endedSince(t: ForemanThread, facts: TranscriptFacts | undefined): boolean {
  if (!facts || !(facts.turnEnded || facts.endTurn)) return false
  return t.sentAt === undefined || (facts.promptAt !== undefined && facts.promptAt >= Date.parse(t.sentAt))
}

/** What one look at the row says, before the transcript is asked. */
type Seen = 'gone' | 'failed' | 'working' | 'asking' | 'exited-asking' | 'stopped' | 'died' | 'idle'

function seenOf(t: ForemanThread, row: ForemanAgentRow | undefined, now: number): Seen {
  if (!row) return 'gone'
  if (row.state === 'failed') return 'failed'
  const live = row.pid !== undefined
  if (row.kind === 'interactive') {
    // the thread opened in the app (Open, F0-4): the app's row has a status and no state
    if (live && row.status === 'busy') return 'working'
    if (live && row.status === 'waiting') return 'asking'
    return 'idle'
  }
  if (row.state === 'working' || row.status === 'busy') {
    if (live) return 'working'
    // a session's first seconds list it with no pid yet; past that, its process ended mid-turn
    const since = Math.max(row.startedAt, t.sentAt ? Date.parse(t.sentAt) : 0)
    return now - since < STARTING_MS ? 'working' : 'died'
  }
  if (row.state === 'blocked' || row.status === 'waiting') return live ? 'asking' : 'exited-asking'
  if (row.state === 'stopped') return 'stopped'
  return 'idle'
}

/**
 * The thread after one look at its row (found by the driver, by session id) and,
 * when read, its transcript. A turn that ended without a valid foreman-result is
 * `waiting` with `noResult`: never an invented done.
 */
export function syncThread(t: ForemanThread, row: ForemanAgentRow | undefined, facts: TranscriptFacts | undefined, nowIso: string): Sync {
  const from = t.state
  const next: ForemanThread = { ...t }
  if (facts) {
    next.usage = addUsage(t.usage, facts.usage)
    if (facts.lastTs) next.usageSince = facts.lastTs
    if (facts.lastId) next.usageLastId = facts.lastId
    const line = lastLine(facts.lastText)
    if (line !== undefined) next.lastLine = line
  }
  const now = Date.parse(nowIso)
  const seen0 = seenOf(t, row, now)
  // The turn ended, whatever the row says: a process that went after its turn, or a background
  // session the CLI marks `blocked`, waiting for `input`, because its turn ended on a question
  // (seen live, Phase 2: its foreman-result was never read). A dialog is mid-turn: no turn end.
  // A Reply's own stop shows that last case too: between its `claude stop` and its resume the row keeps
  // `blocked` with no pid, and a look then announced "exited while blocked" (round 2).
  const settled = (seen0 === 'stopped' || seen0 === 'died' || seen0 === 'asking' || seen0 === 'exited-asking') && endedSince(t, facts)
  const seen: Seen = settled ? 'idle' : seen0
  const over = turnOver(t, row, facts) || settled
  const fence: FenceRead | undefined = over && facts ? parseResultFence(facts.lastText) : undefined
  const undelivered = !over && seen === 'idle' && t.sentAt !== undefined &&
    (facts?.promptAt ?? 0) < Date.parse(t.sentAt) && now - Date.parse(t.sentAt) > UNDELIVERED_MS
  delete next.waitingFor
  if (seen === 'gone') {
    if (from === 'working' || from === 'blocked') {
      next.state = 'stopped'
      next.waitingFor = 'its session is gone from claude agents'
    }
  } else if (seen === 'failed') {
    next.state = 'failed'
    next.waitingFor = 'the session failed (claude agents: failed); see /foreman log, or launch again'
  } else if (seen === 'working') {
    next.state = 'working'
    delete next.noResult
  } else if (seen === 'asking') {
    next.state = 'blocked'
    next.waitingFor = cut(row?.waitingFor ?? (row?.kind === 'interactive' ? 'a dialog in the app' : 'input'), 300)
  } else if (seen === 'exited-asking') {
    next.state = 'stopped'
    next.waitingFor = 'exited while blocked'
  } else if (seen === 'stopped' || seen === 'died') {
    // its process went (a stop, the app closing) with no turn end after the last prompt
    next.state = 'stopped'
    next.waitingFor = MID_TURN
  } else if (facts?.apiError && currentTurn(t, facts)) {
    // the turn ended on an error row the CLI wrote (SPIKE addendum), never on the model's words (review C-15)
    const err = facts.apiError
    delete next.retryAt
    if (err.kind === 'rate_limit') {
      const at = err.resetsAt !== undefined ? err.resetsAt + LIMIT_SLACK_MS : now + LIMIT_FALLBACK_MS
      next.state = 'limit'
      next.retryAt = new Date(at).toISOString()
      next.waitingFor = `usage limit; foreman tells it to go on at ${next.retryAt}`
    } else {
      next.state = 'failed'
      next.waitingFor = `API error${err.status ? ` ${err.status}` : ''}: ${err.kind}`
    }
  } else if (undelivered) {
    next.state = 'waiting'
    next.waitingFor = 'the message never reached the thread; send it again'
  } else if (from === 'limit' && !fence) {
    // a limit is cleared by the retry's new turn, not by the session going idle
    if (t.waitingFor !== undefined) next.waitingFor = t.waitingFor
  } else if (fence) {
    if (fence.kind === 'ok') {
      next.lastResult = trimResult(fence.result)
      delete next.noResult
      const s = fence.result.status
      next.state = s === 'done' ? 'ready' : s === 'failed' ? 'failed' : 'waiting'
      if (s === 'question' || s === 'blocked') next.waitingFor = cut(fence.result.question ?? fence.result.summary, 300)
    } else {
      next.state = 'waiting'
      next.noResult = true
      next.waitingFor = fence.kind === 'invalid' ? cut(`invalid foreman-result: ${fence.reason}`, 300) : 'no foreman-result'
    }
  } else if (from !== 'working') {
    // nothing decided this look (no transcript yet): keep what stood
    if (t.waitingFor !== undefined) next.waitingFor = t.waitingFor
  }
  const changed = next.state !== from || next.waitingFor !== t.waitingFor || JSON.stringify(next.usage) !== JSON.stringify(t.usage) ||
    JSON.stringify(next.lastResult) !== JSON.stringify(t.lastResult) || next.usageLastId !== t.usageLastId || next.lastLine !== t.lastLine
  if (next.state !== from || next.waitingFor !== t.waitingFor) next.updatedAt = nowIso
  return { thread: next, from, changed }
}

/**
 * Threads that count against maxParallelThreads (D-20): each open thread of the
 * registry whose row (found by session id, so a thread opened in the app counts
 * too) is busy, or that was just launched and is not listed yet; plus foreman
 * threads of this repo another chat launched that this registry does not hold.
 */
export function busyIds(threads: readonly ForemanThread[], rows: readonly ForemanAgentRow[], now: number): string[] {
  const out = new Set<string>()
  for (const t of threads) {
    if (t.closed) continue
    const row = background.rowOf(t, rows)
    if (row ? background.isBusy(row, now) : t.state === 'working') out.add(t.id)
  }
  const known = new Set(threads.flatMap(t => [t.id, t.sessionId]).filter(Boolean))
  for (const r of rows) {
    if (r.kind !== 'background' || !(r.name ?? '').startsWith('foreman:') || known.has(r.sessionId) || (r.id !== undefined && known.has(r.id))) continue
    if (background.isBusy(r, now)) out.add(r.id ?? r.sessionId.slice(0, 8))
  }
  return [...out]
}

/** Keeps open threads, and closed ones younger than `keepMs` (D-27). */
export function prune(threads: readonly ForemanThread[], now: number, keepMs: number): ForemanThread[] {
  return threads.filter(t => !t.closed || now - Date.parse(t.updatedAt) < keepMs)
}

/** Merges two copies of the registry by id: the later `updatedAt` wins, then the later `usageSince`, then the second copy (D-25). */
export function mergeThreads(a: readonly ForemanThread[], b: readonly ForemanThread[]): ForemanThread[] {
  const out = new Map<string, ForemanThread>()
  for (const t of [...a, ...b]) {
    const cur = out.get(t.id)
    const key = (x: ForemanThread) => [Date.parse(x.updatedAt) || 0, Date.parse(x.usageSince ?? '') || 0]
    const [a1, a2] = cur ? key(cur) : [-1, -1]
    const [b1, b2] = key(t)
    if (!cur || b1! > a1! || (b1 === a1 && b2! >= a2!)) out.set(t.id, t)
  }
  return [...out.values()].sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))
}

/** Finds a thread by short id, session id prefix, exact name, name suffix or 1-based index. */
export function findThread(threads: readonly ForemanThread[], ref: string | undefined): { thread: ForemanThread } | { error: string } {
  const open = threads.filter(t => !t.closed)
  if (!ref) return open.length === 1 && open[0] ? { thread: open[0] } : { error: open.length ? 'name the thread: its id, name or number from /foreman status' : 'no threads yet: /foreman go <plan.md>' }
  if (/^\d{1,3}$/.test(ref)) {
    const t = open[Number(ref) - 1]
    return t ? { thread: t } : { error: `no thread #${ref}` }
  }
  const exact = threads.filter(t => t.id === ref || t.name === ref || t.sessionId === ref)
  if (exact.length === 1 && exact[0]) return { thread: exact[0] }
  const loose = threads.filter(t => t.sessionId.startsWith(ref) || t.name.endsWith(ref) || t.name.endsWith(`:${ref}`))
  if (loose.length === 1 && loose[0]) return { thread: loose[0] }
  return { error: loose.length > 1 ? `"${ref}" matches ${loose.length} threads: ${loose.map(t => t.id).join(', ')}` : `no thread "${ref}"` }
}

export const STATE_LABEL: Record<ForemanThreadState, string> = {
  working: 'Working',
  ready: 'Ready for review',
  waiting: 'Waiting for you',
  blocked: 'Blocked',
  limit: 'Usage limit',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
}

export function nextAction(t: ForemanThread): string {
  switch (t.state) {
    case 'working': return 'wait'
    case 'blocked': return 'Open it in the app and answer there (pane: Open)'
    case 'waiting': return 'answer it (pane: Reply)'
    case 'ready': return t.runId && t.runId !== 'adhoc' ? 'foreman reviews it' : '/foreman review'
    case 'limit': return 'retries at the reset'
    case 'done': return '-'
    case 'failed': return `/foreman log ${t.id}`
    case 'stopped': return 'a Reply resumes it'
  }
}

export function tokens(t: ForemanThread): string {
  const u = t.usage
  if (!u) return '-'
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))
  return `${k(u.input + u.cacheWrite)} in · ${k(u.output)} out · ${k(u.cacheRead)} cached`
}

/** /foreman status: one row per thread, numbered as findThread reads numbers. */
export function statusTable(threads: readonly ForemanThread[], now: number): string {
  const open = threads.filter(t => !t.closed)
  if (open.length === 0) return 'No threads. Run a plan with /foreman go <plan.md>.'
  const since = (iso: string) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
  }
  const rows = open.map((t, i) => {
    const state = STATE_LABEL[t.state] + (t.waitingFor ? ` (${t.waitingFor.slice(0, 60)})` : '')
    return `| ${i + 1} | ${t.id} | ${t.name} | ${t.role} | ${state} | ${since(t.updatedAt)} | ${tokens(t)} | ${nextAction(t)} |`
  })
  return ['| # | id | thread | role | state | since | tokens | next |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n')
}
