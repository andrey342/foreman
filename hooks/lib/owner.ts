// Who acts on a shared record (review C3-03, N-02). Every chat open in a repo
// runs foreman, and they share $.store; a record that a session started (a
// review's wait, later a cycle) belongs to that session while it is alive.
// Pure: register.tsx asks `claude agents --json --all` and `$.session.id()`.

import type { ForemanAgentRow } from '../../types'

/** A session is alive while `claude agents` lists it with a process. */
export function sessionAlive(rows: readonly ForemanAgentRow[], sessionId: string): boolean {
  return rows.some(r => r.sessionId === sessionId && r.pid !== undefined)
}

export type Standing = 'mine' | 'other' | 'orphan'

/**
 * `mine`: this session owns it. `other`: another live session does; leave it
 * alone. `orphan`: no owner recorded, or its owner is gone (a `claude -p` run
 * is never listed, so its records turn orphan for the others at once; an
 * orphan's settlement is therefore one the real owner may still overwrite).
 */
export function standing(owner: string | undefined, me: string, rows: readonly ForemanAgentRow[]): Standing {
  if (owner === undefined) return 'orphan'
  if (owner === me) return 'mine'
  return sessionAlive(rows, owner) ? 'other' : 'orphan'
}
