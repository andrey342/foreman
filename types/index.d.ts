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
  closed?: boolean
}

export type ForemanReview = { n: number; file: string; verdict: 'OK' | 'NO' | 'BLOCKED'; findings: number }

export type ForemanCycle = {
  runId: string
  part: string
  plan: string
  level: ForemanLevel
  implThread: string
  reviews: ForemanReview[]
  phase: 'implementing' | 'reviewing' | 'applying' | 'ready' | 'waiting' | 'closed'
  maxCycles: number
  reason?: string
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
      cycle: ForemanCycle | null
      warnings: string[]
    }
  }
}
