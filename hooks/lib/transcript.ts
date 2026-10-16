// A thread's transcript, ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl:
// where it is, how its tail is read, and what foreman takes from it (the
// last assistant text, its foreman-result block, the usage). See SPIKE §3.

import type { ForemanThreadResult, ForemanUsage } from '../../types'

/** Above this size the file is read through a tail command, not $.fs.read (4 MiB cap). */
export const DIRECT_READ_MAX = 3_500_000
export const TAIL_BYTES = 3_000_000

/** Every character that is not a letter or digit becomes `-` (C:\MSG -> C--MSG). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function projectsDir(env: { claudeConfigDir?: string; home?: string }): string | undefined {
  const base = env.claudeConfigDir ?? (env.home ? `${env.home.replace(/[\\/]+$/, '')}${sepOf(env.home)}.claude` : undefined)
  return base ? `${base.replace(/[\\/]+$/, '')}${sepOf(base)}projects` : undefined
}

/** The separator a path already uses: a backslash for a Windows path, `/` otherwise. */
export function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

export function transcriptPath(projects: string, cwd: string, sessionId: string): string {
  const sep = sepOf(projects)
  return `${projects}${sep}${encodeCwd(cwd)}${sep}${sessionId}.jsonl`
}

/** The environment variable the Windows tail script reads its path from. */
export const TAIL_PATH_ENV = 'FOREMAN_TAIL_PATH'

/**
 * The command that prints the last `bytes` bytes of a file. On Windows a fixed
 * PowerShell script that reads the path from an environment variable, so no
 * path is ever spliced into a script (D-26); elsewhere `tail -c`.
 */
export function tailArgv(path: string, bytes: number, isWindows: boolean): { argv: string[]; env?: Record<string, string> } {
  if (!isWindows) return { argv: ['tail', '-c', String(Math.floor(bytes)), path] }
  const script = [
    `$fs = [IO.File]::Open($env:${TAIL_PATH_ENV}, 'Open', 'Read', 'ReadWrite')`,
    `$n = [Math]::Min($fs.Length, ${Math.floor(bytes)})`,
    `$null = $fs.Seek(-$n, 'End')`,
    `$b = New-Object byte[] $n`,
    `$null = $fs.Read($b, 0, $n)`,
    `$fs.Close()`,
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
    `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))`,
  ].join('; ')
  return { argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env: { [TAIL_PATH_ENV]: path } }
}

export const zeroUsage = (): ForemanUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

export type TranscriptFacts = {
  /** The text of the last assistant message after the last prompt ('' when the current turn has none yet). */
  lastText: string
  /** When the last prompt row was written (epoch ms), if there is one. */
  promptAt?: number
  /** A turn_duration row follows the last prompt: the thread's turn is over (a background session writes one per turn). */
  turnEnded: boolean
  /**
   * The last assistant row after the last prompt stopped with `end_turn`: how a
   * turn in the desktop app ends, where no turn_duration row is written (F0-5).
   */
  endTurn: boolean
  /** Usage of assistant messages newer than `since`, each message counted once across reads. */
  usage: ForemanUsage
  /** The newest counted timestamp (assistant usage or turn end): the next read's `since`. */
  lastTs?: string
  /** The id of the last message counted: the next read's `lastId`, so a message split over rows is counted once. */
  lastId?: string
  /**
   * The current turn ended on an API error row the CLI wrote itself (model
   * `<synthetic>`, `isApiErrorMessage: true`): `rate_limit` (429, with
   * `quotaLimits.resetsAt`), `authentication_failed` (401), ... (SPIKE addendum).
   * Never read from the model's own words (review C-15).
   */
  apiError?: { kind: string; status?: number; resetsAt?: number }
  /** `apiError` is a usage limit. */
  limitHit: boolean
}

type Row = {
  type?: string
  timestamp?: string
  subtype?: string
  isApiErrorMessage?: boolean
  error?: string
  apiErrorStatus?: number
  quotaLimits?: { resetsAt?: number }
  message?: { id?: string; role?: string; content?: unknown; usage?: Record<string, unknown>; stop_reason?: string | null }
}

function texts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
}

const isPrompt = (r: Row) => r.type === 'user' && texts(r.message?.content) !== '' && !(Array.isArray(r.message?.content) && (r.message?.content as { type?: string }[]).some(b => b?.type === 'tool_result'))
const ms = (ts: string | undefined) => (ts ? Date.parse(ts) : NaN)

export type ReadOptions = { isTail: boolean; since?: string; lastId?: string }

/** Reads the jsonl text (a whole file, or a tail whose first line may be cut). */
export function readTranscript(text: string, opts: ReadOptions): TranscriptFacts {
  const lines = text.split('\n')
  if (opts.isTail) lines.shift()
  const rows: Row[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as Row) } catch { /* a cut or foreign line */ }
  }
  let lastPrompt = -1
  rows.forEach((r, i) => { if (isPrompt(r)) lastPrompt = i })
  const turnEnded = lastPrompt >= 0 && rows.some((r, i) => i > lastPrompt && r.type === 'system' && r.subtype === 'turn_duration')
  const promptAt = lastPrompt >= 0 ? ms(rows[lastPrompt]?.timestamp) : undefined

  // the current turn's answer only: assistant rows after the last prompt
  let textId: string | undefined
  let parts: string[] = []
  rows.forEach((r, i) => {
    if (i <= lastPrompt || r.type !== 'assistant') return
    const t = texts(r.message?.content)
    if (!t) return
    const id = r.message?.id ?? r.timestamp ?? String(i)
    if (id !== textId) { textId = id; parts = [] }
    parts.push(t)
  })
  const lastText = parts.join('\n')

  // the turn's last assistant row: an API error the CLI wrote, or the model's own
  const lastAssistant = [...rows.slice(lastPrompt + 1)].reverse().find(r => r.type === 'assistant')
  const endTurn = lastPrompt >= 0 && lastAssistant?.message?.stop_reason === 'end_turn'
  const apiError = lastAssistant?.isApiErrorMessage === true
    ? {
        kind: lastAssistant.error ?? 'unknown',
        ...(typeof lastAssistant.apiErrorStatus === 'number' ? { status: lastAssistant.apiErrorStatus } : {}),
        ...(typeof lastAssistant.quotaLimits?.resetsAt === 'number' ? { resetsAt: lastAssistant.quotaLimits.resetsAt * 1000 } : {}),
      }
    : undefined

  const usage = zeroUsage()
  const since = ms(opts.since)
  const seen = new Set<string>(opts.lastId ? [opts.lastId] : [])
  let lastTs = opts.since
  let lastId = opts.lastId
  const later = (ts: string | undefined) => ts !== undefined && (!(since >= 0) || ms(ts) > since)
  const bump = (ts: string | undefined) => { if (ts && (lastTs === undefined || ms(ts) > ms(lastTs))) lastTs = ts }
  for (const r of rows) {
    if (r.type !== 'assistant' || !r.message?.usage || !later(r.timestamp)) continue
    const id = r.message.id ?? `${r.timestamp}`
    if (seen.has(id)) continue
    seen.add(id)
    const u = r.message.usage
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
    usage.input += n('input_tokens')
    usage.output += n('output_tokens')
    usage.cacheRead += n('cache_read_input_tokens')
    usage.cacheWrite += n('cache_creation_input_tokens')
    lastId = id
    bump(r.timestamp)
  }
  for (const r of rows) {
    if (r.type !== 'system' || r.subtype !== 'turn_duration' || !later(r.timestamp)) continue
    usage.turns += 1
    bump(r.timestamp)
  }
  return { lastText, promptAt: promptAt !== undefined && promptAt >= 0 ? promptAt : undefined, turnEnded, endTurn, usage, lastTs, lastId, ...(apiError ? { apiError } : {}), limitHit: apiError?.kind === 'rate_limit' }
}

export function addUsage(a: ForemanUsage | undefined, b: ForemanUsage): ForemanUsage {
  const x = a ?? zeroUsage()
  return { input: x.input + b.input, output: x.output + b.output, cacheRead: x.cacheRead + b.cacheRead, cacheWrite: x.cacheWrite + b.cacheWrite, turns: x.turns + b.turns }
}

export type FenceRead = { kind: 'none' } | { kind: 'invalid'; reason: string } | { kind: 'ok'; result: ForemanThreadResult }

const STATUSES = ['done', 'blocked', 'question', 'failed']

/** The last ```foreman-result block of `text`, validated. */
export function parseResultFence(text: string): FenceRead {
  const re = /```foreman-result[ \t]*\r?\n([\s\S]*?)```/g
  let body: string | undefined
  for (let m = re.exec(text); m; m = re.exec(text)) body = m[1]
  if (body === undefined) return { kind: 'none' }
  let raw: unknown
  try { raw = JSON.parse(body) } catch (err) { return { kind: 'invalid', reason: `not JSON: ${err instanceof Error ? err.message : String(err)}` } }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'invalid', reason: 'not an object' }
  const r = raw as Record<string, unknown>
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return { kind: 'invalid', reason: `status must be one of ${STATUSES.join(', ')}` }
  if (typeof r.summary !== 'string') return { kind: 'invalid', reason: 'summary must be a string' }
  const result: ForemanThreadResult = { status: r.status as ForemanThreadResult['status'], summary: r.summary }
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  const commits = strs(r.commits)
  if (commits) result.commits = commits
  const files = strs(r.files)
  if (files) result.files = files
  if (typeof r.question === 'string') result.question = r.question
  if (Array.isArray(r.gates)) {
    result.gates = r.gates
      .filter((g): g is { cmd: string; exit: number } => typeof g === 'object' && g !== null && typeof (g as { cmd?: unknown }).cmd === 'string' && typeof (g as { exit?: unknown }).exit === 'number')
      .map(g => ({ cmd: g.cmd, exit: g.exit }))
  }
  return { kind: 'ok', result }
}
