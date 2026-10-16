// foreman's type contract: the values it keeps in $.state, and the shapes of
// its profile, plans, threads and cycles. Self-contained: no imports.

/** implementer: a background thread; reviewer and supervisor: fresh one-shot runs foreman starts (plan D-68, D-73). */
export type ForemanRole = 'implementer' | 'reviewer' | 'supervisor'
export type ForemanEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ForemanPermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan'

/** A row of `claude agents --json`, as the CLI prints it. */
export type ForemanAgentRow = {
  id?: string
  sessionId: string
  name?: string
  cwd: string
  kind: string
  startedAt: number
  pid?: number
  status?: string
  waitingFor?: string
  state?: string
}

export type ForemanThreadState = 'working' | 'ready' | 'waiting' | 'blocked' | 'limit' | 'done' | 'stopped' | 'failed'

export type ForemanThreadResult = {
  status: 'done' | 'blocked' | 'question' | 'failed'
  summary: string
  commits?: string[]
  gates?: { cmd: string; exit: number }[]
  question?: string
  files?: string[]
  /** Who the thread asks to answer it (D-82): `human` goes straight to the person. */
  needs?: 'human' | 'supervisor'
}

export type ForemanUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }

export type ForemanThread = {
  id: string
  sessionId: string
  name: string
  role: ForemanRole
  /** The plan run it works for (its slug), or `adhoc`. */
  runId?: string
  part?: string
  cwd: string
  model: string
  effort: string
  startedAt: string
  updatedAt: string
  state: ForemanThreadState
  waitingFor?: string
  /** The last turn ended without a foreman-result block. */
  noResult?: boolean
  lastResult?: ForemanThreadResult
  usage?: ForemanUsage
  /** Newest timestamp already counted in `usage`. */
  usageSince?: string
  /** Id of the last message counted in `usage` (a message spans several rows). */
  usageLastId?: string
  /** When foreman last sent the thread a prompt (launch or a message): the turn it waits for starts after this. */
  sentAt?: string
  /** Where its transcript was last found. */
  transcript?: string
  /** The brief file its prompt points to (D-69). */
  brief?: string
  /** The session that launched or last messaged it (`owner.ts`): it toasts its moves and retries a usage limit. */
  owner?: string
  /** A usage limit's reset (from the API error row): the thread is told to go on then. */
  retryAt?: string
  /** The last line of its latest answer, for the pane. */
  lastLine?: string
  /** When Open put it in the desktop app (F0-4): the person may be answering there, so foreman does not resume it on its own. */
  openedAt?: string
  /** The person stopped it (Stop): foreman does not resume it on its own. */
  heldBy?: 'person'
  closed?: boolean
}

export type ForemanReviewKind = 'review'

/** A review by a fresh read-only reviewer: its verdict is OK, NO or BLOCKED. */
export type ForemanReview = {
  kind: ForemanReviewKind
  runId: string
  part: string
  n: number
  /** The file the reviewer writes, absolute: in the plan's folder (D-70). */
  file: string
  /** The reviewer's id while it runs: its turn.complete carries it, and the guard knows it by it. */
  agentId: string
  /** The session that started it and waits for its answer (`$.session.id()`); only it, or nobody once it is gone, settles it. */
  owner?: string
  /** How it was settled: by the reviewer's own answer, or from its file after the reviewer was gone (an answer may still overwrite that). */
  settledBy?: 'answer' | 'file'
  base?: string
  plan?: string
  startedAt: string
  finishedAt?: string
  /** `none` until it finished, and when it finished without a verdict on the file's first line. */
  verdict: 'OK' | 'NO' | 'BLOCKED' | 'none'
  findings: number
  noResult?: boolean
  reason?: string
}

export type ForemanCyclePhase = 'implementing' | 'reviewing' | 'applying' | 'supervising' | 'ready' | 'waiting' | 'limit' | 'closed'

/** Why a part stopped, as the supervisor is asked about it (D-68). */
export type ForemanStopKind = 'question' | 'blocked' | 'no-result' | 'failed' | 'rounds-out' | 'review-blocked' | 'no-verdict'

/** A stop the supervisor decides on: its kind, the implementer's or the review's words (data), the review it follows. */
export type ForemanStop = { kind: ForemanStopKind; part: string; text: string; reviewFile?: string; round?: number }

/** One decision on a part, as the cycle keeps the last few (decisions.jsonl keeps them all). */
export type ForemanDecisionNote = { at: string; stop: ForemanStopKind; decision: 'answer' | 'next-part' | 're-review' | 'replan' | 'escalate'; by: 'supervisor' | 'code'; text?: string }

/** One review round of a cycle: the review it bound, and its verdict once settled. */
export type ForemanCycleRound = { n: number; file: string; agentId: string; verdict: ForemanReview['verdict']; findings: number }

/** The implement → review → apply loop of one part of a plan (plan §5). */
export type ForemanCycle = {
  /** `<runId>:<part>`. */
  id: string
  runId: string
  part: string
  /** The plan, relative to the work root. */
  plan: string
  /** The commit the cycle started from: every review reads `<base>..HEAD`. */
  base: string
  implThread: string
  /** Review rounds at most (the profile's `limits.reviewRounds`). */
  maxCycles: number
  rounds: ForemanCycleRound[]
  phase: ForemanCyclePhase
  /** When the cycle entered its phase: a thread result older than this belongs to an earlier phase. */
  phaseAt: string
  /** Why it waits, in words, and on what: the thread (re-read every look) or the person (the reviews' verdict, the rounds used up). */
  reason?: string
  waitingOn?: 'thread' | 'person'
  /** The session that drives it (`owner.ts`); a session that adopts an orphan claims it first and acts from its next look. */
  owner?: string
  claimedAt?: string
  /** Intents written before an effect, so a repeat (an adoption, a reload) never does it twice. */
  reviewRequestedAt?: string
  /** How many rounds the cycle had when the review was asked for: only a round bound after it answers the request. */
  reviewAfter?: number
  applyFor?: number
  /** How many times foreman resumed its implementer after its process ended mid-turn (at most REVIVE_MAX). */
  revived?: number
  /** The stop the supervisor is deciding on (phase `supervising`), and when it began (D-68). */
  supervising?: ForemanStop & { at: string }
  /** Supervisor runs spent on this part: at most SUPERVISOR_BUDGET (D-68). */
  supervisorRuns?: number
  /** A decision being carried out (an answer or a replan to send): the intent, written before the send, so a repeat never sends twice. */
  deciding?: { decision: 'answer' | 'replan'; text: string; at: string }
  /** The part was replanned (D-67, once): its rounds count again from `roundBase`. */
  replanned?: boolean
  roundBase?: number
  /** The implementer's questions in this part, normalised: the same one a third time goes to the person (D-68). */
  asked?: string[]
  /** The last decisions on this part, for the pane, the session section and the next brief. */
  decisions?: ForemanDecisionNote[]
  startedAt: string
  updatedAt: string
}

export type ForemanPlanStatus = 'running' | 'paused' | 'done' | 'stopped'

/** One part of a plan run, as the run goes through it; `go`: the person said to start it (Next part, resume), past a pause or the review mode. */
export type ForemanPlanPart = { id: string; title: string; pauseBefore?: boolean; go?: boolean }

/** `auto` chains the parts; `review` stops at each ready part until the person presses Next part (D-66). */
export type ForemanPlanMode = 'auto' | 'review'

/** A plan worked part after part (plan §8 run.ts): one active per repo (D-71). */
export type ForemanPlanRun = {
  /** The run id: the plan's slug, with a suffix when the slug is taken (A-16). */
  id: string
  /** The plan, relative to the work root. */
  plan: string
  title: string
  /** The folder of its files (D-70), absolute. */
  dir: string
  /** The parts this run goes through, in order. */
  parts: ForemanPlanPart[]
  /** The index of the part being worked on. */
  current: number
  /** Absent: `auto`. */
  mode?: ForemanPlanMode
  status: ForemanPlanStatus
  /** Why it is paused or stopped. */
  reason?: string
  /** The session that drives it, as a cycle's owner. */
  owner?: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
}

/** A notice foreman gave (M1): `stop` waits for the person, `done` ends a plan; both also go to PushNotification. */
export type ForemanNotice = { at: string; text: string; level: 'info' | 'stop' | 'done'; push?: string }

/** The pane's own state: the review shown in it (M5), whether it opened by itself this session (D-87), and what its last button did. */
export type ForemanPaneUi = { shown?: { file: string; text: string }; offered?: boolean; lastAction?: { at: string; text: string } }

/** What the pane draws: the background sessions of this repo, as last listed. */
export type ForemanView = {
  root: string
  rows: ForemanAgentRow[]
  refreshedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    foreman: {
      view: ForemanView
      threads: ForemanThread[]
      cycles: ForemanCycle[]
      reviews: ForemanReview[]
      plans: ForemanPlanRun[]
      notices: ForemanNotice[]
      paneUi: ForemanPaneUi
      /** The tools this session called so far, by name: what `requireToolCalledBefore` guards read. */
      called: string[]
      warnings: string[]
    }
  }
}
