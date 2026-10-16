// What a thread driver is (plan §8, D-69): how foreman starts, messages,
// stops and opens a thread, and how it reads the thread's row and turn. Pure:
// a driver builds argv and reads rows and transcript facts; register.tsx runs
// the commands. 0.2 has one driver, `background` (D-85).

import type { ForemanAgentRow, ForemanThread } from '../../../types'
import type { TranscriptFacts } from '../transcript'

export type LaunchSpec = {
  exe: string
  name: string
  model: string
  effort: string
  permissionMode: string
  /** The one-line prompt that points the thread to its brief file (D-69). */
  brief: string
  /** The plugin's folder, when foreman runs from a folder (`--plugin-dir`) rather than installed: the thread loads it too, for its guards. */
  pluginDir?: string
  /** The `permissions.allow` the thread inherits (M7): the repo's effective rules plus foreman's short list. */
  allow?: readonly string[]
}

/** A command to run, and whether foreman waits for it (`run`) or lets it go (`spawn`). */
export type DriverCommand = { argv: string[]; env?: Record<string, string>; wait: boolean }

/** The steps an action takes on a thread as its row stands, or why it cannot be taken now. */
export type Steps<S extends string> = { steps: S[] } | { refuse: string }

export type ThreadDriver = {
  readonly name: 'background'
  launchArgv(s: LaunchSpec): string[]
  /** The short id the launch printed, and whether the CLI started a copy instead of resuming. */
  parseLaunched(stdout: string): { id: string; isCopy: boolean } | undefined
  resumeArgv(exe: string, sessionId: string, text: string): string[]
  stopArgv(exe: string, id: string): string[]
  logsArgv(exe: string, id: string): string[]
  /** What puts the thread in the desktop app's sidebar (F0-4); undefined for a session id that is not one. */
  openCommand(exe: string, sessionId: string, isWindows: boolean): DriverCommand | undefined
  sendPlan(row: ForemanAgentRow | undefined): Steps<'stop' | 'resume'>
  openPlan(row: ForemanAgentRow | undefined): Steps<'stop' | 'open'>
  /** The thread's row in `claude agents --json --all`, found by its session id first (A-08). */
  rowOf(t: ForemanThread, rows: readonly ForemanAgentRow[]): ForemanAgentRow | undefined
  /** The row counts against `limits.maxParallelThreads`: live and mid-turn, or just started. */
  isBusy(row: ForemanAgentRow, now: number): boolean
  isTurnOver(t: ForemanThread, row: ForemanAgentRow | undefined, facts: TranscriptFacts | undefined): boolean
  /** Where the transcript may be, most likely first: under the row's cwd (a worktree's own project folder, D-88), then the thread's. */
  transcriptCandidates(projects: string, t: ForemanThread, row: ForemanAgentRow | undefined): string[]
}
