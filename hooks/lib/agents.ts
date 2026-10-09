// `claude agents --json`: reading it, keeping a repo's rows, grouping them.

import type { ForemanAgentRow } from '../../types'

export const RECENT_MS = 7 * 24 * 60 * 60 * 1000

/** Lower-case, forward slashes, no trailing slash: how two paths are compared. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function isUnder(path: string, root: string): boolean {
  const a = normPath(path)
  const b = normPath(root)
  return a === b || a.startsWith(b + '/')
}

const isRow = (v: unknown): v is ForemanAgentRow => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.sessionId === 'string' && typeof r.cwd === 'string' && typeof r.kind === 'string'
}

/** Parses the CLI's JSON array; throws with a short reason when it is not one. */
export function parseAgents(stdout: string): ForemanAgentRow[] {
  const raw: unknown = JSON.parse(stdout)
  if (!Array.isArray(raw)) throw new Error('`claude agents --json` did not print a JSON array')
  return raw.filter(isRow).map(r => ({ ...r, startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0 }))
}

/** The background sessions under `root`: live ones, and exited ones from the last week. */
export function repoRows(rows: readonly ForemanAgentRow[], root: string, now: number): ForemanAgentRow[] {
  return rows
    .filter(r => r.kind === 'background' && isUnder(r.cwd, root))
    .filter(r => r.pid !== undefined || now - r.startedAt < RECENT_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export type Group = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'

export const GROUP_LABEL: Record<Group, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped / exited',
}

export function groupOf(row: ForemanAgentRow): Group {
  if (row.state === 'failed') return 'failed'
  if (row.state === 'working' || row.status === 'busy') return row.pid === undefined ? 'stopped' : 'working'
  // a session that exited while blocked waits for nobody (review C-03)
  if (row.state === 'blocked' || row.status === 'waiting') return row.pid === undefined ? 'stopped' : 'waiting'
  if (row.state === 'stopped') return 'stopped'
  return 'done'
}

export function groupRows(rows: readonly ForemanAgentRow[]): { group: Group; rows: ForemanAgentRow[] }[] {
  const order: Group[] = ['working', 'waiting', 'failed', 'done', 'stopped']
  return order.map(group => ({ group, rows: rows.filter(r => groupOf(r) === group) })).filter(g => g.rows.length > 0)
}

/** The status line (the engine puts the plugin's name before it): `2 working · 1 waiting`, or undefined when nothing is live. */
export function statusLine(rows: readonly ForemanAgentRow[]): string | undefined {
  const live = rows.filter(r => r.pid !== undefined)
  const working = live.filter(r => groupOf(r) === 'working').length
  const waiting = live.filter(r => groupOf(r) === 'waiting').length
  const parts = [working ? `${working} working` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The argv that lists every session, live and exited. */
export function agentsArgv(exe: string): string[] {
  return [exe, 'agents', '--json', '--all']
}

/** Reads `claude agents --json --all`'s result; throws with the CLI's own message when it failed. */
export function readAgents(r: { exitCode: number; stdout: string; stderr: string }): ForemanAgentRow[] {
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `claude agents exited ${r.exitCode}`)
  return parseAgents(r.stdout)
}
