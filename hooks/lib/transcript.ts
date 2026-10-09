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
  const base = env.claudeConfigDir ?? (env.home ? `${env.home.replace(/[\\/]+$/, '')}/.claude` : undefined)
  return base ? `${base}/projects` : undefined
}

export function transcriptPath(projects: string, cwd: string, sessionId: string): string {
  return `${projects}/${encodeCwd(cwd)}/${sessionId}.jsonl`
}

/** The argv that prints the last `bytes` bytes of a file. */
export function tailArgv(path: string, bytes: number, isWindows: boolean): string[] {
  if (!isWindows) return ['tail', '-c', String(bytes), path]
  const p = path.replace(/'/g, "''")
  const script = [
    `$fs = [IO.File]::Open('${p}', 'Open', 'Read', 'ReadWrite')`,
    `$n = [Math]::Min($fs.Length, ${bytes})`,
    `$null = $fs.Seek(-$n, 'End')`,
    `$b = New-Object byte[] $n`,
    `$null = $fs.Read($b, 0, $n)`,
    `$fs.Close()`,
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
    `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))`,
  ].join('; ')
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
}

export const zeroUsage = (): ForemanUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

export type TranscriptFacts = {
  /** The text of the last assistant message that had any. */
  lastText: string
  /** A turn_duration row follows the last prompt: the thread's turn is over. */
  turnEnded: boolean
  /** Usage of assistant messages newer than `since`, each message counted once. */
  usage: ForemanUsage
  /** The newest counted timestamp (assistant usage or turn end): the next read's `since`. */
  lastTs?: string
  /** The last assistant text reads as a usage or rate limit message. */
  limitHit: boolean
}

type Row = { type?: string; timestamp?: string; subtype?: string; message?: { id?: string; role?: string; content?: unknown; usage?: Record<string, unknown> } }

function texts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
}

const isPrompt = (r: Row) => r.type === 'user' && texts(r.message?.content) !== '' && !(Array.isArray(r.message?.content) && (r.message?.content as { type?: string }[]).some(b => b?.type === 'tool_result'))

export const LIMIT_RE = /usage limit|rate limit|limit reached|resets? at|out of (?:extra )?usage/i

/** Reads the jsonl text (a whole file, or a tail whose first line may be cut). */
export function readTranscript(text: string, opts: { isTail: boolean; since?: string }): TranscriptFacts {
  const lines = text.split('\n')
  if (opts.isTail) lines.shift()
  const rows: Row[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line) as Row) } catch { /* a cut or foreign line */ }
  }
  let lastPrompt = -1
  rows.forEach((r, i) => { if (isPrompt(r)) lastPrompt = i })
  const turnEnded = rows.some((r, i) => i > lastPrompt && r.type === 'system' && r.subtype === 'turn_duration')

  let lastId: string | undefined
  let lastText = ''
  const byId = new Map<string, string[]>()
  for (const r of rows) {
    if (r.type !== 'assistant') continue
    const t = texts(r.message?.content)
    if (!t) continue
    const id = r.message?.id ?? r.timestamp ?? ''
    if (id !== lastId) { lastId = id; byId.set(id, []) }
    byId.get(id)?.push(t)
  }
  if (lastId !== undefined) lastText = (byId.get(lastId) ?? []).join('\n')

  const usage = zeroUsage()
  const seen = new Set<string>()
  let lastTs = opts.since
  for (const r of rows) {
    if (r.type !== 'assistant' || !r.message?.usage) continue
    if (opts.since && r.timestamp && r.timestamp <= opts.since) continue
    const id = r.message.id ?? `${r.timestamp}`
    if (seen.has(id)) continue
    seen.add(id)
    const u = r.message.usage
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
    usage.input += n('input_tokens')
    usage.output += n('output_tokens')
    usage.cacheRead += n('cache_read_input_tokens')
    usage.cacheWrite += n('cache_creation_input_tokens')
    if (r.timestamp && (!lastTs || r.timestamp > lastTs)) lastTs = r.timestamp
  }
  for (const r of rows) {
    if (r.type !== 'system' || r.subtype !== 'turn_duration') continue
    if (opts.since && (r.timestamp ?? '') <= opts.since) continue
    usage.turns += 1
    if (r.timestamp && (!lastTs || r.timestamp > lastTs)) lastTs = r.timestamp
  }
  return { lastText, turnEnded, usage, lastTs, limitHit: LIMIT_RE.test(lastText) && lastText.length < 600 }
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
