// The cycle (plan §5, D-67, D-68): implement → review → apply → review … →
// ready, with the supervisor deciding at each stop. Pure: `stepCycle` reads the
// cycle, its implementer thread and its current review and returns the
// cycle's next value and the effects to run; `decide` turns a checked decision
// into the next phase; register.tsx runs the effects, each made safe to repeat
// (it checks the intent the cycle recorded before doing anything twice).
//
//   phase         observed                                       next phase     effect
//   implementing  thread working                                 implementing   -
//                 thread ready (a turn after the phase began)    reviewing      review (round n+1)
//                 thread limit                                   limit          - (the thread layer retries)
//                 thread stopped mid-turn, not by the person,
//                   not opened in the app, revived < REVIVE_MAX  implementing   revive (resume on a re-brief)
//                 a result with `needs: "human"`                 waiting:person notify (D-82: straight to the person)
//                 a question, a blocker, no result, a failure
//                   it reports                                   supervising    supervise (the stop)
//                   … the budget spent, the same question a
//                   third time, nothing the supervisor may do    waiting:person notify, a code decision
//                 thread blocked by a dialog / stopped / failed
//                   by the CLI                                   waiting:thread notify (the person: Open, Reply)
//   reviewing     review not bound or running                    reviewing      -
//                 OK                                             ready          notify (the plan run starts the next part, run.ts)
//                 NO, rounds < maxCycles                         applying       apply (review path only)
//                 NO, rounds used up                             supervising    supervise (replan or escalate only, D-67)
//                 BLOCKED, or no verdict                         supervising    supervise
//   supervising   (the supervisor runs; `decide` moves it)
//                 answer                                         supervising    send (intent `deciding`), then implementing
//                 replan (once per part)                         supervising    replan (new brief; the rounds count again)
//                 re-review                                      reviewing      review
//                 escalate, or anything the code refuses         waiting:person notify
//   applying      (the apply effect moves it on)                 implementing   -
//   limit         thread working again                           implementing   -
//   waiting       on the thread: as implementing, once it changed
//                 on the person: thread working after the wait   implementing   -
//   ready/closed  -                                              (terminal)     -
//
// Invariants: a question or a blocker reaches the supervisor, never an answer
// foreman makes up; the supervisor's answer passes the code's checks first; a
// fourth review round on one brief never happens; every phase change is a
// transition the caller records with its time.

import type { ForemanCycle, ForemanCycleRound, ForemanDecisionNote, ForemanReview, ForemanStop, ForemanThread } from '../../types'
import type { NoticeLevel } from './run'
import { MID_TURN } from './threads'
import { escalateFirst } from './supervisor'
import type { Decision } from './supervisor'

export type CycleEffect =
  | { kind: 'review'; n: number }
  | { kind: 'apply'; round: ForemanCycleRound }
  /** Resume the implementer, whose process ended mid-turn, on a re-brief (D-69: resume after the app closed). */
  | { kind: 'revive' }
  /** Ask the supervisor about this stop (D-68). */
  | { kind: 'supervise'; stop: ForemanStop }
  /** Send the supervisor's answer to the implementer. */
  | { kind: 'send'; text: string }
  /** Give the implementer a new brief for the part (D-67). */
  | { kind: 'replan'; text: string }
  /** A decision the code made (no supervisor run), for decisions.jsonl. */
  | { kind: 'decided'; note: ForemanDecisionNote; reason?: string; question?: string }
  | { kind: 'notify'; text: string; level: NoticeLevel }

/** A part's implementer is resumed on its own at most this many times (a thread that keeps dying waits for the person). */
export const REVIVE_MAX = 2

/** The decisions a cycle keeps (decisions.jsonl keeps them all). */
export const DECISIONS_KEPT = 8

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

const ACTIVE: readonly ForemanCycle['phase'][] = ['implementing', 'reviewing', 'applying', 'supervising', 'waiting', 'limit']

export function isActive(c: ForemanCycle): boolean {
  return ACTIVE.includes(c.phase)
}

/** Review rounds used on the part's current brief (a replan starts them again, D-67). */
/** Review rounds this brief used: those since the last replan that were not free (could not run, lost). */
export const roundsUsed = (c: ForemanCycle) => c.rounds.slice(c.roundBase ?? 0).filter(r => !r.free).length

/**
 * The message that resumes the implementer on a review: its path, never its
 * text (plan §5), with where the part stands (M8: a thread compacted between
 * rounds still knows which part, which criteria and which round it is on).
 */
export function applyMessage(round: ForemanCycleRound, ctx?: { part: string; criteria?: readonly string[]; maxRounds: number; used: number }): string {
  const state = ctx ? ` This is part ${ctx.part}, review round ${ctx.used} of ${ctx.maxRounds}${ctx.criteria?.length ? `; its acceptance criteria: ${ctx.criteria.slice(0, 3).map(c => `"${c.slice(0, 120)}"`).join(', ')}${ctx.criteria.length > 3 ? ` and ${ctx.criteria.length - 3} more in your brief` : ''}` : ''}.` : ''
  return `Apply the review \`${round.file}\` (review r${round.n}, verdict ${round.verdict}): fix or refute each finding with evidence (file:line, the command and its exit code), rerun the affected gates, commit before you end the turn, and end it with the foreman-result block.${state}`
}

/** What the implementer reads when the supervisor answered its stop. */
export function answerMessage(text: string): string {
  return `foreman's supervisor answers, within the plan:\n\n${text.trim()}\n\nGo on with the part. If this does not settle it, end the turn with status question again; to ask the person directly, add "needs": "human" to the foreman-result block.`
}

/** What the implementer reads when the supervisor replanned the part: its new brief. */
export function replanMessage(briefPath: string): string {
  return `foreman's supervisor replanned this part: read the new brief \`${briefPath}\` and work from it (it keeps the part's text and criteria, and says what changes). The part gets its review rounds again. Commit before you end the turn, and end it with the foreman-result block.`
}

/** The brief of a replanned part: the original, then the supervisor's plan for it. */
export function replanBrief(original: string, text: string, why: string): string {
  return `${original.trimEnd()}\n\n## The part, replanned by foreman's supervisor\n\nWhy: ${why.trim()}\n\n${text.trim()}\n`
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
  if (phase !== 'supervising') {
    delete next.supervising
    delete next.deciding
  }
  return next
}

/** A thread result newer than the phase: what the implementer did in this phase, not an earlier one. */
function freshSince(t: ForemanThread, phaseAt: string): boolean {
  return Date.parse(t.updatedAt) >= Date.parse(phaseAt)
}

/** A question as the "same question" count compares it: lower case, words only. */
export const normQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/g, ' ').trim().slice(0, 300)

/**
 * What a thread that ended its turn asks for: the supervisor (a question, a
 * blocker, no result, a failure it reports), the person (`needs: "human"`), or
 * neither (a dialog, a stop, the CLI's own failure: the person, as before).
 */
export function stopOf(c: ForemanCycle, t: ForemanThread): { stop: ForemanStop } | { person: string } | undefined {
  const r = t.lastResult
  if (t.state === 'waiting') {
    if (r?.needs === 'human') return { person: `the implementer asks you: ${r.question ?? r.summary}` }
    if (t.noResult) return { stop: { kind: 'no-result', part: c.part, text: t.waitingFor ?? 'no foreman-result' } }
    if (r?.status === 'question') return { stop: { kind: 'question', part: c.part, text: r.question ?? r.summary } }
    if (r?.status === 'blocked') return { stop: { kind: 'blocked', part: c.part, text: r.question ? `${r.summary}\n\n${r.question}` : r.summary } }
    return undefined
  }
  if (t.state === 'failed' && r?.status === 'failed' && t.waitingFor === undefined) return { stop: { kind: 'failed', part: c.part, text: r.summary } }
  return undefined
}

const note = (stop: ForemanStop, decision: ForemanDecisionNote['decision'], by: ForemanDecisionNote['by'], nowIso: string, text?: string, reason?: string): ForemanDecisionNote =>
  ({ at: nowIso, stop: stop.kind, decision, by, ...(text ? { text: text.slice(0, 1000) } : {}), ...(reason ? { reason: reason.slice(0, 600) } : {}) })

const keep = (c: ForemanCycle, n: ForemanDecisionNote) => [...(c.decisions ?? []), n].slice(-DECISIONS_KEPT)

/**
 * A stop goes to the supervisor, or, when the code already knows the person
 * decides (budget spent, the same question a third time, nothing the
 * supervisor may do here), straight to the person with that reason.
 */
export function toSupervisor(c: ForemanCycle, stop: ForemanStop, nowIso: string, extra: Partial<ForemanCycle> = {}): CycleStep {
  const asked = stop.kind === 'question' ? [...(c.asked ?? []), normQuestion(stop.text)].slice(-20) : c.asked
  const same = stop.kind === 'question' ? (c.asked ?? []).filter(q => q === normQuestion(stop.text)).length : 0
  const base: Partial<ForemanCycle> = { ...extra, ...(asked ? { asked } : {}) }
  const first = escalateFirst(stop, { runs: c.supervisorRuns ?? 0, replanned: c.replanned === true, roundsLeft: c.maxCycles - roundsUsed({ ...c, ...extra }), sameQuestionBefore: same })
  if (first !== undefined) {
    const n = note(stop, 'escalate', 'code', nowIso, stop.text, first)
    const reason = `${first}: ${stop.text.replace(/\s+/g, ' ').slice(0, 200)}`
    const cy = moveTo(c, 'waiting', nowIso, { ...base, waitingOn: 'person', reason, decisions: keep(c, n) })
    return { cycle: cy, effects: [{ kind: 'decided', note: n, reason: first, question: stop.text }, { kind: 'notify', text: `${c.id}: waiting for you, ${reason}`, level: 'stop' }], moved: true }
  }
  const cy = moveTo(c, 'supervising', nowIso, { ...base, supervising: { ...stop, at: nowIso } })
  return { cycle: cy, effects: [{ kind: 'supervise', stop }], moved: true }
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
  switch (t.state) {
    case 'working':
      return c.phase === 'implementing' ? stay : { cycle: moveTo(c, 'implementing', nowIso), effects: [], moved: true }
    case 'ready':
      if (!freshSince(t, c.phaseAt)) return stay
      return {
        cycle: moveTo(c, 'reviewing', nowIso, { reviewRequestedAt: nowIso, reviewAfter: c.rounds.length }),
        effects: [{ kind: 'review', n: c.rounds.length + 1 }],
        moved: true,
      }
    case 'limit':
      return c.phase === 'limit' ? stay : { cycle: moveTo(c, 'limit', nowIso), effects: [], moved: true }
    default: {
      // a turn that ended on a question, a blocker, no result or a reported failure: the supervisor, or the person
      if (t.openedAt === undefined && freshSince(t, c.phaseAt)) {
        const s = stopOf(c, t)
        if (s && 'stop' in s) return toSupervisor(c, s.stop, nowIso)
        if (s && 'person' in s) {
          if (c.phase === 'waiting' && c.reason === s.person) return stay
          const cy = moveTo(c, 'waiting', nowIso, { waitingOn: 'person', reason: s.person })
          return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: waiting for you, ${s.person}`, level: 'stop' }], moved: true }
        }
      }
      // a dialog, a stop, the CLI's failure: the person decides; once Open put the thread in the app,
      // the person is answering it there: one quiet line until it moves
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
  // the request's own round is not bound yet (a re-review was asked for): the last round is an earlier answer, not this one
  if (c.reviewAfter !== undefined && c.rounds.length <= c.reviewAfter) return stay
  const round: ForemanCycleRound = { ...last, verdict: review.verdict, findings: review.findings }
  const rounds = [...c.rounds.slice(0, -1), round]
  const nowIso = o.nowIso
  // a round that produced nothing through no fault of the work counts as none: the review runs once more, then the person
  // decides (Phase 3 criteria 7 and 9)
  const free: ForemanCycleRound['free'] = review.couldNotRun?.length ? 'could-not-run' : review.lost ? 'lost' : undefined
  if (free !== undefined) {
    const freed: ForemanCycleRound[] = [...c.rounds.slice(0, -1), { ...round, free }]
    const what = free === 'lost' ? `review r${round.n} was lost when foreman reloaded` : `review r${round.n} could not run ${(review.couldNotRun ?? []).map(g => `\`${g}\``).join(', ')} (the reviewer's permissions refused it)`
    if (!c.rounds.slice(0, -1).some(r => r.free === free)) {
      const cy = moveTo(c, 'reviewing', nowIso, { rounds: freed, reviewRequestedAt: nowIso, reviewAfter: freed.length })
      return { cycle: cy, effects: [{ kind: 'review', n: freed.length + 1 }, { kind: 'notify', text: `${c.id}: ${what}; it runs once more, as no round`, level: 'info' }], moved: true }
    }
    const why = `${free === 'could-not-run' ? 'the gates cannot run here: ' : ''}${what}, the second time for this part`
    const stopNow: ForemanStop = { kind: 'no-verdict', part: c.part, text: why, reviewFile: round.file, round: round.n }
    const n = note(stopNow, 'escalate', 'code', nowIso, undefined, why)
    const cy = moveTo(c, 'waiting', nowIso, { rounds: freed, waitingOn: 'person', reason: why, decisions: keep(c, n) })
    return { cycle: cy, effects: [{ kind: 'decided', note: n, reason: why, question: why }, { kind: 'notify', text: `${c.id}: waiting for you, ${why}`, level: 'stop' }], moved: true }
  }
  const used = roundsUsed({ ...c, rounds })
  const stop = (kind: ForemanStop['kind'], text: string): CycleStep => toSupervisor(c, { kind, part: c.part, text, reviewFile: round.file, round: round.n }, nowIso, { rounds })
  switch (review.verdict) {
    case 'OK': {
      const cy = moveTo(c, 'ready', nowIso, { rounds })
      return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: ready, review r${round.n} OK after ${rounds.filter(r => !r.free).length} round(s)`, level: 'info' }], moved: true }
    }
    case 'NO':
      if (used < c.maxCycles) return { cycle: moveTo(c, 'applying', nowIso, { rounds, applyFor: round.n }), effects: [{ kind: 'apply', round }], moved: true }
      // D-67: the last round said NO; never a further round on this brief: a replan, or the person
      return stop('rounds-out', `review r${round.n} said NO with ${round.findings} finding(s); the review rounds of this brief are used up (${used} of ${c.maxCycles})`)
    case 'BLOCKED':
      return stop('review-blocked', `the reviewer was blocked (${review.reason ?? 'see its file'})`)
    default:
      return stop('no-verdict', `review r${round.n} gave no verdict${review.reason ? ` (${review.reason})` : ''}`)
  }
}

/** One look at a cycle. Terminal, applying and supervising cycles do not move here. */
export function stepCycle(c: ForemanCycle, o: CycleObservation): CycleStep {
  switch (c.phase) {
    case 'implementing':
    case 'limit':
      return fromThread(c, o.thread, o.nowIso, o.runPaused)
    case 'reviewing':
      return fromReview(c, o.review, o)
    case 'waiting':
      if (c.waitingOn === 'thread') return fromThread(c, o.thread, o.nowIso, o.runPaused)
      // waiting on the person: only their move on the thread (a Reply) sets it going again
      if (o.thread && o.thread.state === 'working' && o.thread.sentAt !== undefined && Date.parse(o.thread.sentAt) >= Date.parse(c.phaseAt)) {
        return { cycle: moveTo(c, 'implementing', o.nowIso), effects: [], moved: true }
      }
      return { cycle: c, effects: [], moved: false }
    case 'supervising':
      // the person answered meanwhile (a Reply): their word stands, the supervisor's is dropped
      if (o.thread && o.thread.state === 'working' && o.thread.sentAt !== undefined && Date.parse(o.thread.sentAt) >= Date.parse(c.phaseAt) && c.deciding === undefined) {
        return { cycle: moveTo(c, 'implementing', o.nowIso), effects: [], moved: true }
      }
      return { cycle: c, effects: [], moved: false }
    default:
      return { cycle: c, effects: [], moved: false }
  }
}

/**
 * A checked decision on the stop the cycle supervises: its phase, and what
 * register.tsx carries out. An answer or a replan is an intent (`deciding`)
 * until the message reaches the thread; a re-review asks for the next round;
 * an escalation waits for the person with the supervisor's question.
 */
export function decide(c: ForemanCycle, d: Decision, by: ForemanDecisionNote['by'], nowIso: string): CycleStep {
  const stop: ForemanStop = c.supervising ?? { kind: 'question', part: c.part, text: '' }
  switch (d.decision) {
    case 'answer': {
      const cy: ForemanCycle = { ...c, deciding: { decision: 'answer', text: d.text, at: nowIso }, decisions: keep(c, note(stop, 'answer', by, nowIso, d.text, d.reason)), updatedAt: nowIso }
      return { cycle: cy, effects: [{ kind: 'send', text: answerMessage(d.text) }, { kind: 'notify', text: `${c.id}: the supervisor answered the implementer: ${d.text.replace(/\s+/g, ' ').slice(0, 200)}`, level: 'info' }], moved: false }
    }
    case 'replan': {
      const cy: ForemanCycle = { ...c, replanned: true, roundBase: c.rounds.length, deciding: { decision: 'replan', text: d.text, at: nowIso }, decisions: keep(c, note(stop, 'replan', by, nowIso, d.text, d.reason)), updatedAt: nowIso }
      return { cycle: cy, effects: [{ kind: 'replan', text: d.text }, { kind: 'notify', text: `${c.id}: the supervisor replanned the part (its review rounds start again): ${d.text.replace(/\s+/g, ' ').slice(0, 160)}`, level: 'info' }], moved: false }
    }
    case 're-review': {
      const cy = moveTo(c, 'reviewing', nowIso, { reviewRequestedAt: nowIso, reviewAfter: c.rounds.length, decisions: keep(c, note(stop, 're-review', by, nowIso, undefined, d.reason)) })
      return { cycle: cy, effects: [{ kind: 'review', n: c.rounds.length + 1 }], moved: true }
    }
    case 'next-part':
    case 'escalate': {
      const reason = d.decision === 'escalate' ? `${d.reason}${d.question && d.question !== d.reason ? `: ${d.question}` : ''}` : 'the supervisor said the part is done, which only a review can say'
      const why = d.decision === 'escalate' ? d.reason : reason
      const cy = moveTo(c, 'waiting', nowIso, { waitingOn: 'person', reason: `the supervisor escalates: ${reason}`.slice(0, 600), decisions: keep(c, note(stop, 'escalate', by, nowIso, d.decision === 'escalate' ? d.question : undefined, why)) })
      return { cycle: cy, effects: [{ kind: 'notify', text: `${c.id}: waiting for you, the supervisor escalates: ${reason.replace(/\s+/g, ' ').slice(0, 300)}`, level: 'stop' }], moved: true }
    }
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
