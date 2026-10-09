// Threads are `claude --bg` sessions (plan D1). This module builds the CLI's
// argv, reads its output and maps `claude agents` rows plus the transcript
// onto a thread's state. Pure: register.tsx runs the commands.

import type { ForemanAgentRow, ForemanRole, ForemanThread, ForemanThreadResult, ForemanThreadState } from '../../types'
import type { FenceRead, TranscriptFacts } from './transcript'
import { addUsage, parseResultFence } from './transcript'

export const ISOLATION_OFF = JSON.stringify({ worktree: { bgIsolation: 'none' } })

export function threadName(runId: string | undefined, role: ForemanRole, part: string | undefined): string {
  return `foreman:${runId ?? 'adhoc'}:${role}${part ? `-${part}` : ''}`
}

export type LaunchSpec = {
  exe: string
  name: string
  model: string
  effort: string
  permissionMode: string
  isolation: 'none' | 'worktree'
  brief: string
}

/** `claude --bg …`: the prompt is the positional argument (`--bg` refuses `-p`, SPIKE §1). */
export function launchArgv(s: LaunchSpec): string[] {
  const argv = [s.exe, '--bg', '--name', s.name, '--model', s.model, '--effort', s.effort, '--permission-mode', s.permissionMode]
  if (s.isolation === 'none') argv.push('--settings', ISOLATION_OFF)
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

/** What a message to the thread takes: refused while it works, a stop first while it is live. */
export function sendPlan(row: ForemanAgentRow | undefined): { steps: ('stop' | 'resume')[] } | { refuse: string } {
  if (row && (row.state === 'working' || row.status === 'busy')) return { refuse: 'the thread is working; wait until it stops, or /foreman stop it first' }
  return { steps: row?.pid !== undefined ? ['stop', 'resume'] : ['resume'] }
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

/** Roles whose done needs no review step. */
const SELF_CLOSING: readonly ForemanRole[] = ['free', 'triage']

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

/**
 * Whether the turn foreman is waiting for is over: the session is idle, and the
 * transcript holds a prompt written at or after the thread's `sentAt` (its launch
 * or last message) with a turn end after it. The CLI's row alone cannot say:
 * after a resume it keeps `done` from the previous turn, and the new prompt row
 * lands about 2 s later (review C-01).
 */
export function turnOver(t: ForemanThread, row: ForemanAgentRow | undefined, facts: TranscriptFacts | undefined): boolean {
  if (!row || !facts || !facts.turnEnded) return false
  if (row.state === 'working' || row.state === 'blocked' || row.state === 'failed' || row.status === 'busy' || row.status === 'waiting') return false
  if (t.sentAt === undefined) return true
  return facts.promptAt !== undefined && facts.promptAt >= Date.parse(t.sentAt)
}

/**
 * The thread after one look at its `claude agents` row and, when read, its transcript.
 * A turn that ended without a valid foreman-result is `waiting` with `noResult`: never an invented done.
 */
export function syncThread(t: ForemanThread, row: ForemanAgentRow | undefined, facts: TranscriptFacts | undefined, nowIso: string): Sync {
  const from = t.state
  const next: ForemanThread = { ...t }
  if (facts) {
    next.usage = addUsage(t.usage, facts.usage)
    if (facts.lastTs) next.usageSince = facts.lastTs
    if (facts.lastId) next.usageLastId = facts.lastId
  }
  const over = turnOver(t, row, facts)
  const fence: FenceRead | undefined = over && facts ? parseResultFence(facts.lastText) : undefined
  const undelivered = !over && row !== undefined && row.state !== 'working' && row.status !== 'busy' && t.sentAt !== undefined &&
    (facts?.promptAt ?? 0) < Date.parse(t.sentAt) && Date.parse(nowIso) - Date.parse(t.sentAt) > UNDELIVERED_MS
  delete next.waitingFor
  if (!row) {
    if (from === 'working' || from === 'blocked') next.state = 'stopped'
  } else if (row.state === 'failed') {
    next.state = 'failed'
    next.waitingFor = 'the session failed (claude agents: failed); see /foreman log, or launch again'
  } else if (row.state === 'working' || row.status === 'busy') {
    next.state = 'working'
    delete next.noResult
  } else if (row.state === 'blocked' || row.status === 'waiting') {
    next.state = row.pid === undefined ? 'stopped' : 'blocked'
    next.waitingFor = row.pid === undefined ? 'exited while blocked' : cut(row.waitingFor ?? 'input', 300)
  } else if (row.state === 'stopped') {
    next.state = 'stopped'
  } else if (undelivered) {
    next.state = 'waiting'
    next.waitingFor = 'the message never reached the thread; /foreman tell it again'
  } else if (from === 'limit' && !fence) {
    // a limit is cleared by the retry, not by the session going idle
  } else if (fence && facts?.limitHit && fence.kind === 'none') {
    next.state = 'limit'
    next.waitingFor = 'usage limit'
  } else if (fence) {
    if (fence.kind === 'ok') {
      next.lastResult = trimResult(fence.result)
      delete next.noResult
      const s = fence.result.status
      next.state = s === 'done' ? (SELF_CLOSING.includes(t.role) ? 'done' : 'ready') : s === 'failed' ? 'failed' : 'waiting'
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
    JSON.stringify(next.lastResult) !== JSON.stringify(t.lastResult) || next.usageLastId !== t.usageLastId
  if (next.state !== from || next.waitingFor !== t.waitingFor) next.updatedAt = nowIso
  return { thread: next, from, changed }
}

/**
 * Threads that count against maxParallelThreads (D-20): foreman sessions the CLI
 * shows live and mid-turn under this repo, whichever chat launched them, plus
 * registry threads just launched that the CLI does not list yet.
 */
export function busyIds(threads: readonly ForemanThread[], rows: readonly ForemanAgentRow[]): string[] {
  const live = rows.filter(r => r.id !== undefined && r.pid !== undefined && (r.name ?? '').startsWith('foreman:') &&
    (r.state === 'working' || r.state === 'blocked' || r.status === 'busy' || r.status === 'waiting')).map(r => r.id as string)
  const listed = new Set(rows.map(r => r.id))
  const fresh = threads.filter(t => !t.closed && t.state === 'working' && !listed.has(t.id)).map(t => t.id)
  return [...new Set([...live, ...fresh])]
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
  if (!ref) return open.length === 1 && open[0] ? { thread: open[0] } : { error: open.length ? 'name the thread: its id, name or number from /foreman status' : 'no threads yet: /foreman launch' }
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
    case 'blocked': return `/foreman open ${t.id}`
    case 'waiting': return `/foreman tell ${t.id} "…"`
    case 'ready': return '/foreman review'
    case 'limit': return 'retries at the reset'
    case 'done': return `/foreman close ${t.id}`
    case 'failed': return `/foreman log ${t.id}`
    case 'stopped': return `/foreman tell ${t.id} "…" (resumes)`
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
  if (open.length === 0) return 'No threads. Start one with /foreman launch <role> "<task>".'
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
