// The cycle (plan §5): implement → review → apply → review … → ready. Pure:
// `stepCycle` reads the cycle, its implementer thread and its current review
// and returns the cycle's next value and the effects to run; register.tsx
// runs them, each made safe to repeat (it checks the intent the cycle
// recorded before doing anything twice).
//
//   phase         observed                                       next phase     effect
//   implementing  thread working                                 implementing   -
//                 thread ready (a turn after the phase began)    reviewing      review (round n+1)
//                 thread limit                                   limit          - (the thread layer retries)
//                 thread stopped mid-turn, not by the person,
//                   not opened in the app, revived < REVIVE_MAX  implementing   revive (resume on a re-brief)
//                 thread blocked / waiting / failed / stopped    waiting:thread notify
//   reviewing     review not bound or running                    reviewing      -
//                 OK                                             ready          notify (the plan run starts the next part, run.ts)
//                 NO, rounds < maxCycles                         applying       apply (review path only)
//                 NO, rounds = maxCycles                         waiting:person notify "rounds used up"
//                 BLOCKED, or no verdict                         waiting:person notify
//   applying      (the apply effect moves it on)                 implementing   -
//   limit         thread working again                           implementing   -
//                 thread ready / waiting …                       as implementing
//   waiting       on the thread: as implementing, once it changed
//                 on the person: thread working after the wait   implementing   -
//   ready/closed  -                                              (terminal)     -
//
// Invariants: blocked and question results only ever lead to waiting, never
// to an answer; a resume sends only the review file's path; every phase
// change is a transition the caller records with its time.

import type { ForemanCycle, ForemanCycleRound, ForemanReview, ForemanThread } from '../../types'
import type { NoticeLevel } from './run'
import { MID_TURN } from './threads'

export type CycleEffect =
  | { kind: 'review'; n: number }
  | { kind: 'apply'; round: ForemanCycleRound }
  /** Resume the implementer, whose process ended mid-turn, on a re-brief (D-69: resume after the app closed). */
  | { kind: 'revive' }
  | { kind: 'notify'; text: string; level: NoticeLevel }

/** A part's implementer is resumed on its own at most this many times (a thread that keeps dying waits for the person). */
export const REVIVE_MAX = 2

/**
 * The thread's process ended before its turn did (no turn end after the last
 * prompt), and nobody meant it: not the person's Stop, nor their pause of the
 * plan, not Open (the person may be answering it in the app). A thread at a
 * usage limit, or one that exited while a dialog was open (that needs the
 * person: Open), is never stopped mid-turn in this sense.
 */
export function revivable(c: ForemanCycle, t: ForemanThread, runPaused = false): boolean {
  return t.state === 'stopped' && t.waitingFor === MID_TURN && t.sessionId !== '' && t.heldBy === undefined && t.openedAt === undefined &&
    !runPaused && (c.revived ?? 0) < REVIVE_MAX
}

/** The message that resumes a thread whose process ended mid-turn: where its work is written down (M8, the short form). */
export function reviveMessage(o: { part: string; plan: string; brief?: string; progress?: string }): string {
  const where = [o.brief ? `your brief is \`${o.brief}\`` : '', o.progress ? `foreman's notes on the plan are in \`${o.progress}\`` : ''].filter(Boolean).join(', and ')
  return `foreman resumes you: your session's process ended before your turn did (the app or the computer closed). Go on with part ${o.part} of the plan \`${o.plan}\`${where ? `: ${where}` : ''}. Check \`git status\` and \`git log\` for what you already did, finish the part, commit, and end the turn with the foreman-result block.`
}

export type CycleObservation = {
  thread: ForemanThread | undefined
  /** The review bound to the cycle's last round, as the registry has it now. */
  review: ForemanReview | undefined
  nowIso: string
  /** The person paused the plan: a thread that stopped mid-turn waits for them instead of being resumed. */
  runPaused?: boolean
}

export type CycleStep = { cycle: ForemanCycle; effects: CycleEffect[]; moved: boolean }

const ACTIVE: readonly ForemanCycle['phase'][] = ['implementing', 'reviewing', 'applying', 'waiting', 'limit']

export function isActive(c: ForemanCycle): boolean {
  return ACTIVE.includes(c.phase)
}

/** The message that resumes the implementer on a review: its path, never its text (plan §5). */
export function applyMessage(round: ForemanCycleRound): string {
  return `Apply the review \`${round.file}\` (review r${round.n}, verdict ${round.verdict}): fix or refute each finding with evidence (file:line, the command and its exit code), rerun the affected gates, commit before you end the turn, and end it with the foreman-result block.`
}

export function cycleId(runId: string, part: string): string {
  return `${runId}:${part}`
}

export function moveTo(c: ForemanCycle, phase: ForemanCycle['phase'], nowIso: string, extra: Partial<ForemanCycle> = {}): ForemanCycle {
  const next: ForemanCycle = { ...c, ...extra, phase, phaseAt: nowIso, updatedAt: nowIso }
  if (phase !== 'waiting') {
    delete next.reason
    delete next.waitingOn
  }
  return next
}

/** A thread result newer than the phase: what the implementer did in this phase, not an earlier one. */
function freshSince(t: ForemanThread, phaseAt: string): boolean {
  return Date.parse(t.updatedAt) >= Date.parse(phaseAt)
}

function fromThread(c: ForemanCycle, t: ForemanThread | undefined, nowIso: string, runPaused = false): CycleStep {
  const stay: CycleStep = { cycle: c, effects: [], moved: false }
  if (!t) {
    if (c.phase === 'waiting' && c.reason === 'its implementer thread is gone from the registry') return stay
    const cy = moveTo(c, 'waiting', nowIso, { waitingOn: 'thread', reason: 'its implementer thread is gone from the registry' })
    return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: waiting, ${cy.reason}`, level: 'stop' }], moved: true }
  }
  if (revivable(c, t, runPaused)) {
    const cy = c.phase === 'implementing' ? { ...c, revived: (c.revived ?? 0) + 1, updatedAt: nowIso } : moveTo(c, 'implementing', nowIso, { revived: (c.revived ?? 0) + 1 })
    return { cycle: cy, effects: [{ kind: 'revive' }], moved: cy.phase !== c.phase }
  }
  // a stop the person meant, or one too many, waits for them below
  switch (t.state) {
    case 'working':
      return c.phase === 'implementing' ? stay : { cycle: moveTo(c, 'implementing', nowIso), effects: [], moved: true }
    case 'ready':
      if (!freshSince(t, c.phaseAt)) return stay
      return {
        cycle: moveTo(c, 'reviewing', nowIso, { reviewRequestedAt: nowIso }),
        effects: [{ kind: 'review', n: c.rounds.length + 1 }],
        moved: true,
      }
    case 'limit':
      return c.phase === 'limit' ? stay : { cycle: moveTo(c, 'limit', nowIso), effects: [], moved: true }
    default: {
      // blocked (a dialog), waiting (a question, a blocker, no result), failed, stopped, done: the person decides;
      // once Open put the thread in the app, the person is answering it there: one quiet line until it moves
      const inApp = t.openedAt !== undefined
      const reason = inApp ? 'the implementer is open in the app: answer it there' : `the implementer is ${t.state}${t.waitingFor ? `: ${t.waitingFor}` : ''}`
      if (c.phase === 'waiting' && c.reason === reason) return stay
      const cy = moveTo(c, 'waiting', nowIso, { waitingOn: 'thread', reason })
      return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: waiting, ${reason}`, level: inApp ? 'info' : 'stop' }], moved: true }
    }
  }
}

function fromReview(c: ForemanCycle, review: ForemanReview | undefined, o: CycleObservation): CycleStep {
  const stay: CycleStep = { cycle: c, effects: [], moved: false }
  const last = c.rounds.at(-1)
  if (!last || !review || review.agentId !== last.agentId || !review.finishedAt) return stay
  const round: ForemanCycleRound = { ...last, verdict: review.verdict, findings: review.findings }
  const rounds = [...c.rounds.slice(0, -1), round]
  const used = rounds.length
  const nowIso = o.nowIso
  const wait = (reason: string): CycleStep => {
    const cy = moveTo(c, 'waiting', nowIso, { rounds, waitingOn: 'person', reason })
    return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: waiting, ${reason}`, level: 'stop' }], moved: true }
  }
  switch (review.verdict) {
    case 'OK': {
      const cy = moveTo(c, 'ready', nowIso, { rounds })
      return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: ready, review r${round.n} OK after ${used} round(s)`, level: 'info' }], moved: true }
    }
    case 'NO':
      if (used < c.maxCycles) return { cycle: moveTo(c, 'applying', nowIso, { rounds, applyFor: round.n }), effects: [{ kind: 'apply', round }], moved: true }
      return wait(`review rounds used up (${used} of ${c.maxCycles}), the last one NO with ${round.findings} finding(s): decide`)
    case 'BLOCKED':
      return wait(`the reviewer is blocked (${round.file})`)
    default:
      return wait(`review r${round.n} gave no verdict${review.reason ? ` (${review.reason})` : ''}`)
  }
}

/** One look at a cycle. Terminal and applying cycles do not move here. */
export function stepCycle(c: ForemanCycle, o: CycleObservation): CycleStep {
  switch (c.phase) {
    case 'implementing':
    case 'limit':
      return fromThread(c, o.thread, o.nowIso, o.runPaused)
    case 'reviewing':
      return fromReview(c, o.review, o)
    case 'waiting':
      if (c.waitingOn === 'thread') return fromThread(c, o.thread, o.nowIso, o.runPaused)
      // waiting on the person: only their move on the thread (a tell) sets it going again
      if (o.thread && o.thread.state === 'working' && o.thread.sentAt !== undefined && Date.parse(o.thread.sentAt) >= Date.parse(c.phaseAt)) {
        return { cycle: moveTo(c, 'implementing', o.nowIso), effects: [], moved: true }
      }
      return { cycle: c, effects: [], moved: false }
    default:
      return { cycle: c, effects: [], moved: false }
  }
}

/** Binds the review a round started to the cycle (by agent id), once the registry has it. */
export function bindRound(c: ForemanCycle, review: ForemanReview, nowIso: string): ForemanCycle {
  const round: ForemanCycleRound = { n: review.n, file: review.file, agentId: review.agentId, verdict: review.verdict, findings: review.findings }
  const updatedAt = Date.parse(nowIso) > Date.parse(c.updatedAt) ? nowIso : c.updatedAt
  return { ...c, rounds: [...c.rounds, round], updatedAt }
}

/**
 * The review a cycle asked for and has not bound yet: one of its run and part
 * started at or after the request (an adoption finds the one the previous
 * owner started instead of starting another).
 */
export function pendingRequest(c: ForemanCycle, reviews: readonly ForemanReview[]): ForemanReview | undefined {
  if (c.phase !== 'reviewing' || c.reviewRequestedAt === undefined) return undefined
  const bound = new Set(c.rounds.map(r => r.agentId))
  return reviews.find(r => r.kind === 'review' && r.runId === c.runId && r.part === c.part && !bound.has(r.agentId) && Date.parse(r.startedAt) >= Date.parse(c.reviewRequestedAt as string))
}
