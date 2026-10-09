// foreman's type contract: the values it keeps in $.state, and the shapes of
// its profile, threads and cycle. Self-contained: no imports.

export type ForemanRole = 'planner' | 'implementer' | 'reviewer' | 'critic' | 'qa' | 'triage' | 'free'
export type ForemanLevel = 'N1' | 'N2' | 'N3'
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
}

export type ForemanUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }

export type ForemanThread = {
  id: string
  sessionId: string
  name: string
  role: ForemanRole
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
  /** When foreman last sent the thread a prompt (launch or tell): the turn it waits for starts after this. */
  sentAt?: string
  /** Where its transcript was last found. */
  transcript?: string
  /** The session that launched or last told it (`owner.ts`): it retries a usage limit. */
  owner?: string
  /** A usage limit's reset (from the API error row): the thread is told to go on then. */
  retryAt?: string
  closed?: boolean
}

export type ForemanReviewKind = 'review' | 'critic'

/** A review (verdict OK/NO/BLOCKED) or a critique (PASS/FAIL/BLOCKED) by a fresh subagent. */
export type ForemanReview = {
  kind: ForemanReviewKind
  runId: string
  part: string
  n: number
  /** The file the subagent writes, relative to the work root (`<runsDir>/<runId>/review-A-r2.md`). */
  file: string
  /** The subagent's id while it runs: its turn.complete carries it, and the guard knows it by it. */
  agentId: string
  /** The session that spawned it and waits for its answer (`$.session.id()`); only it, or nobody once it is gone, settles it. */
  owner?: string
  /** How it was settled: by the subagent's own answer, or from its file after the subagent was gone (an answer may still overwrite that). */
  settledBy?: 'answer' | 'file'
  base?: string
  plan?: string
  startedAt: string
  finishedAt?: string
  /** `none` until it finished, and when it finished without a verdict on the file's first line. */
  verdict: 'OK' | 'NO' | 'BLOCKED' | 'PASS' | 'FAIL' | 'none'
  findings: number
  noResult?: boolean
  reason?: string
}

export type ForemanCyclePhase = 'implementing' | 'reviewing' | 'applying' | 'ready' | 'waiting' | 'limit' | 'closed'

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
  level: ForemanLevel
  /** The commit the cycle started from: every review reads `<base>..HEAD`. */
  base: string
  implThread: string
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
  applyFor?: number
  /** Night mode when it started: one more round, parts chained. */
  night?: boolean
  startedAt: string
  updatedAt: string
}

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
      /** The tools this session called so far, by name: what `requireToolCalledBefore` guards read. */
      called: string[]
      warnings: string[]
    }
  }
}
