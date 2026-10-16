// The supervisor (D-68): at a stop, and only there, foreman asks a fresh
// `claude -p` process that can read the repo and the plan what to do, from a
// closed set, under an authority table. Pure: the stops, the table (one source
// for the prompt and for the code's own checks), the brief, the reading of its
// JSON, and the checks that turn a decision into `escalate` when it oversteps.

import type { ForemanStop, ForemanStopKind } from '../../types'
import { fill } from './roles'

/** Why a part stopped (types/index.d.ts): a question, a blocker, no result, a failure the implementer reports; the last NO; a blocked reviewer; no verdict. */
export type StopKind = ForemanStopKind

/** A stop: its kind, the implementer's or the review's words (data, not instructions), the review it follows. */
export type Stop = ForemanStop

export type DecisionKind = 'answer' | 're-review' | 'replan' | 'escalate'

/** Every decision carries its `reason`, for the person (the pane's Why); an escalation's is required. */
export type Decision =
  | { decision: 'answer'; text: string; reason?: string }
  | { decision: 're-review'; reason?: string }
  | { decision: 'replan'; text: string; reason?: string }
  | { decision: 'escalate'; reason: string; question: string }

/** Supervisor runs a part may spend; the next stop goes to the person (D-68). */
export const SUPERVISOR_BUDGET = 6
/** An answer is at most this long (D-68 safeguard 3). */
export const ANSWER_MAX = 1000
/** A replan's guidance is at most this long. */
export const REPLAN_MAX = 4000
/** The review the brief carries: its first lines only (criterion 6 of Phase 3). */
export const REVIEW_LINES = 200

/** What the supervisor decides on its own (the prompt's list; the code checks the other side). */
export const DECIDES_ALONE: readonly string[] = [
  'questions whose answer is in the plan, the repo\'s rules or the code',
  'a choice between options that the plan and its acceptance criteria both allow',
  'the order of the steps',
  'retrying after a transient failure (network, a service, a flaky test), up to 2 times',
  'asking for another review',
  'a new plan for the part (replan) within its scope, once per part',
]

/**
 * What always goes to the person, row by row: the label the prompt shows and
 * the words that turn an answer that touches it into `escalate`, by code
 * (D-68 safeguard 3). The table is the one source: the prompt is filled from
 * it, and a test checks every row against both.
 */
export const ALWAYS_ESCALATE: readonly { id: string; label: string; words?: RegExp }[] = [
  { id: 'credentials', label: 'credentials, tokens, logins', words: /\b(credentials?|passwords?|tokens?|api[ _-]?keys?|secrets?|log ?ins?|sign ?ins?|ssh[ -]keys?)\b/i },
  { id: 'outside', label: 'writes outside the repo or the plan\'s worktree (other repos, the user\'s settings, ~)', words: /(\b(other|another) repo(sitor(y|ies))?\b|\boutside (the|this) (repo|repository|worktree)\b|~[\\/]|%USERPROFILE%|\$HOME\b|\.claude[\\/](settings|plugins)|\bC:\\Users\\)/i },
  { id: 'scope', label: 'scope changes (add or drop parts, change the acceptance criteria)', words: /\b(add (a |an |another |one more )?part|(drop|remove|skip) (the |a |this )?part|(change|relax|loosen|drop|rewrite) (the )?(acceptance )?criteri(a|on)|out of scope|change (the )?scope)\b/i },
  { id: 'delivery', label: 'delivery outside the repo\'s rules or when the profile sets none (push, pull request, merge, tag, release, deleting branches)', words: /(\b(push(es|ed|ing)?|pull requests?|merg(e|es|ed|ing)|publish(es|ed|ing)?|git tag|gh pr)\b|\bPR\b|\b(create|cut|make|publish) (a |the )?release\b|\bdelete (the |a )?branch)/i },
  { id: 'destructive', label: 'destructive operations (mass deletes, reset --hard, push --force, dropping databases, stopping others\' services)', words: /(rm\s+-rf|reset\s+--hard|--force|\bforce\b|\bdelete\b|drop\s+(table|database|schema)|truncate\s+table|\bwipe\b|mass[- ]delet|kill\s+(the\s+)?(service|process)|stop\s+(the\s+)?(service|server|container)s?)/i },
  { id: 'permissions', label: 'permissions and trust (settings, hooks, trust)', words: /\b(settings|permissions?|allow ?list|hooks?|trust(ed)?|bypass|dangerously)\b/i },
  { id: 'spend', label: 'spending above the plan\'s budget', words: /\b(budget|billing|paid|purchase|subscription|spend more|upgrade (the )?plan)\b/i },
  { id: 'human', label: 'anything the plan marks "human decision", "pause" or the like', words: /\b(decisi[oó]n humana|human decision|the person decides|pausa|pause)\b/i },
  { id: 'repeat', label: 'the third escalation in a row of the same question' },
]

/** The decisions a stop allows (the rest is `escalate`, by code). */
export function allowedFor(stop: Stop, ctx: { replanned: boolean; roundsLeft: number }): DecisionKind[] {
  const replan: DecisionKind[] = ctx.replanned ? [] : ['replan']
  switch (stop.kind) {
    case 'question':
    case 'blocked':
    case 'no-result':
    case 'failed':
      return ['answer', ...replan, 'escalate']
    case 'rounds-out':
      return [...replan, 'escalate']
    case 'review-blocked':
    case 'no-verdict':
      return [...(ctx.roundsLeft > 0 ? (['re-review'] as DecisionKind[]) : []), ...replan, 'escalate']
  }
}

/** Why a stop goes to the person without asking the supervisor, or undefined to ask it. */
export function escalateFirst(stop: Stop, ctx: { runs: number; replanned: boolean; roundsLeft: number; sameQuestionBefore: number }): string | undefined {
  if (ctx.runs >= SUPERVISOR_BUDGET) return `the supervisor's budget for this part is spent (${SUPERVISOR_BUDGET} runs)`
  if (stop.kind === 'question' && ctx.sameQuestionBefore >= 2) return 'the third time the implementer asks the same question'
  if (allowedFor(stop, ctx).every(d => d === 'escalate')) return stop.kind === 'rounds-out' ? 'the review rounds are used up and the part was replanned already' : 'nothing but the person can answer it'
  return undefined
}

/** A text the implementer wrote, fenced as data: a closing tag inside it cannot end the fence. */
export function asData(tag: string, text: string): string {
  const safe = text.split(`</${tag}>`).join(`<\\/${tag}>`)
  return `<${tag}>\n${safe.trim()}\n</${tag}>`
}

const STOP_WORDS: Record<StopKind, string> = {
  'question': 'The implementer asked a question',
  'blocked': 'The implementer says it is blocked',
  'no-result': 'The implementer ended its turn without a foreman-result block',
  'failed': 'The implementer says it failed',
  'rounds-out': 'The last review round said NO',
  'review-blocked': 'The reviewer was blocked',
  'no-verdict': 'The review ended without a verdict',
}

const DECISION_HELP: Record<DecisionKind, string> = {
  'answer': '`{"decision":"answer","text":"…","reason":"…"}`: your answer to the implementer, at most 1000 characters, plain sentences, no code blocks and no commands to run',
  're-review': '`{"decision":"re-review","reason":"…"}`: run the review again',
  'replan': '`{"decision":"replan","text":"…","reason":"…"}`: a new plan for this part, within its scope, that the implementer works from; once per part, and the part gets its review rounds again',
  'escalate': '`{"decision":"escalate","reason":"…","question":"…"}`: the person decides; the question you would ask them',
}

export type SupervisorBriefVars = {
  plan: string
  part: string
  partTitle: string
  partText: string
  criteria: readonly string[]
  stop: Stop
  /** The review's text, whole: the brief keeps its first REVIEW_LINES lines. */
  reviewText?: string
  /** The delivery rule of the profile, in words. */
  delivery: string
  allowed: readonly DecisionKind[]
  /** Earlier decisions on this part, one line each. */
  history: readonly string[]
  runsLeft: number
}

/** The supervisor's brief: the prompt file filled. Never the thread's transcript; the implementer's words and the review fenced as data (D-68 safeguard 2). */
export function supervisorBrief(template: string, v: SupervisorBriefVars): string {
  const reviewLines = v.reviewText?.split(/\r?\n/) ?? []
  const review = v.reviewText === undefined
    ? 'none'
    : `\`${v.stop.reviewFile ?? ''}\`, its first ${Math.min(REVIEW_LINES, reviewLines.length)} of ${reviewLines.length} lines:\n${asData('review', reviewLines.slice(0, REVIEW_LINES).join('\n'))}`
  return fill(template, {
    plan: v.plan,
    part: v.part,
    partTitle: v.partTitle,
    partText: v.partText.trim(),
    criteria: v.criteria.length ? v.criteria.map(c => `- ${c}`).join('\n') : '- The plan names no acceptance criteria for this part: its text is what the work is checked against.',
    stop: `${STOP_WORDS[v.stop.kind]}${v.stop.round !== undefined ? ` (review round ${v.stop.round})` : ''}.`,
    implementer: asData('implementer-text', v.stop.text || '(nothing)'),
    review,
    delivery: v.delivery,
    decidesAlone: DECIDES_ALONE.map(d => `- ${d}`).join('\n'),
    escalateAlways: ALWAYS_ESCALATE.map(r => `- ${r.label}`).join('\n'),
    allowed: v.allowed.map(d => `- ${DECISION_HELP[d]}`).join('\n'),
    history: v.history.length ? v.history.map(h => `- ${h}`).join('\n') : '- none',
    runsLeft: String(v.runsLeft),
  }).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** The supervisor's JSON, from the end of its answer (a fenced block or a bare object). */
export function parseDecision(result: string): { decision: Decision } | { why: string } {
  const candidates = [...result.matchAll(/\{[^{}]*"decision"[^{}]*\}/g)].map(m => m[0])
  const last = candidates.at(-1)
  if (!last) return { why: 'no decision JSON in its answer' }
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch (err) {
    return { why: `its decision is not JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const o = raw as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : undefined)
  const why = str('reason') ? { reason: (str('reason') as string).slice(0, 600) } : {}
  switch (o.decision) {
    case 'answer': return str('text') ? { decision: { decision: 'answer', text: str('text') as string, ...why } } : { why: 'an answer with no text' }
    case 're-review': return { decision: { decision: 're-review', ...why } }
    case 'replan': return str('text') ? { decision: { decision: 'replan', text: str('text') as string, ...why } } : { why: 'a replan with no text' }
    case 'escalate': return { decision: { decision: 'escalate', reason: str('reason') ?? 'the supervisor escalated', question: str('question') ?? str('reason') ?? '' } }
    default: return { why: `"${String(o.decision)}" is not one of answer, re-review, replan, escalate` }
  }
}

/** A line of an answer that reads as a command to run. */
const COMMAND_LINE = /^\s*(\$ |> |#!|sudo\b|git\s|npm\s|npx\s|pnpm\s|yarn\s|node\s|python3?\s|pip\s|rm\s|del\s|curl\s|wget\s|powershell|pwsh\b|cmd(\.exe)?\s|bash\s|sh\s|Remove-Item|Set-Item|Invoke-|Start-Process|docker\s|kubectl\s|gh\s)/im

const DELIVERING = String.raw`(?:push(?:es|ed|ing)?|merg(?:e|es|ed|ing)|publish(?:es|ed|ing)?|open(?:ing)? (?:a |the )?(?:pull request|PR)|(?:a |the )?(?:pull requests?|PR))`
/**
 * A reminder of the delivery rule, negated ("do not push, open a pull request
 * or merge", "nothing is pushed"), is not a delivery decision: a live answer
 * from the plan that ended on one went to the person (Phase 3 smoke run).
 * Only that phrase is set aside; every other mention of the row still counts.
 */
const NOT_DELIVERING = new RegExp(String.raw`\b(?:(?:do|does|must|should|will) not|don't|doesn't|mustn't|shouldn't|won't|never|not|no|nor)(?: to)? ${DELIVERING}(?:(?:,\s*|\s+or\s+|\s+nor\s+|,\s*or\s+)${DELIVERING})*|\bnothing (?:is|gets|was|will be) (?:pushed|merged|published)\b`, 'gi')

/** The escalation rows a text touches, by their words. */
export function touchedRows(text: string): string[] {
  return ALWAYS_ESCALATE.filter(r => r.words?.test(r.id === 'delivery' ? text.replace(NOT_DELIVERING, ' ') : text)).map(r => r.id)
}

/**
 * The code's last word on a decision (D-68 safeguard 3): one the stop does not
 * allow, an answer too long, with a code block or a line that reads as a
 * command, or any text that touches a row of the escalation table, becomes
 * `escalate`, with the reason.
 */
export function checkDecision(d: Decision, allowed: readonly DecisionKind[], question: string): Decision {
  const up = (reason: string): Decision => ({ decision: 'escalate', reason: `foreman: ${reason}`, question: question || reason })
  if (!allowed.includes(d.decision)) return up(`the supervisor chose "${d.decision}", which this stop does not allow (${allowed.join(', ')})`)
  if (d.decision === 'answer') {
    // a question about a row of the table is the person's, whatever the answer says (seen live: "No, do not push")
    const asked = touchedRows(question)
    if (asked.length) return up(`the question touches what always goes to the person (${asked.join(', ')})`)
    if (d.text.length > ANSWER_MAX) return up(`the supervisor's answer is ${d.text.length} characters (at most ${ANSWER_MAX})`)
    if (/```/.test(d.text)) return up('the supervisor\'s answer holds a code block')
    if (COMMAND_LINE.test(d.text)) return up('the supervisor\'s answer holds a line that reads as a command')
  }
  if (d.decision === 'replan' && d.text.length > REPLAN_MAX) return up(`the supervisor's replan is ${d.text.length} characters (at most ${REPLAN_MAX})`)
  if (d.decision === 'answer' || d.decision === 'replan') {
    const rows = touchedRows(d.text)
    if (rows.length) return up(`the supervisor's ${d.decision} touches what always goes to the person (${rows.join(', ')})`)
  }
  return d
}

/** A line of decisions.jsonl (D-68): what stopped, what was decided, by whom, at what cost. */
export type DecisionRecord = {
  at: string
  part: string
  stop: StopKind
  by: 'supervisor' | 'code'
  decision: DecisionKind
  text?: string
  reason?: string
  question?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costUsd?: number
  durationMs?: number
}

/** One line of the history the next brief carries. */
export function historyLine(r: DecisionRecord): string {
  const said = r.decision === 'answer' || r.decision === 'replan' ? `: ${(r.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}` : r.decision === 'escalate' ? `: ${(r.reason ?? '').slice(0, 160)}` : ''
  return `${r.at.slice(11, 16)} ${r.stop} → ${r.decision} (${r.by})${said}`
}
