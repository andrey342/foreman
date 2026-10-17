// foreman: run a plan's parts as background threads, each implemented, reviewed
// and applied until its review is OK, from one chat. Entry point: registers
// /foreman, the pane and the watcher. Every call on `$` lives in this file (the
// engine follows `$` only into functions declared here, D-11); hooks/lib and
// hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ForemanAgentRow, ForemanCycle, ForemanNotice, ForemanPaneUi, ForemanPlanRun, ForemanProcessNote, ForemanReview, ForemanRole, ForemanThread, ForemanView } from '../types'
import { agentsArgv, isUnder, normPath, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs } from './lib/args'
import { REVIVE_MAX, answerMessage, applyMessage, bindRound, cycleId, decide, isActive, moveTo, pendingRequest, replanBrief, replanMessage, reviveMessage, roundsUsed, stepCycle } from './lib/cycle'
import { detect } from './lib/detect'
import type { Detected } from './lib/detect'
import { OPEN_RESUME_DELAYS_MS, OPEN_RESUME_MESSAGE, appSessionId, background, inheritedAllow } from './lib/drivers/background'
import { freeSlug, parsePlan, pickParts, planPreview, planSlug } from './lib/plan'
import type { ParsedPlan, PlanPart } from './lib/plan'
import { ONE_MODE, PROFILE_PATH, isModel, isSafeId, parseProfile, roleAt, stripJsonComments } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { preflightMessage, trustOf } from './lib/preflight'
import type { Preflight } from './lib/preflight'
import { join } from './lib/repo'
import { callOf, evaluateGuards } from './lib/guards'
import { standing } from './lib/owner'
import { nextNumber, reviewSummary, settle } from './lib/reviews'
import { checkSkills, composeBrief, gateCommands, readBrief, tellSuffix, templateName } from './lib/roles'
import { atPart, isPlanActive, partCycleId, pauseRun, progressMarkdown, resumeRun, runLine, stepPlan, stopRun } from './lib/run'
import type { NoticeLevel } from './lib/run'
import { ADHOC, PLAN_FILES, briefFile, planDir, planFile, reviewFile, storageOf } from './lib/storage'
import type { Storage } from './lib/storage'
import { LIMIT_RESUME, busyIds, parseThreadName, findThread, mergeThreads, prune, statusTable, syncThread, threadName } from './lib/threads'
import { DIRECT_READ_MAX, TAIL_BYTES, encodeCwd, projectsDir, readTranscript, sepOf, tailArgv, zeroUsage } from './lib/transcript'
import type { TranscriptFacts } from './lib/transcript'
import { TOOLS, goArgs, textOf } from './lib/tools'
import { branchFor, emptyDirRemoveArgv, freeBranch, gitArgv, inPlanWorktree, isolationFor, withExclude, worktreeListed, worktreePath } from './lib/isolation'
import type { Isolation } from './lib/isolation'
import { GH_PREFLIGHT, deliveredWords, deliveryMode, deliverySteps, existingPr, prUrl } from './lib/delivery'
import { partRanges, reportMarkdown } from './lib/report'
import { PLAN_TEMPLATE, deliveryQuestion, isolationQuestion, profileChanges, proposedChoices, setupLines, setupProfile } from './lib/setup'
import type { SetupChoices, SetupQuestion } from './lib/setup'
import type { ReportDecision } from './lib/report'
import { MAX_TURNS, gateDenials, processArgv, readProcess } from './lib/process'
import type { ProcessOutcome } from './lib/process'
import { SUPERVISOR_BUDGET, allowedFor, checkDecision, historyLine, parseDecision, supervisorBrief } from './lib/supervisor'
import type { Decision, DecisionRecord } from './lib/supervisor'
import { SENT_MS, paneTree, parseKey, replyThread, waitingLines } from './ui/pane'

const PANE_ID = 'foreman'
const PANE_TITLE = 'foreman'
/** The store is read this often, so a second chat's pane shows what the first one launched (D-79). */
const WATCH_MS = 30_000
/** With nothing open, `claude agents` and the transcripts are looked at this often at most (D-79, A-05). */
const IDLE_LIST_MS = 5 * 60_000
/** Closed threads are dropped from the registry after this (D-27). */
const KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000
/** The supervisor's process is cut after this ($.process.run's own cap is ten minutes). */
const SUPERVISOR_TIMEOUT_MS = 10 * 60_000
/** The reviewer's process is cut after this and its review "could not finish" (D-73): it runs the gates, so `$.process.spawn`. */
const REVIEW_TIMEOUT_MS = 20 * 60_000
/** A worktree's install command (`npm ci`…) is cut after this (D-71). */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Each step of a delivery (a push, `gh pr create`, a merge) is cut after this. */
const DELIVERY_STEP_MS = 120_000
/** Windows refuses a command line past 32,767 characters; a message to a thread is one argument of it. */
const MESSAGE_MAX = 30_000

// The values kept in $.state (declared in types/index.d.ts).
const view = atom({ plugin: 'foreman', key: 'view' } as const, { root: '', rows: [], refreshedAt: 0 } as ForemanView)
const threads = atom({ plugin: 'foreman', key: 'threads' } as const, [] as ForemanThread[])
const warnings = atom({ plugin: 'foreman', key: 'warnings' } as const, [] as string[])
const reviews = atom({ plugin: 'foreman', key: 'reviews' } as const, [] as ForemanReview[])
const cycles = atom({ plugin: 'foreman', key: 'cycles' } as const, [] as ForemanCycle[])
const plans = atom({ plugin: 'foreman', key: 'plans' } as const, [] as ForemanPlanRun[])
const notices = atom({ plugin: 'foreman', key: 'notices' } as const, [] as ForemanNotice[])
const paneUi = atom({ plugin: 'foreman', key: 'paneUi' } as const, {} as ForemanPaneUi)
const calledTools = atom({ plugin: 'foreman', key: 'called' } as const, [] as string[])

// Module values: a reload loses them, which costs at most one more read or listing.
// The sync in flight, so a command waits for it instead of reading what it is about to replace (D-28).
let inflight: Promise<void> | undefined
/** When `claude agents` was last listed by this session (D-79). */
let listedAt = 0
/** The profile as last read, kept while the file's mtime and size stay (A-04). */
let profileCache: { path: string; key: string; parsed: ParsedProfile } | undefined
/** The session's roots and git folder never change while it runs (A-04). */
let rootsCache: Roots | undefined
const gitDirCache = new Map<string, string | null>()
/** This process's thread name (`FOREMAN_THREAD`), read once: '' when it is not a thread. */
let threadName0: string | undefined
/** A transcript's facts, kept while the file's size and mtime stay (D-79, A-06). */
const factsCache = new Map<string, { path: string; key: string; facts: TranscriptFacts }>()
/**
 * The parts this session is starting now (their cycle ids). Starting one takes
 * seconds (a launch, the listing after it); a look of the watcher in that time
 * saw the run on a part with no cycle yet and started it again (Phase 2
 * acceptance, round 2: the second launch was refused by the thread limit and the
 * run paused). Only the run's owner starts its parts, so one session's set is enough.
 */
const partStarting = new Set<string>()

// The plugin's own settings (plugin.json userConfig, /config): the commands foreman runs without anyone
// typing come from here, never from a repo's profile (review C-13, D-57). Set by register at every load.
let settings: { claudeExe: string; fromOptions: string } = { claudeExe: '', fromOptions: '' }

/** The `claude` command: the plugin setting, else `claude` from PATH (D-06). */
function claudeExe(): string {
  return settings.claudeExe || 'claude'
}

const HELP = [
  'Usage: /foreman [command]',
  '  (none)                                  open or close the foreman pane',
  '  go <plan.md> [--parts A,B] [--model m] [--yes]',
  '                                          run the plan\'s parts in order, each in its own thread, reviewed until OK; the',
  '                                          parts chain by themselves, and a pause written in the plan waits for Continue',
  '  setup [--show] [--claude-exe <path>]    what foreman finds here, and the profile it writes after at most three questions',
  '  status                                  plans, parts, threads, reviews',
  '  pause [plan] | resume [plan]            stop chaining the plan\'s parts, or go on (past a pause the plan asks for too)',
  '  stop [plan]                             stop the plan and its thread; the branch, the worktree and the work stay',
  '  review [--part A] [--base <ref>] [--run <id>]   a fresh read-only review of the diff',
  '  help                                    this text',
  'In the chat: "foreman, run docs/plans/<file>.md", "foreman, how is it going?", "foreman, set up this repo".',
].join('\n')

/** Commands 0.2 dropped, and what to use instead (D-75, D-80): they answer with it during 0.2.x. */
const RETIRED: Record<string, string> = {
  cycle: '/foreman cycle is now /foreman go <plan.md> [--parts A,B]: it runs the plan\'s parts in order, each until its review is OK.',
  night: 'Night mode is gone in 0.2: /foreman go chains the parts by itself, and a pause written in the plan stops before the next part (/foreman resume goes on).',
  critic: 'The critic is gone in 0.2: the review of each part checks it against the plan\'s acceptance criteria (/foreman review).',
  next: 'Next part is gone: a plan\'s parts chain by themselves. Before a part the plan pauses at, Continue in the pane (or /foreman resume) goes on.',
  launch: '/foreman launch is gone in 0.2: a task is a plan. Write it in a file (docs/plans/TEMPLATE.md shows the parts; /foreman setup adds it) and run /foreman go <file>.',
  tell: '/foreman tell is gone in 0.2: answer a thread in the pane\'s "Needs you" (Send), or say it in the chat ("foreman, reply: …").',
  open: '/foreman open is gone in 0.2: the pane\'s "Open its chat", or say it in the chat ("foreman, open it").',
  log: '/foreman log is gone in 0.2: the pane\'s Details shows each thread\'s last line, and "Open its chat" its whole conversation.',
  close: '/foreman close is gone in 0.2: a thread is done when its part is, and /foreman stop <plan> ends a plan.',
  init: '/foreman init is gone in 0.2: /foreman setup writes the profile, after at most three questions.',
  profile: '/foreman profile is gone in 0.2: /foreman setup --show shows what foreman finds here and the profile in effect.',
}

/** Where the person's own `claude` path is kept when they set it from the chat (`/foreman setup --claude-exe`). */
const CLAUDE_EXE_KEY = 'claudeExe'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const firstLine = (s: string) => s.trim().slice(0, 1500)
const threadsKey = (repo: string) => `v2:threads:${normPath(repo)}`
const reviewsKey = (repo: string) => `v2:reviews:${normPath(repo)}`
const cyclesKey = (repo: string) => `v2:cycles:${normPath(repo)}`
const plansKey = (repo: string) => `plans:${normPath(repo)}`
/** The 0.1 keys: read for the status note, never written (D-80). */
const legacyKeys = (repo: string) => ['threads', 'cycles', 'reviews'].map(k => `${k}:${normPath(repo)}`)

// ---------------------------------------------------------------- repo, profile, storage

type Roots = { work: string; repo: string }

/**
 * `work`: where threads run and where the profile is read, the session's own
 * checkout (a worktree's, when the session runs in one). `repo`: the main
 * working tree, which keys the registry, so threads of every worktree of the
 * repo show together (D-29).
 */
async function roots($: EngineInterface): Promise<Roots> {
  if (rootsCache) return rootsCache
  const sessionRoot = await $.session.root()
  const info = await $.session.repo()
  const repo = info?.root ?? sessionRoot
  const work = (await $.fs.exists(join(sessionRoot, '.git'))) ? sessionRoot : repo
  rootsCache = { work, repo }
  return rootsCache
}

/**
 * The profile, read again only when the file's mtime or size changed (A-04).
 * In one of foreman's plan worktrees it is the main tree's (D-71): the profile
 * a person has not committed still holds in the plan's threads.
 */
async function loadProfile($: EngineInterface, work: string): Promise<ParsedProfile> {
  const { repo } = await roots($)
  const path = join((await isPlanTree($, work, repo)) ? repo : work, PROFILE_PATH)
  let key: string
  try {
    const st = await $.fs.stat(path)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    key = 'none'
  }
  if (profileCache && profileCache.path === path && profileCache.key === key) return profileCache.parsed
  let parsed: ParsedProfile
  if (key === 'none') parsed = parseProfile(undefined)
  else {
    try {
      parsed = parseProfile(await $.fs.read(path))
    } catch (err) {
      parsed = { ...parseProfile(undefined), source: 'file', unusable: true, warnings: [`${PROFILE_PATH}: (file): cannot be read (${errText(err)}); using the defaults`] }
    }
  }
  profileCache = { path, key, parsed }
  return parsed
}

/**
 * Whether `work` is a plan's worktree: one a registered plan names (O-2 of
 * the Phase 4 review: a folder named like one is not enough); by its name
 * only when the registry cannot be read.
 */
async function isPlanTree($: EngineInterface, work: string, repo: string): Promise<boolean> {
  if (normPath(work) === normPath(repo)) return false
  // a thread foreman launched for a plan knows its worktree by its own name (foreman:<plan>:…, in
  // .claude/worktrees/foreman-<plan>): a thread loaded with --plugin-dir has a store of its own, where the
  // coordinator's plans are not (live round of Phase 4, criterion 3)
  const run = (await threadMode($))?.split(':')[1]
  if (run && isUnder(work, join(repo, `.claude/worktrees/foreman-${run}`))) return true
  try {
    return (await storedPlans($, repo)).some(r => r.isolation === 'worktree' && r.tree !== undefined && isUnder(work, r.tree))
  } catch {
    return inPlanWorktree(work, repo)
  }
}

async function listRows($: EngineInterface): Promise<ForemanAgentRow[]> {
  return readAgents(await $.process.run(agentsArgv(claudeExe()), { timeoutMs: 30_000 }))
}

/** `git rev-parse --path-format=absolute --git-common-dir` in `work`, once per session; null outside git. */
async function gitCommonDir($: EngineInterface, work: string): Promise<string | undefined> {
  if (!gitDirCache.has(work)) {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
    const out = r?.stdout.trim()
    gitDirCache.set(work, r && r.exitCode === 0 && out ? out : null)
  }
  return gitDirCache.get(work) ?? undefined
}

async function homeDir($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
}

/** Where foreman keeps its plans' files (D-70). */
async function storageFor($: EngineInterface, work: string, parsed: ParsedProfile): Promise<Storage | undefined> {
  return storageOf({ work, gitCommonDir: await gitCommonDir($, work), runsDir: parsed.profile.runsDir, home: await homeDir($) })
}

/** The folder of a run: its plan's, or the storage's folder for it (`adhoc`, or a run 0.2 started before a reload). */
async function dirOfRun($: EngineInterface, runId: string): Promise<string | undefined> {
  const run = (await read($, plans)).find(p => p.id === runId)
  if (run) return run.dir
  const { work } = await roots($)
  const storage = await storageFor($, work, await loadProfile($, work))
  return storage && isSafeId(runId) ? planDir(storage, runId) : undefined
}

/** What the repo holds (D-71…D-74): read from its root, `.claude/` and the files that say how it works. */
async function detectRepo($: EngineInterface, work: string): Promise<Detected> {
  const names = async (dir: string) => (await $.fs.list(dir).catch(() => [])).map(e => e.name)
  const root = await names(work)
  const claude = await names(join(work, '.claude'))
  const texts: Record<string, string> = {}
  for (const f of ['package.json', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md']) {
    if (!root.some(n => n.toLowerCase() === f.toLowerCase())) continue
    const t = await $.fs.read(join(work, f)).catch(() => undefined)
    if (typeof t === 'string') texts[f] = t.slice(0, 200_000)
  }
  return detect({ root, claude, texts })
}

// ---------------------------------------------------------------- the registry

async function storedThreads($: EngineInterface, repo: string): Promise<ForemanThread[]> {
  const v = await $.store.get(threadsKey(repo))
  return Array.isArray(v) ? (v as ForemanThread[]) : []
}

/**
 * $.store is the registry every chat of the repo shares; $.state is this
 * session's copy of it. Each write re-reads the store and merges by id, so a
 * chat never drops a thread another chat launched (review C-02, D-25).
 */
async function putThreads($: EngineInterface, repo: string, changed: readonly ForemanThread[]): Promise<ForemanThread[]> {
  const now = await $.clock.now()
  const merged = prune(mergeThreads(mergeThreads(await read($, threads), await storedThreads($, repo)), changed), now, KEEP_CLOSED_MS)
  await $.store.set(threadsKey(repo), merged)
  await update($, threads, () => merged)
  return merged
}

/** Brings this session's copy up to the store: what other chats launched or saw happen. */
async function pullThreads($: EngineInterface, repo: string): Promise<ForemanThread[]> {
  const stored = await storedThreads($, repo)
  return update($, threads, cur => mergeThreads(cur, stored))
}

async function storedPlans($: EngineInterface, repo: string): Promise<ForemanPlanRun[]> {
  const v = (await $.store.get(plansKey(repo))) as { v?: number; plans?: unknown } | undefined
  return v && v.v === 2 && Array.isArray(v.plans) ? (v.plans as ForemanPlanRun[]) : []
}

/** Merges plan runs by id into the store and this session's copy: the later `updatedAt` wins (as threads, D-25). */
async function putPlans($: EngineInterface, repo: string, changed: readonly ForemanPlanRun[]): Promise<ForemanPlanRun[]> {
  const byId = new Map<string, ForemanPlanRun>()
  for (const p of [...(await read($, plans)), ...(await storedPlans($, repo)), ...changed]) {
    const cur = byId.get(p.id)
    if (!cur || Date.parse(p.updatedAt) >= Date.parse(cur.updatedAt)) byId.set(p.id, p)
  }
  const list = [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-50)
  if (changed.length) await $.store.set(plansKey(repo), { v: 2, plans: list })
  await update($, plans, () => list)
  return list
}

type RunDoc = {
  v: 2
  runId: string
  updatedAt: string
  plan?: ForemanPlanRun
  threads: ForemanThread[]
  transitions: { at: string; thread: string; from: string; to: string; note?: string }[]
  reviews: ForemanReview[]
  cycles: ForemanCycle[]
  /** The notices foreman gave about this run, with what PushNotification answered (M1). */
  notices?: ForemanNotice[]
  /** The presses on the pane's buttons for this run, as they reached foreman (criterion 8 of Phase 2). */
  presses?: { at: string; element: string; surface: string }[]
  /** The worktree's install command and how it ended (D-71). */
  prepare?: ForemanPlanRun['prepare']
  /** The delivery and each of its steps (D-72). */
  delivery?: ForemanPlanRun['delivery']
}

/**
 * Reads a run's foreman.json for an update, or a fresh one. A file that does
 * not parse is kept aside as foreman.json.broken-<time> (D-27). A repo's own
 * `runsDir` folder that resolves outside the work root yields nothing: no
 * write (C-04); `.git/foreman/` is git's own folder, no repo can link it away.
 */
async function openRunDoc($: EngineInterface, runId: string, at: string): Promise<{ path: string; doc: RunDoc } | undefined> {
  if (!isSafeId(runId)) return undefined
  const dir = await dirOfRun($, runId)
  if (!dir) return undefined
  const { work } = await roots($)
  const parsed = await loadProfile($, work)
  if (parsed.profile.runsDir && (await $.fs.exists(dir))) {
    const [real, base] = await Promise.all([$.fs.stat(dir, { resolve: true }), $.fs.stat(work, { resolve: true })])
    if (!real.realPath || !base.realPath || !isUnder(real.realPath, base.realPath)) {
      $.ui.log(`${dir} resolves outside ${work}; the run file is not written`)
      return undefined
    }
  }
  const path = planFile(dir, PLAN_FILES.record)
  let doc: RunDoc = { v: 2, runId, updatedAt: at, threads: [], transitions: [], reviews: [], cycles: [] }
  if (await $.fs.exists(path)) {
    const text = await $.fs.read(path)
    try {
      const old = JSON.parse(text) as Partial<RunDoc>
      doc = {
        ...doc,
        ...old,
        v: 2,
        threads: Array.isArray(old.threads) ? old.threads : [],
        transitions: Array.isArray(old.transitions) ? old.transitions : [],
        reviews: Array.isArray(old.reviews) ? old.reviews : [],
        cycles: Array.isArray(old.cycles) ? old.cycles : [],
      }
    } catch {
      const aside = `${path}.broken-${at.replace(/[:.]/g, '-')}`
      await $.fs.write(aside, text)
      $.ui.log(`${path} did not parse; kept it as ${aside} and started a new one`)
    }
  }
  return { path, doc }
}

/** Writes a run's foreman.json after `change` edited it; a failure is logged, never thrown. */
async function editRunDoc($: EngineInterface, runId: string, at: string, change: (doc: RunDoc) => void): Promise<void> {
  try {
    const opened = await openRunDoc($, runId, at)
    if (!opened) return
    change(opened.doc)
    opened.doc.updatedAt = at
    await $.fs.write(opened.path, JSON.stringify(opened.doc, null, 2) + '\n')
  } catch (err) {
    $.ui.log(`could not record in run ${runId}: ${errText(err)}`)
  }
}

/**
 * Records the thread and a transition in the run's foreman.json. A transition
 * the file already ends with for that thread is not written twice (two chats
 * may see the same change).
 */
async function recordRun($: EngineInterface, t: ForemanThread, from: string, note?: string): Promise<void> {
  if (!t.runId) return
  await editRunDoc($, t.runId, t.updatedAt, doc => {
    const { transcript: _t, usageSince: _u, usageLastId: _l, ...plain } = t
    doc.threads = [...doc.threads.filter(x => x.id !== t.id), plain]
    const last = [...doc.transitions].reverse().find(x => x.thread === t.id)
    // the same move twice is one (two chats saw it); a new note on it (Open, its nudge) is a line of its own
    if (!(last && last.from === from && last.to === t.state && (note === undefined || last.note === note))) {
      doc.transitions = [...doc.transitions, { at: t.updatedAt, thread: t.id, from, to: t.state, ...(note ? { note } : {}) }]
    }
  })
}

/** Records a review, started or settled, in the run's foreman.json. */
async function recordReview($: EngineInterface, r: ForemanReview): Promise<void> {
  await editRunDoc($, r.runId, r.finishedAt ?? r.startedAt, doc => {
    const same = (x: ForemanReview) => x.part === r.part && x.n === r.n
    doc.reviews = [...doc.reviews.filter(x => !same(x)), r].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  })
}

/** Records the cycle and, when its phase moved, the transition in the run's foreman.json. */
async function recordCycle($: EngineInterface, c: ForemanCycle, from: string, note?: string): Promise<void> {
  await editRunDoc($, c.runId, c.updatedAt, doc => {
    doc.cycles = [...doc.cycles.filter(x => x.id !== c.id), c]
    const key = `cycle:${c.part}`
    const last = [...doc.transitions].reverse().find(x => x.thread === key)
    if (from !== c.phase && !(last && last.from === from && last.to === c.phase && last.at === c.phaseAt)) {
      doc.transitions = [...doc.transitions, { at: c.phaseAt, thread: key, from, to: c.phase, ...(note ?? c.reason ? { note: note ?? c.reason } : {}) }]
    } else if (note && from === c.phase) {
      doc.transitions = [...doc.transitions, { at: c.updatedAt, thread: key, from, to: c.phase, note }]
    }
  })
}

/** Records the plan run itself and a transition of its status or current part. */
async function recordPlan($: EngineInterface, p: ForemanPlanRun, from: string, note?: string): Promise<void> {
  await editRunDoc($, p.id, p.updatedAt, doc => {
    doc.plan = p
    const to = `${p.status}@${p.parts[p.current]?.id ?? '-'}`
    if (from !== to || note) doc.transitions = [...doc.transitions, { at: p.updatedAt, thread: 'plan', from, to, ...(note ? { note } : {}) }]
  })
}

/** progress.md of a run (D-70), rewritten from the registry after every change. */
async function writeProgress($: EngineInterface, runId: string): Promise<void> {
  const run = (await read($, plans)).find(p => p.id === runId)
  if (!run) return
  try {
    await $.fs.write(planFile(run.dir, PLAN_FILES.progress), progressMarkdown(run, (await read($, cycles)).filter(c => c.runId === run.id), await read($, threads)))
  } catch (err) {
    $.ui.log(`could not write progress.md of ${run.id}: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------- thread mode and the session section

/**
 * The name of the foreman thread this process is, when it is one: foreman
 * launches every thread with `FOREMAN_THREAD` in its settings' `env` (SPIKE
 * addendum). In a thread foreman keeps its guards and nothing else: no
 * watcher, no /foreman, no adoption, no write to the registry (D-51). Read once.
 */
async function threadMode($: EngineInterface): Promise<string | undefined> {
  if (threadName0 === undefined) threadName0 = (await $.env.get('FOREMAN_THREAD')) || (await registeredThreadName($))
  return threadName0 === '' ? undefined : threadName0
}

/**
 * A thread Open put in the desktop app: the app runs the session with its own
 * flags, not the saved `--settings`, so `FOREMAN_THREAD` is not set there and
 * foreman loaded as a coordinator in it (Phase 2 acceptance, round 2: its tools
 * were offered to the thread's model). Its session id is a thread's in the
 * registry: that is the mark. '' when this session is no thread.
 */
async function registeredThreadName($: EngineInterface): Promise<string> {
  try {
    const me = await $.session.id()
    const { repo } = await roots($)
    return (await storedThreads($, repo)).find(t => t.sessionId === me && !t.closed)?.name ?? ''
  } catch {
    return ''
  }
}

/**
 * The plugin's folder when foreman runs from a folder (`claude --plugin-dir`),
 * not from an installation under the configuration's plugins: then a thread is
 * launched with the same `--plugin-dir`, so the profile's guards act inside it.
 * An installed foreman loads in every session by itself.
 */
async function inlinePluginDir($: EngineInterface, tree?: string): Promise<string | undefined> {
  const enabledIn = (settings: unknown) => Object.entries(((settings ?? {}) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}).some(([k, v]) => k.startsWith(`${$.plugin.name}@`) && v === true)
  if (tree !== undefined) {
    // a plan's worktree holds the committed settings only (D-71): foreman loads there by itself when they, or the
    // person's own settings, enable it; otherwise the thread gets the plugin's folder
    const committed = await $.fs.read(join(tree, '.claude/settings.json')).catch(() => undefined)
    let inTree = false
    try { inTree = typeof committed === 'string' && enabledIn(JSON.parse(committed)) } catch { /* not JSON: not enabled there */ }
    const inUser = await $.settings.read({ source: 'user' }).then(enabledIn, () => false)
    return inTree || inUser ? undefined : $.plugin.root
  }
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${((await homeDir($)) ?? '').replace(/[\\/]+$/, '')}/.claude`
  if (isUnder($.plugin.root, `${configDir}/plugins`)) return undefined
  // installed from a folder marketplace (the acceptance's project scope): enabled in the settings, it loads in the thread by itself
  try {
    const enabled = ((await $.settings.read()) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
    if (Object.entries(enabled).some(([k, v]) => k.startsWith(`${$.plugin.name}@`) && v === true)) return undefined
  } catch {
    // no settings to read: the folder is passed on, as before
  }
  return $.plugin.root
}

/**
 * The short `session` section foreman adds to the system prompt (plan §3): in
 * the main chat, the active plans and the threads waiting for the person; in a
 * thread, which thread it is. Nothing when there is nothing to say. It changes
 * only when that state changes, so the prompt cache holds between.
 */
async function sessionSection($: EngineInterface): Promise<string | undefined> {
  const name = await threadMode($)
  if (name !== undefined) {
    const { role, part } = parseThreadName(name)
    // the reviewer and the supervisor are processes whose answer has its own form: no foreman-result block (seen in a live run)
    if (role === 'reviewer') return `You are foreman's reviewer \`${name}\`, a read-only process: your answer is the review, in the form your brief gives, and nothing after it (no foreman-result block).`
    if (role === 'supervisor') return `You are foreman's supervisor \`${name}\`, a read-only process: end with the one decision JSON your brief asks for (no foreman-result block).`
    return `You are the foreman thread \`${name}\`${role ? ` (role ${role}${part ? `, part ${part}` : ''})` : ''}. End every turn with the foreman-result block.`
  }
  const open = (await read($, threads)).filter(t => !t.closed)
  const waiting = open.filter(t => ['waiting', 'blocked', 'failed', 'limit'].includes(t.state)).map(t => `${t.name} (${t.state})`)
  const active = (await read($, plans)).filter(isPlanActive).map(p => `${p.id} (${p.status}, part ${p.parts[p.current]?.id ?? '-'})`)
  const parts = (await read($, cycles)).filter(isActive)
  // D-68: what waits for the person, and what the supervisor last decided on their behalf, in a line each
  const forPerson = parts.filter(c => c.phase === 'waiting' && c.waitingOn === 'person').map(c => `${c.id}: ${(c.reason ?? '').slice(0, 160)}`)
  const decided = parts.map(c => ({ c, d: c.decisions?.at(-1) })).filter(x => x.d && x.d.by === 'supervisor' && x.d.decision !== 'escalate').map(x => `${x.c.id} at ${x.d?.at.slice(11, 16)}: ${x.d?.decision}${x.d?.text ? ` (${x.d.text.slice(0, 120)})` : ''}`)
  if (waiting.length === 0 && active.length === 0) return undefined
  return [
    'foreman runs plans in this repo as background threads (/foreman status for details).',
    ...(active.length ? [`Active plans: ${active.join(', ')}.`] : []),
    ...(forPerson.length ? [`Waiting for the person: ${forPerson.join('; ')}.`] : []),
    ...(waiting.length ? [`Threads waiting: ${waiting.join(', ')}.`] : []),
    ...(decided.length ? [`The supervisor last decided: ${decided.join('; ')}; the person can correct it with a Reply.`] : []),
  ].join(' ')
}

// What the guards' .catch may know without a $ call: whether the profile declares guards that act in this
// session. Module values: until the first call has loaded the profile, a failing guard lets the call run.
let guardsActive = false
let guardsScope: 'threads' | 'everywhere' = 'threads'

// ---------------------------------------------------------------- transcripts

async function projectsRoot($: EngineInterface): Promise<string | undefined> {
  return projectsDir({ claudeConfigDir: await $.env.get('CLAUDE_CONFIG_DIR'), home: await homeDir($) })
}

/**
 * The thread's transcript: the cached path, the encoded cwd, else, for a live
 * session only, a scan of the projects folder (it moves with a worktree). A
 * failed or exited session with nothing found is not scanned again and again (review C-03).
 */
async function findTranscript($: EngineInterface, t: ForemanThread, row: ForemanAgentRow | undefined): Promise<string | undefined> {
  if (!t.sessionId) return undefined
  if (t.transcript && (await $.fs.exists(t.transcript))) return t.transcript
  const projects = await projectsRoot($)
  if (!projects) return undefined
  // under the row's cwd first: a thread in a worktree writes to the worktree's own project folder (D-88)
  for (const p of background.transcriptCandidates(projects, t, row)) {
    if (await $.fs.exists(p)) return p
  }
  if (!row || row.pid === undefined || row.state === 'failed') return undefined
  const dirs = await $.fs.list(projects).catch(() => [])
  const prefix = encodeCwd(t.cwd)
  const ordered = [...dirs].sort((a, b) => Number(b.name.startsWith(prefix)) - Number(a.name.startsWith(prefix)))
  for (const d of ordered) {
    const sep = sepOf(projects)
    const p = `${projects}${sep}${d.name}${sep}${t.sessionId}.jsonl`
    if (await $.fs.exists(p)) return p
  }
  return undefined
}

/**
 * The transcript's facts. A file whose size and mtime did not change since the
 * last read is not read again (D-79, A-06): its facts stand, with no new usage.
 */
async function readFacts($: EngineInterface, path: string, t: ForemanThread): Promise<TranscriptFacts | undefined> {
  const opts = { since: t.usageSince, lastId: t.usageLastId }
  try {
    const { size, mtimeMs } = await $.fs.stat(path)
    const key = `${size}:${mtimeMs}`
    const seen = factsCache.get(t.id)
    if (seen && seen.path === path && seen.key === key) return { ...seen.facts, usage: zeroUsage() }
    let facts: TranscriptFacts | undefined
    if (size <= DIRECT_READ_MAX) facts = readTranscript(await $.fs.read(path), { isTail: false, ...opts })
    else {
      const isWindows = (await $.env.get('OS')) === 'Windows_NT'
      const tail = tailArgv(path, TAIL_BYTES, isWindows)
      const r = await $.process.run(tail.argv, { timeoutMs: 30_000, ...(tail.env ? { env: tail.env } : {}) })
      if (r.exitCode !== 0) return undefined
      facts = readTranscript(r.stdout, { isTail: true, ...opts })
    }
    factsCache.set(t.id, { path, key, facts })
    return facts
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- the watcher

/** One sync at a time: a caller while one runs gets that one (D-28). */
function sync($: EngineInterface, force = false): Promise<void> {
  if (!inflight) inflight = syncOnce($, force).finally(() => { inflight = undefined })
  return inflight
}

/** A sync that starts after now and lists the sessions: waits for the one in flight, then runs another. */
async function syncFresh($: EngineInterface): Promise<void> {
  if (inflight) await inflight.catch(() => undefined)
  await sync($, true)
}

/** Starts a sync nobody awaits; a failure goes to the debug log, never unhandled. */
function spawnSync($: EngineInterface, force = false): void {
  sync($, force).catch(err => $.ui.log(`sync failed: ${errText(err)}`, { to: 'debug' }))
}

/** Whether anything of the repo is open: what makes the watcher list sessions every look (D-79). */
async function workOpen($: EngineInterface): Promise<boolean> {
  const t = (await read($, threads)).some(x => !x.closed && !['done', 'stopped', 'failed'].includes(x.state))
  const c = (await read($, cycles)).some(isActive)
  // a finished plan whose delivery has not run is work too: the next look delivers it, not one five minutes later (live round of Phase 4)
  const p = (await read($, plans)).some(x => isPlanActive(x) || (x.status === 'done' && x.delivery !== undefined && (x.delivery.state === undefined || x.delivery.state === 'pending')))
  const r = (await read($, reviews)).some(x => !x.finishedAt)
  return t || c || p || r
}

/**
 * One look. The store is read every time (another chat's launches show here);
 * `claude agents` and the transcripts only while something is open, when asked
 * (a command, the pane) or every IDLE_LIST_MS (D-79).
 */
async function syncOnce($: EngineInterface, force: boolean): Promise<void> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  await update($, warnings, () => parsed.warnings)
  const now = await $.clock.now()
  const current = await pullThreads($, repo)
  await putCycles($, repo, [])
  await putPlans($, repo, [])
  if (!force && !(await workOpen($)) && now - listedAt < IDLE_LIST_MS) {
    $.ui.status(await statusText($, (await read($, view)).rows))
    return
  }
  let rows: ForemanAgentRow[]
  try {
    rows = await listRows($)
    listedAt = now
  } catch (err) {
    await update($, view, v => ({ ...v, root: repo, refreshedAt: now, error: `Could not list background sessions: ${errText(err)}` }))
    return
  }
  const mine = repoRows(rows, repo, now)
  await update($, view, () => ({ root: repo, rows: mine, refreshedAt: now }))
  const me = await $.session.id()
  const nowIso = new Date(now).toISOString()
  const changed: ForemanThread[] = []
  const moved: { t: ForemanThread; from: string }[] = []
  for (const t of current) {
    if (t.closed || t.state === 'done') continue
    // by session id: once Open put the thread in the app, its row is the app's (D-69, A-08)
    const row = background.rowOf(t, rows)
    const base = row && !t.sessionId ? { ...t, sessionId: row.sessionId } : t
    const transcript = await findTranscript($, base, row)
    const facts = transcript ? await readFacts($, transcript, base) : undefined
    const s = syncThread({ ...base, ...(transcript ? { transcript } : {}) }, row, facts, nowIso)
    if (s.changed || transcript !== t.transcript || base !== t) changed.push(s.thread)
    if (s.thread.state !== s.from) moved.push({ t: s.thread, from: s.from })
  }
  if (changed.length) await putThreads($, repo, changed)
  for (const m of moved) {
    await recordRun($, m.t, m.from)
    // only the thread's owner says it moved: every chat of the repo sees the move (A-11); quiet keeps it to the pane (D-66)
    if (parsed.profile.notify.toast && !parsed.profile.notify.quiet && m.t.owner === me) $.ui.toast(`${m.t.name} → ${m.t.state}${m.t.waitingFor ? ` (${m.t.waitingFor.slice(0, 80)})` : ''}`)
  }
  try {
    await retryLimits($, repo, rows, now)
    await advanceCycles($, repo, parsed, rows, nowIso)
    await advancePlans($, repo, parsed, rows)
  } catch (err) {
    $.ui.log(`the plan step failed: ${errText(err)}`)
  }
  $.ui.status(await statusText($, mine))
}

/** The status line: the threads' states, then the active plans, a paused one by what it waits for (M1). */
async function statusText($: EngineInterface, mine: readonly ForemanAgentRow[]): Promise<string | undefined> {
  const active = (await read($, plans)).filter(isPlanActive)
  const paused = active.filter(p => p.status === 'paused')
  const planPart = active.length === 0 ? ''
    : paused.length ? `${active.length} plan${active.length > 1 ? 's' : ''}, ${paused.length} paused: ${paused[0]?.reason?.slice(0, 60) ?? ''}`
    : `${active.length} plan${active.length > 1 ? 's' : ''}`
  return [threadStatus(await read($, threads)) ?? statusLine(mine), planPart].filter(Boolean).join(' · ') || undefined
}

function threadStatus(list: readonly ForemanThread[]): string | undefined {
  const open = list.filter(t => !t.closed)
  const n = (states: string[]) => open.filter(t => states.includes(t.state)).length
  const parts = [
    n(['working']) ? `${n(['working'])} working` : '',
    n(['waiting', 'blocked', 'failed']) ? `${n(['waiting', 'blocked', 'failed'])} waiting` : '',
    n(['ready']) ? `${n(['ready'])} ready` : '',
    n(['limit']) ? `${n(['limit'])} at limit` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

// ---------------------------------------------------------------- threads

async function togglePane($: EngineInterface): Promise<string> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE_ID)
  if (isOpen) {
    await $.ui.close({ id: PANE_ID })
    return 'foreman pane closed.'
  }
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  await syncFresh($)
  return opened.isPlaced ? 'foreman pane opened.' : 'foreman pane is waiting for room: widen the terminal.'
}

async function readPrompt($: EngineInterface, name: string): Promise<string | undefined> {
  try {
    return await $.fs.read(`${$.plugin.root}/prompts/${name}`)
  } catch {
    return undefined
  }
}

/** The skill names the session can run (skills are listed as commands); undefined when it cannot say. */
async function knownSkills($: EngineInterface): Promise<Set<string> | undefined> {
  try {
    return new Set((await $.command.list()).map(c => c.name))
  } catch {
    return undefined
  }
}

/**
 * The permissions a thread inherits (M7): the `permissions.allow` the engine
 * reads for this session, merged over every source (it holds the repo's
 * settings.local.json, which a worktree does not see, F0-9), plus foreman's
 * short list and one rule per gate. Nothing is widened past the repo's own
 * rules but that list; a failure to read leaves the list alone.
 */
async function threadAllow($: EngineInterface, p: ParsedProfile['profile'], detected: readonly string[]): Promise<string[]> {
  let repoAllow: unknown
  try {
    repoAllow = ((await $.settings.read()) as { permissions?: { allow?: unknown } }).permissions?.allow
  } catch {
    repoAllow = undefined
  }
  return inheritedAllow(repoAllow, gateCommands(p, detected))
}

type LaunchOptions = {
  role: ForemanRole
  task: string
  runId: string
  part?: string
  plan?: string
  planPart?: PlanPart
  model?: string
  effort?: string
  /** The folder it works in: the plan's worktree, else the session's checkout. */
  cwd?: string
  /** The plan's branch, which the thread works on and must not leave (D-71). */
  branch?: string
}

/** What a thread on a plan's branch is told: where it works, and that the branch is foreman's to make and deliver (D-71). */
const branchNote = (cwd: string, branch: string, worktree: boolean) =>
  `## Where you work\n\n${worktree ? `In \`${cwd}\`, the worktree foreman made for this plan, on` : 'On'} the branch \`${branch}\`, which foreman made for this plan as the repo's rules ask: commit there. Do not create, switch or delete branches, and do not push: foreman delivers the branch when the plan is done.\n`

/**
 * Starts a background thread on a brief written to its run's folder (D-69):
 * the work behind each part of a plan.
 */
async function launchThread($: EngineInterface, o: LaunchOptions): Promise<{ thread: ForemanThread; mode: string; missing: string[] } | { error: string }> {
  const { work, repo } = await roots($)
  const cwd = o.cwd ?? work
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const now = await $.clock.now()
  // every session under the repo: a thread Open put in the app is an interactive row, found by its session id
  const rows = (await listRows($)).filter(r => isUnder(r.cwd, repo))
  const known = await pullThreads($, repo)
  const busy = busyIds(known, rows, now)
  if (busy.length >= p.limits.maxParallelThreads) {
    const names = busy.map(id => known.find(t => t.id === id)?.name ?? rows.find(r => r.id === id)?.name ?? id)
    return { error: `maxParallelThreads is ${p.limits.maxParallelThreads} and ${names.join(', ')} is still busy. Wait, /foreman stop it, or raise limits.maxParallelThreads in ${PROFILE_PATH}.` }
  }
  const dir = await dirOfRun($, o.runId)
  if (!dir) return { error: 'No place for foreman\'s files: this folder is not in a git repository, and no home folder is known.' }
  const rc = roleAt(p, o.role)
  const skills = checkSkills(rc.skills, await knownSkills($))
  const template = (await readPrompt($, templateName(o.role))) ?? '{{task}}'
  const common = [(await readPrompt($, '_rules.md')) ?? '', (await readPrompt($, '_result.md')) ?? '']
  const detected = await detectRepo($, work)
  const brief = composeBrief(template, common, p, o.role, {
    task: o.task,
    ...(o.plan ? { plan: o.plan } : {}),
    ...(o.part ? { part: o.part } : {}),
    ...(o.planPart ? { partTitle: o.planPart.title, partText: o.planPart.text, criteria: o.planPart.criteria } : { partText: o.task }),
    progress: planFile(dir, PLAN_FILES.progress),
    skills: skills.kept,
    detectedGates: detected.gates,
  }) + (o.branch ? `\n${branchNote(cwd, o.branch, cwd !== work)}` : '')
  const at = new Date(await $.clock.now()).toISOString()
  const briefPath = planFile(dir, briefFile(o.part ?? `t${at.replace(/\D/g, '').slice(0, 14)}`))
  await $.fs.write(briefPath, brief)
  const name = threadName(o.runId, o.role, o.part)
  const model = o.model ?? rc.model
  const effort = o.effort ?? rc.effort
  const pluginDir = await inlinePluginDir($, cwd !== work ? cwd : undefined)
  const allow = await threadAllow($, p, detected.gates)
  // a plan's thread works in the plan's tree (D-71): its worktree, or this checkout
  const argv = background.launchArgv({ exe: claudeExe(), name, model, effort, permissionMode: rc.permissionMode, brief: readBrief(briefPath), allow, ...(pluginDir ? { pluginDir } : {}) })
  const sentAt = new Date(await $.clock.now()).toISOString()
  const r = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
  const launched = r.exitCode === 0 ? background.parseLaunched(r.stdout) : undefined
  if (!launched) return { error: `claude --bg failed (exit ${r.exitCode}):\n${firstLine(r.stderr || r.stdout)}` }
  const row = (await listRows($).catch(() => [] as ForemanAgentRow[])).find(x => x.id === launched.id)
  const thread: ForemanThread = {
    id: launched.id,
    sessionId: row?.sessionId ?? '',
    name,
    role: o.role,
    runId: o.runId,
    ...(o.part ? { part: o.part } : {}),
    cwd,
    model,
    effort,
    startedAt: sentAt,
    updatedAt: sentAt,
    sentAt,
    brief: briefPath,
    owner: await $.session.id(),
    state: 'working',
  }
  await putThreads($, repo, [thread])
  await recordRun($, thread, 'none', 'launched')
  spawnSync($, true)
  return { thread, mode: rc.permissionMode, missing: skills.missing }
}

/**
 * What closes every message foreman sends a thread (Send, foreman_reply, the
 * tools, an apply, a revive): a short re-brief, where its part and its notes
 * are, then the rules (M8's short form; the review's answer asked for it).
 */
async function rebrief($: EngineInterface, t: ForemanThread): Promise<string> {
  const run = t.runId ? (await read($, plans)).find(p => p.id === t.runId) : undefined
  return tellSuffix({
    ...(t.part ? { part: t.part } : {}),
    ...(run ? { plan: run.plan, progress: planFile(run.dir, PLAN_FILES.progress) } : {}),
    ...(t.brief ? { brief: t.brief } : {}),
  })
}

/**
 * Sends `text` to a thread (stop if live, then `--bg --resume`, D-03): the work
 * behind Send and foreman_reply, a cycle's apply and a usage-limit retry. A resume that
 * does not take leaves the thread `stopped` in the registry (review C-12).
 */
async function sendToThread($: EngineInterface, t: ForemanThread, text: string, note: string): Promise<{ thread: ForemanThread } | { error: string }> {
  const { repo } = await roots($)
  const exe = claudeExe()
  const row = background.rowOf(t, await listRows($))
  const plan = background.sendPlan(row)
  if ('refuse' in plan) return { error: `Not sent: ${plan.refuse}.` }
  const sessionId = t.sessionId || row?.sessionId
  if (!sessionId) return { error: `Not sent: no session id known for ${t.id} yet; try again in a few seconds.` }
  const message = `${text}\n\n${await rebrief($, t)}`
  if (message.length > MESSAGE_MAX) return { error: `Not sent: the message is ${message.length} characters (at most ${MESSAGE_MAX}); put it in a file and send its path.` }
  const at = async () => new Date(await $.clock.now()).toISOString()
  if (plan.steps.includes('stop')) {
    const s = await $.process.run(background.stopArgv(exe, t.id), { timeoutMs: 30_000 })
    if (s.exitCode !== 0) return { error: `Not sent: claude stop ${t.id} failed: ${firstLine(s.stderr || s.stdout)}` }
  }
  const sentAt = await at()
  let failure: string | undefined
  try {
    const r = await $.process.run(background.resumeArgv(exe, sessionId, message), { cwd: t.cwd, timeoutMs: 60_000 })
    const resumed = r.exitCode === 0 ? background.parseLaunched(r.stdout) : undefined
    if (!resumed) failure = `claude --bg --resume failed (exit ${r.exitCode}):\n${firstLine(r.stderr || r.stdout)}`
    else if (resumed.isCopy || resumed.id !== t.id) failure = `the CLI started ${resumed.id} instead of resuming ${t.id}; ${t.id} is left stopped (claude rm ${resumed.id} removes the copy)`
  } catch (err) {
    failure = `claude --bg --resume did not run: ${errText(err)}`
  }
  if (failure) {
    const stopped: ForemanThread = { ...t, sessionId, state: 'stopped', waitingFor: 'a message failed to resume it', updatedAt: await at() }
    await putThreads($, repo, [stopped])
    await recordRun($, stopped, t.state, `resume failed (${note})`)
    return { error: `Not sent: ${failure}` }
  }
  const next: ForemanThread = { ...t, sessionId, state: 'working', sentAt, updatedAt: sentAt, owner: await $.session.id() }
  delete next.waitingFor
  delete next.noResult
  delete next.retryAt
  // a message from foreman runs it in the background again: no longer the person's to hold
  delete next.openedAt
  delete next.heldBy
  await putThreads($, repo, [next])
  await recordRun($, next, t.state, note)
  return { thread: next }
}

/**
 * Open (D-69, F0-4): puts the thread in the desktop app's sidebar, where the
 * person answers its dialog or its question. A live background process is
 * stopped first (the app does not adopt a session whose process lives); a turn
 * in progress is not cut. foreman keeps watching the same transcript, and a
 * Reply still reaches the thread by `--bg --resume`.
 */
async function openInApp($: EngineInterface, t: ForemanThread): Promise<string> {
  const { repo } = await roots($)
  const exe = claudeExe()
  const row = background.rowOf(t, await listRows($))
  const sessionId = t.sessionId || row?.sessionId || ''
  const plan = background.openPlan(row)
  if ('refuse' in plan) return `Not opened: ${plan.refuse}.`
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const cmd = background.openCommand(exe, sessionId, isWindows)
  if (!cmd) return `Not opened: no session id known for ${t.id} yet; try again in a few seconds.`
  // The mark goes in before the stop: a look in between would see a thread stopped mid-turn and resume it in the
  // background while the app opens the same session, two processes on one session (seen live, Phase 2: the app crashed).
  const at = new Date(await $.clock.now()).toISOString()
  const marked: ForemanThread = { ...t, sessionId, openedAt: at, updatedAt: at }
  await putThreads($, repo, [marked])
  const unmark = async (why: string) => {
    const back: ForemanThread = { ...marked, updatedAt: new Date(await $.clock.now()).toISOString() }
    delete back.openedAt
    await putThreads($, repo, [back])
    return `Not opened: ${why}`
  }
  if (plan.steps.includes('stop')) {
    const s = await $.process.run(background.stopArgv(exe, t.id), { timeoutMs: 30_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
    if (s.exitCode !== 0) return unmark(`claude stop ${t.id} failed: ${firstLine(s.stderr || s.stdout)}`)
  }
  if (cmd.wait) {
    const r = await $.process.run(cmd.argv, { timeoutMs: 30_000, ...(cmd.env ? { env: cmd.env } : {}) }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
    if (r.exitCode !== 0) return unmark(firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`)
  } else {
    // the app takes it from here; the child is not waited for, its end goes to the debug log
    void (async () => {
      const child = $.process.spawn({ argv: cmd.argv, ...(cmd.env ? { env: cmd.env } : {}) })
      for await (const piece of child) $.ui.log(`open ${t.id}: ${piece.text}`, { to: 'debug' })
    })().catch(err => $.ui.log(`open ${t.id}: ${errText(err)}`, { to: 'debug' }))
  }
  // its state is the watcher's to read from the app's row; only the mark is foreman's
  await recordRun($, marked, t.state, 'opened in the app')
  // a dialog's call was cut by the stop: tell the thread, in the app, to run it again (nobody has to type)
  if (t.state === 'blocked' && plan.steps.includes('stop')) void nudgeOpened($, marked).catch(err => $.ui.log(`could not nudge ${t.id}: ${errText(err)}`, { to: 'debug' }))
  spawnSync($, true)
  return `Opened ${t.name} in the app's sidebar (local_${sessionId}): answer it there. foreman keeps watching it, and a Reply from the pane still reaches it.`
}

/** Waits on the session's clock (a reload drops the wait with the module). */
function waitMs($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => { $.clock.after(ms, () => resolve()) })
}

/**
 * After Open cut a dialog's call: a message to the session in the app, through
 * the app's own session messaging (`ccd_session_mgmt.send_message`, which F0-3
 * saw delivered from the app with no classifier in the way), so the thread runs
 * the call again and the person only answers the dialog. Tried a few times while
 * the app takes the session in; if it never goes, the person is told to write in
 * the thread's chat.
 */
async function nudgeOpened($: EngineInterface, t: ForemanThread): Promise<void> {
  let why = 'no answer'
  for (const delay of OPEN_RESUME_DELAYS_MS) {
    await waitMs($, delay)
    try {
      const r = await $.mcp.call('ccd_session_mgmt', 'send_message', { session_id: appSessionId(t.sessionId), message: OPEN_RESUME_MESSAGE })
      const text = (r.content ?? []).map(c => ('text' in c && typeof c.text === 'string' ? c.text : '')).join(' ')
      if (!r.isError && /delivery: (delivered|queued)/.test(text)) {
        await recordRun($, t, t.state, 'told in the app to run its cut call again')
        return
      }
      why = text.slice(0, 160) || 'the app did not deliver it'
    } catch (err) {
      why = errText(err).slice(0, 160)
    }
  }
  const parsed = await loadProfile($, (await roots($)).work)
  await notice($, parsed, `${t.name} is open in the app and its last tool call was cut: write "go on" in its chat (foreman could not tell it: ${why})`, 'stop', t.runId)
}

/** Stops a thread for the person (Stop): foreman does not resume it on its own afterwards. */
async function holdThread($: EngineInterface, t: ForemanThread, note: string): Promise<string | undefined> {
  const { repo } = await roots($)
  const row = background.rowOf(t, await listRows($).catch(() => [] as ForemanAgentRow[]))
  if (row?.kind === 'background' && row.pid !== undefined) {
    const r = await $.process.run(background.stopArgv(claudeExe(), t.id), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return `claude stop ${t.id}: ${firstLine(r.stderr || r.stdout)}`
  }
  const next: ForemanThread = { ...t, state: 'stopped', heldBy: 'person', updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, repo, [next])
  await recordRun($, next, t.state, note)
  return undefined
}

/** `/foreman stop [plan]`: the plan named, or the active one, with its thread (a thread on its own stops with its plan, D-75). */
async function stopCommand($: EngineInterface, args: string): Promise<string> {
  const ref = parseArgs(args).positional[1]
  const { repo } = await roots($)
  const list = await putPlans($, repo, [])
  const run = ref ? list.find(p => isPlanActive(p) && (p.id === ref || normPath(p.plan) === normPath(ref))) : list.find(isPlanActive)
  if (run) return stopPlan($, run.id)
  return ref ? `No active plan "${ref}" here. A thread stops with its plan: /foreman stop <plan>.` : 'No active plan here.'
}

// ---------------------------------------------------------------- reviews (plan D2)

async function storedReviews($: EngineInterface, repo: string): Promise<ForemanReview[]> {
  const v = await $.store.get(reviewsKey(repo))
  return Array.isArray(v) ? (v as ForemanReview[]) : []
}

/** Pending < settled from the file < settled by the answer: a copy never gives way to a less settled one. */
const rank = (r: ForemanReview) => (!r.finishedAt ? 0 : r.settledBy === 'file' ? 1 : 2)

/** Replaces or adds reviews (by agentId) in the store and this session's copy; keeps the last 200. */
async function putReviews($: EngineInterface, repo: string, changed: readonly ForemanReview[]): Promise<ForemanReview[]> {
  const byId = new Map<string, ForemanReview>()
  for (const r of [...(await storedReviews($, repo)), ...(await read($, reviews)), ...changed]) {
    const cur = byId.get(r.agentId)
    if (!cur || rank(r) >= rank(cur)) byId.set(r.agentId, r)
  }
  const list = [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-200)
  if (changed.length) await $.store.set(reviewsKey(repo), list)
  await update($, reviews, () => list)
  return list
}

const REF_RE = /^(?!-)[A-Za-z0-9._/~^@-]{1,200}$/

/** The base a review diffs from when none is given: the remote's default branch, else HEAD~1. */
async function defaultBase($: EngineInterface, work: string): Promise<string | undefined> {
  for (const argv of [['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], ['git', 'rev-parse', '--verify', '--quiet', 'HEAD~1']]) {
    const r = await $.process.run(argv, { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
    const out = r?.stdout.trim()
    if (r && r.exitCode === 0 && out) return argv.includes('HEAD~1') ? 'HEAD~1' : out
  }
  return undefined
}

/** A part of the plan a run works on, read again from the file (its text and criteria may have been edited). */
async function planPartOf($: EngineInterface, work: string, plan: string | undefined, part: string): Promise<PlanPart | undefined> {
  if (!plan) return undefined
  const text = await $.fs.read(join(work, plan)).catch(() => undefined)
  return typeof text === 'string' ? parsePlan(text, plan).parts.find(p => p.id === part) : undefined
}

type ReviewOptions = { runId: string; part: string; base: string; plan?: string; model?: string; previous?: string; note?: string }

/** What a review that runs again after "could not run" is told first (D-124). */
const COULD_NOT_RUN_NOTE = 'Your last run of this review could not run its gates: its permissions refused the command lines it tried. Run each gate exactly as written, one command per call, nothing joined to it and nothing after it.'

/** The reviewers this module runs, by review id: a reload ends them (the module's children die with it), and settleLost settles what they left. */
const reviewingNow = new Set<string>()

/**
 * Starts a fresh reviewer on a run's part: the work behind /foreman review and
 * a cycle's review round. A `claude -p` process in the work tree (D-73):
 * `dontAsk`, read-only tools and the repo's gates in `--allowedTools`, the
 * brief on stdin, under a thread-mode name so its own load of foreman never
 * coordinates. It runs in the background of this module (runReviewer); foreman
 * writes its answer to the review file in the run's folder (D-70).
 */
async function spawnReview($: EngineInterface, o: ReviewOptions): Promise<{ review: ForemanReview; model: string; notes: string[] } | { error: string }> {
  const { runId, part, base, plan } = o
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const stored = await storedReviews($, repo)
  const pending = stored.find(r => !r.finishedAt && r.runId === runId && r.part === part)
  if (pending) return { error: `A review of ${runId} part ${part} is still running (r${pending.n}, ${pending.agentId}).` }
  const dir = await dirOfRun($, runId)
  if (!dir) return { error: 'No place for foreman\'s files: this folder is not in a git repository, and no home folder is known.' }
  const names = (await $.fs.list(dir).catch(() => [])).map(e => e.name)
  // a number is taken by a file, and by a record whose reviewer left none (it stays noResult under it)
  const recorded = stored.filter(r => r.runId === runId && r.part === part).map(r => r.n)
  const n = Math.max(nextNumber(names, part), ...recorded.map(x => x + 1))
  const file = planFile(dir, reviewFile(part, n))
  const notes: string[] = []
  const rc = roleAt(p, 'reviewer')
  const skills = checkSkills(rc.skills, await knownSkills($))
  if (skills.missing.length) notes.push(`skills not found in this session, left out of the brief: ${skills.missing.join(', ')}`)
  const template = (await readPrompt($, 'reviewer.md')) ?? '{{task}}'
  const pp = await planPartOf($, work, plan, part)
  const detected = await detectRepo($, work)
  const brief = composeBrief(template, [], p, 'reviewer', {
    task: '',
    part,
    base,
    reviewFile: file,
    progress: planFile(dir, PLAN_FILES.progress),
    skills: skills.kept,
    detectedGates: detected.gates,
    ...(plan ? { plan } : { plan: 'none: review the diff on its own' }),
    ...(pp ? { partTitle: pp.title, partText: pp.text, criteria: pp.criteria } : { partText: 'No plan part: judge the diff for defects.' }),
    ...(o.previous ? { previous: o.previous } : {}),
  }) + (o.note ? `\n${o.note}\n` : '')
  const model = o.model ?? rc.model
  const name = threadName(runId, 'reviewer', part)
  // in the plan's tree: its worktree sees the thread's commits, and the gates run there (D-73)
  const tree = (await read($, plans)).find(x => x.id === runId)?.tree ?? work
  const gates = gateCommands(p, detected.gates)
  const argv = processArgv({ exe: claudeExe(), role: 'reviewer', name, model, effort: rc.effort, maxTurns: MAX_TURNS.reviewer, gates })
  const startedAt = new Date(await $.clock.now()).toISOString()
  const owner = await $.session.id()
  const record: ForemanReview = { kind: 'review', runId, part, n, file, agentId: `process:${name}:r${n}`, owner, startedAt, verdict: 'none', findings: 0, base, model, ...(plan ? { plan } : {}) }
  await putReviews($, repo, [record])
  await recordReview($, record)
  reviewingNow.add(record.agentId)
  void runReviewer($, record, argv, brief, tree, gates).catch(err => $.ui.log(`the reviewer of ${runId} part ${part} failed: ${errText(err)}`, { to: 'debug' }))
  return { review: record, model, notes }
}

/** How each process foreman runs through spawnCut is cut, by key (a review's agentId, `supervisor:<cycle>`): a Stop ends them (review F-1). */
const cutters = new Map<string, () => void>()
/** The processes a Stop cut: what they answer after it is no verdict and no decision. */
const cutByStop = new Set<string>()

/** What a process run through spawnCut gave: `timedOut` at its time limit, `stopped` when a Stop cut it. */
type SpawnOut = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; stopped?: boolean }

/**
 * A command through `$.process.spawn` (no ten-minute cap), its output
 * gathered, cut at `timeoutMs` or when a Stop calls its cutter (`key`): at
 * the cut the stream is closed, which ends the child, and the answer says why.
 */
async function spawnCut($: EngineInterface, argv: readonly string[], cwd: string, input: string, timeoutMs: number, key?: string): Promise<SpawnOut> {
  const child = $.process.spawn({ argv, cwd, input })
  let stdout = ''
  let stderr = ''
  let cut: (by: 'time' | 'stop') => void = () => undefined
  const cutAt = new Promise<'time' | 'stop'>(resolve => { cut = by => resolve(by) })
  const timer = $.clock.after(timeoutMs, () => cut('time'))
  if (key) cutters.set(key, () => cut('stop'))
  try {
    for (;;) {
      const step = await Promise.race([child.next(), cutAt])
      if (step === 'time' || step === 'stop') {
        // not awaited: a child that writes nothing may answer the close only when it ends
        void child.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
        return { exitCode: -1, stdout, stderr, ...(step === 'time' ? { timedOut: true } : { stopped: true }) }
      }
      if (step.done) return { exitCode: step.value?.code ?? -1, stdout, stderr }
      if (step.value.stream === 'stderr') stderr += step.value.text
      else stdout += step.value.text
    }
  } finally {
    timer.cancel()
    if (key) cutters.delete(key)
  }
}

/** A Stop ends what runs for its plan: each part's reviewer and supervisor (review F-1). What they answer later is no verdict and no decision. */
async function cutPlanProcesses($: EngineInterface, runId: string): Promise<string[]> {
  const { repo } = await roots($)
  const keys = [
    ...(await storedReviews($, repo)).filter(r => r.runId === runId && !r.finishedAt).map(r => r.agentId),
    ...(await read($, cycles)).filter(c => c.runId === runId).map(c => `supervisor:${c.id}`),
  ]
  const cut: string[] = []
  for (const key of keys) {
    const stop = cutters.get(key)
    if (!stop) continue
    cutByStop.add(key)
    stop()
    cut.push(key)
  }
  return cut
}

/** What a process's JSON said of its run, for the record (D-77). */
function processNote(outcome: ProcessOutcome, exit: number, durationMs: number): ForemanProcessNote {
  return {
    exit,
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.ok && outcome.turns !== undefined ? { turns: outcome.turns } : {}),
    durationMs: outcome.ok && outcome.durationMs !== undefined ? outcome.durationMs : durationMs,
    ...(outcome.denials.length ? { denials: outcome.denials.slice(0, 20) } : {}),
  }
}

/**
 * The reviewer's run, in the background: its answer is written to the review
 * file and settles the verdict; no JSON, an error, a non-zero exit or the cut
 * is a review without a verdict that says why, never an OK.
 */
async function runReviewer($: EngineInterface, r: ForemanReview, argv: readonly string[], brief: string, work: string, gates: readonly string[]): Promise<void> {
  const started = await $.clock.now()
  let out: SpawnOut
  try {
    out = await spawnCut($, argv, work, brief, REVIEW_TIMEOUT_MS, r.agentId)
  } catch (err) {
    out = { exitCode: -1, stdout: '', stderr: errText(err) }
  } finally {
    reviewingNow.delete(r.agentId)
  }
  const outcome = readProcess(out)
  const run = processNote(outcome, out.exitCode, (await $.clock.now()) - started)
  // the plan was stopped while it ran: its answer, if any came, is not the part's (review F-1)
  if (cutByStop.delete(r.agentId) || out.stopped === true) {
    await settleFrom($, r, { by: 'answer', why: 'cut: the plan was stopped while the reviewer ran', run })
    return
  }
  if (outcome.ok) await $.fs.write(r.file, `${outcome.result.trim()}\n`)
  // a gate its permissions refused: the review could not run it, whatever its text says (Phase 3 criterion 7)
  const refused = gateDenials(outcome.denials, gates)
  const why = refused.length ? `could not run ${refused.map(g => `\`${g}\``).join(', ')}: the reviewer's permissions refused it`
    : outcome.ok ? undefined : `the reviewer could not finish: ${out.timedOut ? `cut after ${REVIEW_TIMEOUT_MS / 60_000} minutes` : outcome.why}`
  await settleFrom($, r, { by: 'answer', ...(outcome.ok ? { answer: outcome.result } : {}), ...(why ? { why } : {}), ...(refused.length ? { couldNotRun: refused } : {}), run })
  // a cycle waiting on this review moves now, not at the next tick
  spawnSync($, true)
}

async function startReview($: EngineInterface, args: string): Promise<string> {
  const { flags } = parseArgs(args, ['deep'])
  if (flags.deep === true) return '--deep is gone in 0.2: /foreman review starts one fresh reviewer.'
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const { work, repo } = await roots($)
  await pullThreads($, repo)
  const active = (await putPlans($, repo, [])).find(isPlanActive)
  const runId = str('run') ?? active?.id ?? ADHOC
  const run = (await read($, plans)).find(p => p.id === runId)
  const part = str('part') ?? run?.parts[run.current]?.id ?? 'A'
  if (!isSafeId(runId)) return '--run takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  if (!isSafeId(part)) return '--part takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const cycle = (await read($, cycles)).find(c => c.id === partCycleId(runId, part))
  const base = str('base') ?? cycle?.base ?? (await defaultBase($, work))
  if (base === undefined) return 'No base to diff from: pass --base <ref> (the branch or commit the work started from).'
  if (!REF_RE.test(base)) return `--base ${base} is not a git ref foreman passes on`
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const plan = run?.plan
  const out = await spawnReview($, { runId, part, base, ...(plan ? { plan } : {}), ...(model ? { model } : {}) })
  if ('error' in out) return out.error
  return `Started foreman's reviewer (${out.model}, a read-only process) on ${runId} part ${part}, diff ${base}..HEAD. foreman writes its answer to ${out.review.file}; its verdict lands here when it ends.${out.notes.length ? `\nNote: ${out.notes.join('; ')}.` : ''}`
}

/**
 * A review is settled from what it left: its file decides (foreman wrote the
 * reviewer's answer there), and a first line without a verdict is no result,
 * never an OK. `why` says why there is no answer (the process could not
 * finish, or was lost). `by: 'file'` marks a settlement made after the
 * reviewer was gone, which its own end may still replace.
 */
async function settleFrom($: EngineInterface, r: ForemanReview, o: { by: 'answer' | 'file'; answer?: string; why?: string; run?: ForemanProcessNote; couldNotRun?: string[]; lost?: boolean }): Promise<ForemanReview> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const text = (await $.fs.exists(r.file)) ? await $.fs.read(r.file).catch(() => undefined) : undefined
  const settled = settle(text, o.answer ?? '')
  const done: ForemanReview = {
    ...r,
    verdict: settled.verdict,
    findings: settled.findings,
    settledBy: o.by,
    finishedAt: new Date(await $.clock.now()).toISOString(),
    ...(o.run ? { run: o.run } : {}),
  }
  // what an earlier settlement said gives way to this one
  delete done.noResult
  delete done.reason
  delete done.couldNotRun
  delete done.lost
  if (o.couldNotRun?.length) {
    // its gates did not run: no verdict, whatever its text says
    Object.assign(done, { verdict: 'none', findings: 0, noResult: true, couldNotRun: o.couldNotRun, reason: o.why ?? 'could not run its gates' })
  } else {
    if (settled.noResult) done.noResult = true
    if (settled.noResult && o.lost) done.lost = true
    const reason = settled.noResult ? (o.why ?? (o.answer === undefined ? `the reviewer ended before it answered; ${settled.reason ?? 'no verdict'}` : settled.reason)) : settled.reason
    if (reason) done.reason = reason
  }
  await putReviews($, repo, [done])
  await recordReview($, done)
  const line = reviewSummary(done)
  // the pane shows every review; the chat hears of a part when it is ready or stops (round 2: ~20 lines a plan)
  $.ui.log(`${line}`, { to: 'debug' })
  if (parsed.profile.notify.toast && r.owner === (await $.session.id())) $.ui.toast(line)
  return done
}

/**
 * Reviews still waiting whose reviewer is gone: this session's that this
 * module does not run (a reload ended them), and orphans (no owner, or an
 * owner session that is no longer alive). Another live session's reviews are
 * its own (review C3-03). Each is settled from its file: a verdict there stands.
 */
async function settleLost($: EngineInterface, repo: string): Promise<void> {
  const open = (await storedReviews($, repo)).filter(r => !r.finishedAt)
  if (open.length === 0) return
  const me = await $.session.id()
  const rows = await listRows($).catch(() => undefined)
  if (rows === undefined) return // nobody can tell who is alive: leave them be
  for (const r of open) {
    const s = standing(r.owner, me, rows)
    if (s === 'other') continue
    if (s === 'mine' && reviewingNow.has(r.agentId)) continue
    const lost = r.agentId.startsWith('process:')
    const why = lost ? 'the reviewer\'s process ended before it answered (foreman was reloaded, or its chat closed)' : undefined
    await settleFrom($, r, { by: 'file', ...(why ? { why } : {}), ...(lost ? { lost } : {}) })
  }
}

// ---------------------------------------------------------------- cycles (plan §5)

async function storedCycles($: EngineInterface, repo: string): Promise<ForemanCycle[]> {
  const v = await $.store.get(cyclesKey(repo))
  return Array.isArray(v) ? (v as ForemanCycle[]) : []
}

/** Merges cycles by id into the store and this session's copy: the later `updatedAt` wins (as threads, D-25). */
async function putCycles($: EngineInterface, repo: string, changed: readonly ForemanCycle[]): Promise<ForemanCycle[]> {
  const byId = new Map<string, ForemanCycle>()
  for (const c of [...(await read($, cycles)), ...(await storedCycles($, repo)), ...changed]) {
    const cur = byId.get(c.id)
    if (!cur || Date.parse(c.updatedAt) >= Date.parse(cur.updatedAt)) byId.set(c.id, c)
  }
  const list = [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-100)
  if (changed.length) await $.store.set(cyclesKey(repo), list)
  await update($, cycles, () => list)
  return list
}

/** A notice the chat shows: a stop, the plan's end, a part that is ready, what the supervisor did on the person's behalf. */
function chatWorthy(text: string, level: NoticeLevel): boolean {
  // a part ready, and what the supervisor did on the person's behalf (an answer, a replan: D-68 says the person sees it)
  return level !== 'info' || /: ready, review r\d+ OK|: the supervisor (answered|replanned)|: delivered, /.test(text)
}

/** What PushNotification answered, in a few words for the record (D-86: it sends only with push on in /config). */
function pushSummary(out: unknown): string {
  const o = out as { deny?: string; result?: { pushSent?: boolean; localSent?: boolean; disabledReason?: string } } | undefined
  if (o?.deny !== undefined) return `refused: ${o.deny.slice(0, 120)}`
  const r = o?.result
  if (!r || typeof r !== 'object') return 'no answer'
  return r.pushSent || r.localSent ? `sent${r.pushSent ? ' (push)' : ''}${r.localSent ? ' (local)' : ''}` : `not sent${r.disabledReason ? ` (${r.disabledReason})` : ''}`
}

/**
 * A notice to the person (M1, D-86): always in the pane's notices and the log;
 * a toast unless `notify.quiet` holds back the `info` ones; and, for a stop that
 * waits for them and a plan that ends, PushNotification (the engine sends it
 * only when push is on in /config) and `$.ui.notify` (a terminal's own notice;
 * the desktop has none). What PushNotification answered is kept with the notice
 * and in the run's foreman.json.
 */
async function notice($: EngineInterface, parsed: ParsedProfile, text: string, level: NoticeLevel, runId?: string): Promise<void> {
  const at = new Date(await $.clock.now()).toISOString()
  // in the chat: what the person must act on, a part that is ready, the plan's end; the rest (a part started, a thread open
  // in the app) is the pane's and the debug log's (the reviewer's note on round 2: about 20 lines of foreman a plan)
  $.ui.log(`${text}`, chatWorthy(text, level) ? {} : { to: 'debug' })
  const { toast, quiet } = parsed.profile.notify
  if (toast && !(quiet && level === 'info')) $.ui.toast(text)
  let push: string | undefined
  if (level !== 'info') {
    try {
      push = pushSummary(await $.tool.call({ tool: 'PushNotification', message: `foreman: ${text}`.slice(0, 500), status: 'proactive' } as never))
    } catch (err) {
      push = `failed: ${errText(err).slice(0, 120)}`
    }
    $.ui.log(`PushNotification: ${push}`, { to: 'debug' })
    await $.ui.notify(text, { title: 'foreman' }).catch(() => undefined)
  }
  const n: ForemanNotice = { at, text, level, ...(push ? { push } : {}) }
  await update($, notices, list => [...list, n].slice(-20))
  if (runId) await editRunDoc($, runId, at, doc => { doc.notices = [...(doc.notices ?? []), n].slice(-200) })
}

/** The commit the work starts from. */
async function headSha($: EngineInterface, work: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
  const sha = r?.stdout.trim()
  return r && r.exitCode === 0 && sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined
}

/**
 * Starts a plan's part: its implementer thread on a brief made of the part's
 * own text and criteria, and the cycle every chat of the repo sees. The run
 * moves to that part once the cycle exists.
 */
async function beginPart($: EngineInterface, run: ForemanPlanRun, index: number, model?: string, lockHeld = false): Promise<{ cycle: ForemanCycle; thread: ForemanThread; run: ForemanPlanRun; missing: string[] } | { error: string }> {
  const part = run.parts[index]
  if (!part) return { error: `${run.id} has no part ${index + 1}` }
  const id = partCycleId(run.id, part.id)
  if (!lockHeld && partStarting.has(id)) return { error: `part ${part.id} of ${run.id} is starting already` }
  partStarting.add(id)
  try {
    return await startPart($, run, index, part, id, model)
  } finally {
    partStarting.delete(id)
  }
}

async function startPart($: EngineInterface, run: ForemanPlanRun, index: number, part: ForemanPlanRun['parts'][number], id: string, model?: string): Promise<{ cycle: ForemanCycle; thread: ForemanThread; run: ForemanPlanRun; missing: string[] } | { error: string }> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const existing = (await putCycles($, repo, [])).find(c => c.id === id)
  if (existing) return { error: `part ${part.id} of ${run.id} has a cycle already (${existing.phase})` }
  // each part starts from the commit the plan is at, in its own tree (D-71)
  const tree = run.tree ?? work
  const base = await headSha($, tree)
  if (!base) return { error: `Cannot read HEAD in ${tree}: a plan needs a git repository with a commit to review from.` }
  const pp = await planPartOf($, work, run.plan, part.id)
  const launched = await launchThread($, {
    role: 'implementer',
    task: `Implement part ${part.id} (${part.title}) of the plan \`${run.plan}\`.`,
    runId: run.id,
    part: part.id,
    plan: run.plan,
    ...(pp ? { planPart: pp } : {}),
    ...(model ? { model } : {}),
    cwd: tree,
    ...(run.branch ? { branch: run.branch } : {}),
  })
  if ('error' in launched) return launched
  const at = launched.thread.sentAt ?? launched.thread.startedAt
  const cycle: ForemanCycle = {
    id,
    runId: run.id,
    part: part.id,
    plan: run.plan,
    base,
    implThread: launched.thread.id,
    maxCycles: parsed.profile.limits.reviewRounds,
    rounds: [],
    phase: 'implementing',
    phaseAt: at,
    owner: await $.session.id(),
    startedAt: at,
    updatedAt: at,
  }
  await putCycles($, repo, [cycle])
  await recordCycle($, cycle, 'none', `part ${part.id} started from ${base.slice(0, 12)}`)
  const from = `${run.status}@${run.parts[run.current]?.id ?? '-'}`
  const moved = atPart(run, index, at)
  await putPlans($, repo, [moved])
  if (moved !== run) await recordPlan($, moved, from)
  await writeProgress($, run.id)
  return { cycle, thread: launched.thread, run: moved, missing: launched.missing }
}

/** Claude Code's global config, where its folder trust lives; undefined when it cannot be read. */
async function readClaudeConfig($: EngineInterface): Promise<string | undefined> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await homeDir($))
  if (!dir) return undefined
  const text = await $.fs.read(`${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}.claude.json`).catch(() => undefined)
  return typeof text === 'string' ? text : undefined
}

/**
 * The checks before a plan starts (M3): git and a first commit (each part is
 * reviewed from one), Claude Code's trust in the folder (a background thread
 * cannot show the prompt), a `claude` that runs; and, without stopping, a
 * checkout with uncommitted changes and a usage window past 90%.
 */
async function preflight($: EngineInterface, work: string, isolation: Isolation = 'none'): Promise<Preflight> {
  const problems: string[] = []
  const notes: string[] = []
  const git = await gitCommonDir($, work)
  if (!git) problems.push('a git repository: this folder is not in one (each part is reviewed from a commit; `git init` and commit once)')
  else if (!(await headSha($, work))) problems.push('a first commit: the repository has none yet, and each part is reviewed from one')
  if (trustOf(await readClaudeConfig($), work) === 'untrusted') {
    problems.push('Claude Code to trust this folder: open it once in the app (or run `claude` in it) and accept the trust prompt; a background thread cannot ask')
  }
  try {
    await listRows($)
  } catch (err) {
    problems.push(`a \`claude\` command that runs here (${errText(err).slice(0, 160)}): set "Claude Code executable" in foreman's plugin settings`)
  }
  if (git) {
    const st = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
    const dirty = st && st.exitCode === 0 && st.stdout.trim() !== ''
    // D-71: a worktree starts from the last commit; a branch in the checkout needs it clean; the checkout itself takes them as they are
    if (dirty && isolation === 'worktree') notes.push('this checkout has changes not committed: they stay here, and the plan\'s worktree starts from the last commit')
    if (dirty && isolation === 'branch') problems.push('this checkout has changes not committed, and the plan would switch its branch: commit or stash them first')
    if (dirty && isolation === 'none') notes.push('this checkout has changes not committed, and the thread works in it: it may commit them with its part')
  }
  try {
    const high = (await $.session.usage()).rateLimits.filter(l => l.percentUsed >= 90)
    if (high.length) notes.push(`usage: ${high.map(l => `${l.kind} at ${l.percentUsed}%${l.resetsAt ? `, resets ${l.resetsAt}` : ''}`).join('; ')}`)
  } catch {
    // no usage figures here (an API key, an old build): nothing to say
  }
  return { problems, notes }
}

/**
 * `/foreman go` and the `foreman_go` tool. From the command, `--parts` or
 * `--yes` skip the question and a session with no dialog starts as asked
 * (D-93, a `-p` run). From the tool (the chat's model asked), the person is
 * always asked, and with no dialog nothing starts: the answer lists the parts
 * and says how the person confirms it themselves.
 */
async function goCommand($: EngineInterface, args: string, from: 'command' | 'tool' = 'command'): Promise<string> {
  const { positional, flags } = parseArgs(args, ['yes'])
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const plan = positional[1]
  if (!plan) return 'Usage: /foreman go <plan.md> [--parts A,B] [--model m] [--yes]'
  if (flags.level !== undefined) return '--level is gone in 0.2: pass --model (opus, sonnet, haiku, fable).'
  // one mode (D-111): a --mode other than auto is said and ignored
  const modeNote = flags.mode !== undefined && flags.mode !== 'auto' ? `--mode: ${ONE_MODE}` : undefined
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const text = await $.fs.read(join(work, plan)).catch(() => undefined)
  if (typeof text !== 'string') return `${plan}: no such file under ${work}`
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const parsedPlan: ParsedPlan = parsePlan(text, plan.split(/[\\/]/).pop() ?? plan)
  const picked = str('parts') ? pickParts(parsedPlan, str('parts') as string) : { parts: parsedPlan.parts }
  if ('error' in picked) return picked.error
  if (picked.parts.length === 0) return `${plan}: no parts to run.`
  // one active plan per repo (D-71): the same plan answers with its state, another is refused
  await pullThreads($, repo)
  await putCycles($, repo, [])
  const active = (await putPlans($, repo, [])).find(isPlanActive)
  if (active) {
    const line = runLine(active, await read($, cycles))
    return normPath(active.plan) === normPath(plan)
      ? `${plan} is already running here: ${line}.`
      : `Plan ${active.id} (${active.plan}) is active in this repo, and foreman runs one plan at a time: ${line}. Let it finish, or stop it (the pane's Stop, or /foreman stop).`
  }
  const detected = await detectRepo($, work)
  const iso = isolationFor(parsed.profile.isolation, detected)
  const checks = await preflight($, work, iso.isolation)
  if (gateCommands(parsed.profile, detected.gates).length === 0) checks.notes.push('no gates declared or found: each review judges the diff and the plan\'s criteria alone')
  const missing = preflightMessage(checks, plan)
  if (missing) return missing
  if (modeNote) checks.notes.push(modeNote)
  const storage = await storageFor($, work, parsed)
  if (!storage) return 'No place for foreman\'s files: this folder is not in a git repository, and no home folder is known.'
  const taken = new Set([...(await $.fs.list(storage.base).catch(() => [])).map(e => e.name), ...(await read($, plans)).map(p => p.id)])
  const slug = freeSlug(planSlug(plan), taken)
  const tree = await planTree($, work, repo, slug, parsedPlan.title, iso.isolation, detected.prefixes)
  const facts = await deliveryFacts($, parsed.profile.delivery.mode, iso.isolation, tree, detected.humanGate)
  const install = iso.isolation === 'worktree' ? detected.install : undefined
  const preview = planPreview({ ...parsedPlan, parts: picked.parts })
  const where = [
    iso.isolation === 'worktree' ? `In its own worktree, \`${relTo(repo, tree.path)}\`, on the new branch \`${tree.branch}\` from \`${tree.base ?? 'HEAD'}\`${install ? `; first \`${install}\` runs there (up to 10 minutes)` : ''}.`
      : iso.isolation === 'branch' ? `On the new branch \`${tree.branch}\` in this checkout${iso.why ? ` (${iso.why})` : ''}.`
      : 'In this checkout, on its current branch.',
    `When it is done: ${deliveryLine(facts.mode, tree.branch, tree.base)}${facts.note ? ` (${facts.note})` : ''}.`,
  ]
  const notes = checks.notes.length ? `\n${checks.notes.map(n => `Note: ${n}.`).join('\n')}` : ''
  let note = ''
  if (from === 'tool' || (!str('parts') && flags.yes !== true)) {
    const question = `Run ${picked.parts.length} part(s) of ${plan} in order?\n${preview.map(l => `• ${l}`).join('\n')}\n${where.join('\n')}${notes}`
    try {
      const answer = await $.ui.ask(question, ['Run them', 'Cancel'])
      if (answer !== 'Run them') return `Not started (${answer || 'cancelled'}). /foreman go ${plan} --parts <ids> runs the parts you name.`
    } catch {
      if (from === 'tool') {
        return [`Not started: there is no dialog here to confirm it with the person. ${plan} has ${picked.parts.length} part(s):`, ...preview.map(l => `  ${l}`), ...where.map(l => `  ${l}`), `To start it, the person types: /foreman go ${plan} --yes`].join('\n')
      }
      note = ' (Nobody to confirm with in this session: started as asked.)'
    }
  }
  // the tree now: a worktree (and the person's exclude), a branch in the checkout, or the checkout as it is
  const made = await makeTree($, work, repo, iso.isolation, tree)
  if (typeof made === 'string') return `Plan ${slug} not started: ${made}`
  const at = new Date(await $.clock.now()).toISOString()
  const run: ForemanPlanRun = {
    id: slug,
    plan,
    title: parsedPlan.title,
    dir: planDir(storage, slug),
    parts: picked.parts.map((p, i) => ({ id: p.id, title: p.title, ...(i > 0 && p.pauseBefore ? { pauseBefore: true } : {}) })),
    current: 0,
    status: 'running',
    owner: await $.session.id(),
    startedAt: at,
    updatedAt: at,
    isolation: iso.isolation,
    tree: tree.path,
    checkout: work,
    ...(tree.branch ? { branch: tree.branch } : {}),
    ...(tree.base ? { base: tree.base } : {}),
    delivery: { mode: facts.mode, ...(facts.note ? { note: facts.note } : {}) },
    ...(install ? { prepare: { cmd: install, state: 'running' as const, at } } : {}),
  }
  const files = `Files: ${run.dir} (brief, progress.md, reviews, foreman.json; report.md at the end). foreman reviews and applies, and goes on to the next part by itself; its supervisor answers what the plan answers, and what it cannot waits for you in the pane. /foreman opens the pane.${notes}`
  if (install) {
    // the install command first, in the background; the watcher starts part 1 once it is done (D-71)
    await putPlans($, repo, [run])
    await recordPlan($, run, 'none', `${picked.parts.length} part(s): ${picked.parts.map(p => p.id).join(', ')}; ${run.branch ?? 'no branch'} in ${run.tree}; ${install} first`)
    void prepareTree($, run.id).catch(err => $.ui.log(`the worktree's ${install} failed: ${errText(err)}`, { to: 'debug' }))
    await openPaneForPlan($)
    return [`Plan ${slug} started${note}: ${picked.parts.length} part(s), in order:`, ...preview.map(l => `  ${l}`), ...where.map(l => `  ${l}`), `Part ${picked.parts[0]?.id} starts once \`${install}\` is done in the worktree.`, files].join('\n')
  }
  // the first part is "starting" before the run is visible to the watcher, so its look never starts it a second time
  const first = partCycleId(run.id, run.parts[0]?.id ?? '')
  partStarting.add(first)
  let started: Awaited<ReturnType<typeof beginPart>>
  try {
    await putPlans($, repo, [run])
    await recordPlan($, run, 'none', `${picked.parts.length} part(s): ${picked.parts.map(p => p.id).join(', ')}${run.branch ? `; ${run.branch} in ${run.tree}` : ''}`)
    started = await beginPart($, run, 0, model, true)
  } finally {
    partStarting.delete(first)
  }
  if ('error' in started) {
    const stopped = stopRun(run, new Date(await $.clock.now()).toISOString(), `the first part did not start: ${started.error}`)
    await putPlans($, repo, [stopped])
    await recordPlan($, stopped, 'running@' + (run.parts[0]?.id ?? '-'))
    await writeProgress($, run.id)
    return `Plan ${slug} not started: ${started.error}`
  }
  await openPaneForPlan($)
  return [
    `Plan ${slug} started${note}: ${picked.parts.length} part(s), in order:`,
    ...preview.map(l => `  ${l}`),
    ...where.map(l => `  ${l}`),
    `Part ${picked.parts[0]?.id}: ${started.thread.name} (${started.thread.id}, ${started.thread.model}) from ${started.cycle.base.slice(0, 12)}; up to ${started.cycle.maxCycles} review round(s) per part.`,
    // the profile's skills the session does not list are left out of the brief, and said (D8, C-11)
    ...(started.missing.length ? [`Note: skills not found in this session, left out of the brief: ${started.missing.join(', ')}.`] : []),
    files,
  ].join('\n')
}

/** The plan's own view: the pane opens where a surface shows it (in the acceptance the person had to type /foreman). */
async function openPaneForPlan($: EngineInterface): Promise<void> {
  try {
    if ((await $.session.surfaces()).some(s => s !== 'mobile') && !(await $.ui.panes()).some(p => p.id === PANE_ID)) await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  } catch {
    // no surface to draw on (a -p run): the answer says /foreman opens it
  }
}

/** A path relative to the repo, with forward slashes, for the person's eyes. */
const relTo = (repo: string, path: string) => {
  const r = normPath(repo)
  const p = path.replace(/\\/g, '/')
  return normPath(path).startsWith(`${r}/`) ? p.slice(r.length + 1) : p
}

type PlanTree = { path: string; branch?: string; base?: string }

/**
 * Where the plan will work (D-71), before anything is made: the worktree's
 * path, the branch the repo's rules ask for (not taken yet), and the branch
 * the checkout is on (a pull request's base, a merge's target).
 */
async function planTree($: EngineInterface, work: string, repo: string, slug: string, title: string, isolation: Isolation, prefixes: readonly string[]): Promise<PlanTree> {
  const run = async (argv: readonly string[]) => $.process.run(argv, { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
  const head = (await run(gitArgv.currentBranch))?.stdout.trim()
  const base = head && head !== 'HEAD' ? head : undefined
  if (isolation === 'none') return { path: work, ...(base ? { base } : {}) }
  const exists = new Set<string>()
  for (const candidate of [branchFor(prefixes, title, slug), ...Array.from({ length: 4 }, (_, i) => `${branchFor(prefixes, title, slug)}-${i + 2}`)]) {
    if ((await run(gitArgv.branchExists(candidate)))?.exitCode === 0) exists.add(candidate)
  }
  const branch = freeBranch(branchFor(prefixes, title, slug), b => exists.has(b))
  return { path: isolation === 'worktree' ? worktreePath(repo, slug) : work, branch, ...(base ? { base } : {}) }
}

/** Makes the plan's tree: the person's exclude line and the worktree, or the branch in the checkout. A string says why it could not. */
async function makeTree($: EngineInterface, work: string, repo: string, isolation: Isolation, tree: PlanTree): Promise<true | string> {
  if (isolation === 'none' || !tree.branch) return true
  if (isolation === 'branch') {
    const r = await $.process.run(gitArgv.switchCreate(tree.branch), { cwd: work, timeoutMs: 30_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
    return r.exitCode === 0 ? true : `\`git switch -c ${tree.branch}\` failed (exit ${r.exitCode}): ${firstLine(r.stderr || r.stdout)}`
  }
  // the person's `git status` never lists foreman's worktrees: one line in .git/info/exclude (D-71)
  const common = await gitCommonDir($, work)
  if (common) {
    const path = join(common, 'info/exclude')
    const text = await $.fs.read(path).catch(() => undefined)
    const next = withExclude(typeof text === 'string' ? text : undefined)
    if (next !== undefined) await $.fs.write(path, next).catch(() => undefined)
  }
  // from the coordinator's own checkout (an app worktree included): its HEAD is the plan's base (O-1 of the Phase 4 review)
  const r = await $.process.run(gitArgv.worktreeAdd(tree.path, tree.branch, 'HEAD'), { cwd: work, timeoutMs: 60_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
  return r.exitCode === 0 ? true : `\`git worktree add\` failed (exit ${r.exitCode}): ${firstLine(r.stderr || r.stdout)}`
}

/** The delivery the plan gets (D-72): the profile's mode, lowered when the repo, `gh` or the isolation cannot carry it. */
async function deliveryFacts($: EngineInterface, mode: 'pr' | 'merge' | 'branch' | 'none', isolation: Isolation, tree: PlanTree, humanGate: string | undefined) {
  const remote = (await $.session.repo().catch(() => null))?.remote != null
  let gh: boolean | undefined
  if (mode === 'pr' && remote) {
    const r = await $.process.run(GH_PREFLIGHT, { timeoutMs: 20_000 }).catch(() => undefined)
    gh = r?.exitCode === 0
  }
  return deliveryMode({ mode, isolation, ...(tree.branch ? { branch: tree.branch } : {}), ...(tree.base ? { base: tree.base } : {}), remote, ...(gh !== undefined ? { gh } : {}), ...(humanGate ? { humanGate } : {}) })
}

/** What the delivery will do, in words, for `go`'s dialog. */
function deliveryLine(mode: 'pr' | 'merge' | 'branch' | 'none', branch: string | undefined, base: string | undefined): string {
  switch (mode) {
    case 'pr': return `foreman pushes \`${branch}\` and opens a pull request into \`${base}\` with the plan's report; nobody merges it but a person`
    case 'merge': return `foreman merges \`${branch}\` into \`${base}\` here, with no push`
    case 'branch': return `the branch \`${branch}\` stays as it is, with the report; nothing is published`
    default: return 'the commits stay where they are; nothing is published'
  }
}

// ---------------------------------------------------------------- the worktree's install command, and the delivery (D-71, D-72)

/** The runs whose install command this module runs, and those it is delivering. */
const preparingNow = new Set<string>()
const deliveringNow = new Set<string>()
/** The plans whose worktree's left folder is being removed now (H-4). */
const removingFolder = new Set<string>()

/** A command line from detect.ts or a profile, run through the platform's shell (`npm` is a .cmd on Windows). */
async function shellArgv($: EngineInterface, line: string): Promise<string[]> {
  return (await $.env.get('OS')) === 'Windows_NT' ? ['cmd.exe', '/d', '/s', '/c', line] : ['sh', '-c', line]
}

/**
 * Runs the worktree's install command before the first part (D-71), in the
 * background, cut at ten minutes. Done, the watcher starts part 1; failed,
 * the plan stops with the command's last lines, and nothing was launched.
 */
async function prepareTree($: EngineInterface, runId: string): Promise<void> {
  if (preparingNow.has(runId)) return
  preparingNow.add(runId)
  try {
    const { repo } = await roots($)
    const parsed = await loadProfile($, (await roots($)).work)
    const run = (await putPlans($, repo, [])).find(p => p.id === runId)
    if (!run?.prepare || run.prepare.state !== 'running' || !run.tree || run.status !== 'running') return
    const started = await $.clock.now()
    const r = await $.process.run(await shellArgv($, run.prepare.cmd), { cwd: run.tree, timeoutMs: PREPARE_TIMEOUT_MS }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
    const output = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-15).join('\n')
    const nowIso = new Date(await $.clock.now()).toISOString()
    const prepare = { ...run.prepare, state: r.exitCode === 0 ? 'done' as const : 'failed' as const, exit: r.exitCode, durationMs: (await $.clock.now()) - started, output }
    const latest = (await putPlans($, repo, [])).find(p => p.id === runId) ?? run
    await editRunDoc($, runId, nowIso, doc => { doc.prepare = prepare })
    if (r.exitCode === 0) {
      const next: ForemanPlanRun = { ...latest, prepare, updatedAt: nowIso }
      await putPlans($, repo, [next])
      await recordPlan($, next, `${latest.status}@-`, `${prepare.cmd} done in the worktree`)
      spawnSync($, true)
      return
    }
    const stopped = stopRun({ ...latest, prepare }, nowIso, `the worktree's \`${prepare.cmd}\` failed (exit ${r.exitCode}): ${output.split('\n').at(-1) ?? ''}`.slice(0, 400))
    await putPlans($, repo, [stopped])
    await recordPlan($, stopped, `${latest.status}@-`)
    await writeProgress($, runId)
    await notice($, parsed, `${runId}: not started, ${stopped.reason}`, 'stop', runId)
  } finally {
    preparingNow.delete(runId)
  }
}

/** The lines of a run's decisions.jsonl, for its report. */
async function readDecisions($: EngineInterface, run: ForemanPlanRun): Promise<ReportDecision[]> {
  const text = await $.fs.read(planFile(run.dir, PLAN_FILES.decisions)).catch(() => undefined)
  if (typeof text !== 'string') return []
  return text.split(/\r?\n/).filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as ReportDecision] } catch { return [] } })
}

/** report.md (M4): written from foreman's records when the plan is done, and again once delivered. */
async function writeReport($: EngineInterface, run: ForemanPlanRun): Promise<string> {
  const { repo, work } = await roots($)
  const path = planFile(run.dir, PLAN_FILES.report)
  const runCycles = (await putCycles($, repo, [])).filter(c => c.runId === run.id)
  // each part's commits from git (V-12), from the main tree, where the plan's branch is; without a branch, the checkout's HEAD
  const commits: Record<string, string[]> = {}
  for (const { part, range } of partRanges(run, runCycles)) {
    if (!REF_RE.test(range.replace('..', '-'))) continue
    const r = await $.process.run(['git', 'log', '--reverse', '--format=%h %s', range], { cwd: run.branch ? repo : run.checkout ?? work, timeoutMs: 15_000 }).catch(() => undefined)
    if (r && r.exitCode === 0) commits[part] = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  }
  const text = reportMarkdown({
    run,
    commits,
    cycles: runCycles,
    threads: await pullThreads($, repo),
    reviews: (await storedReviews($, repo)).filter(r => r.runId === run.id),
    decisions: await readDecisions($, run),
  })
  await $.fs.write(path, text)
  return path
}

/**
 * Delivers a finished plan by code (D-72): its report, then the steps of its
 * mode, each argv exact; then the worktree goes and the branch stays. A step
 * that fails leaves the plan "Done, not delivered", with Retry delivery.
 */
async function deliverPlan($: EngineInterface, runId: string): Promise<string> {
  if (deliveringNow.has(runId)) return `${runId} is being delivered already.`
  deliveringNow.add(runId)
  try {
    const { work, repo } = await roots($)
    const parsed = await loadProfile($, work)
    const run0 = (await putPlans($, repo, [])).find(p => p.id === runId)
    if (!run0 || run0.status !== 'done' || !run0.delivery) return `${runId} has nothing to deliver.`
    if (run0.delivery.state === 'delivered') return `${runId} was delivered already.`
    const at = new Date(await $.clock.now()).toISOString()
    let run: ForemanPlanRun = { ...run0, delivery: { ...run0.delivery, state: 'pending', at }, updatedAt: at }
    await putPlans($, repo, [run])
    const d = run.delivery as NonNullable<ForemanPlanRun['delivery']>
    const report = await writeReport($, run)
    const steps: { argv: string[]; exit: number; out?: string }[] = []
    const fail = async (reason: string): Promise<string> => {
      const nowIso = new Date(await $.clock.now()).toISOString()
      run = { ...run, delivery: { ...d, state: 'failed', at: nowIso, reason, steps }, updatedAt: nowIso }
      await putPlans($, repo, [run])
      await recordPlan($, run, 'done@-', `not delivered: ${reason}`)
      await editRunDoc($, runId, nowIso, doc => { doc.delivery = run.delivery })
      await writeReport($, run)
      await notice($, parsed, `${runId}: done, not delivered: ${reason}. Retry delivery is in the pane.`, 'stop', runId)
      return `Not delivered: ${reason}`
    }
    // the person's checkout (where the plan started: a branch isolation's switch and a merge happen there, O-1); the main tree for the rest
    const checkout = run.checkout ?? work
    const step = async (argv: readonly string[], cwd = repo) => {
      const r = await $.process.run(argv, { cwd, timeoutMs: DELIVERY_STEP_MS }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
      steps.push({ argv: [...argv], exit: r.exitCode, out: `${r.stdout}\n${r.stderr}`.trim().slice(-400) })
      return r
    }
    // a branch in the person's checkout goes back to where the plan started, first
    if (run.isolation === 'branch' && run.base && (d.mode === 'merge' || d.mode === 'pr' || d.mode === 'branch')) {
      const dirty = await step(gitArgv.dirty, checkout)
      if (dirty.exitCode === 0 && dirty.stdout.trim() !== '') return fail('your checkout has changes not committed, and the plan\'s branch is checked out there: commit or stash them, then Retry delivery')
      const back = await step(gitArgv.switchTo(run.base), checkout)
      if (back.exitCode !== 0) return fail(`\`git switch ${run.base}\` failed (exit ${back.exitCode})`)
    }
    if (d.mode === 'merge') {
      // the merge happens in the person's checkout: it must be clean and on the plan's base branch
      const dirty = await step(gitArgv.dirty, checkout)
      if (dirty.exitCode !== 0 || dirty.stdout.trim() !== '') return fail('your checkout has changes not committed: the merge waits for a clean checkout (Retry delivery once it is)')
      const on = (await step(gitArgv.currentBranch, checkout)).stdout.trim()
      if (on !== run.base) return fail(`your checkout is on \`${on}\`, and the plan started from \`${run.base}\`: the merge waits for \`${run.base}\` (Retry delivery once it is checked out)`)
    }
    let url: string | undefined
    for (const s of deliverySteps(d.mode, { ...(run.branch ? { branch: run.branch } : {}), ...(run.base ? { base: run.base } : {}), title: run.title, report })) {
      const merge = s.argv[1] === 'merge'
      const r = await step(s.argv, merge ? checkout : repo)
      // a pull request that exists already (a delivery cut, then retried) is the plan's: the step is done (H-2)
      const existing = r.exitCode !== 0 && s.argv[0] === 'gh' ? existingPr(`${r.stdout}\n${r.stderr}`) : undefined
      if (existing) { url = existing; continue }
      if (r.exitCode !== 0 && merge) {
        // a merge that does not go clean is undone: the checkout as it was, the branch kept (H-1 of the Phase 4 review)
        if ((await step(gitArgv.mergeHead, checkout)).exitCode === 0) await step(gitArgv.mergeAbort, checkout)
        return fail(`\`${run.branch}\` does not merge cleanly into \`${run.base}\`: your checkout is as it was, and the branch stays`)
      }
      if (r.exitCode !== 0) return fail(`\`${s.argv.slice(0, 3).join(' ')}\` failed (exit ${r.exitCode}): ${firstLine(r.stderr || r.stdout).slice(0, 200)}`)
      url = prUrl(r.stdout) ?? url
    }
    // the worktree goes, the branch stays (D-71); one with changes not committed stays too, and says so
    let worktree: string | undefined
    let folderLeft: string | undefined
    if (run.isolation === 'worktree' && run.tree) {
      // the plan's threads are done: one whose process is still alive holds the folder as its cwd (H-4), so it stops first
      await stopPlanThreads($, run)
      const r = await step(gitArgv.worktreeRemove(run.tree))
      if (r.exitCode === 0) worktree = 'removed; the branch stays'
      else if (!worktreeListed((await step(gitArgv.worktreeList)).stdout, run.tree) && (await $.fs.exists(run.tree))) {
        // git let go of the worktree, but something still held its folder: an empty folder, removed at a later look
        worktree = 'removed; its empty folder goes once nothing holds it'
        folderLeft = run.tree
      } else worktree = `kept at ${run.tree}: ${firstLine(r.stderr || r.stdout).slice(0, 160)}`
    }
    const nowIso = new Date(await $.clock.now()).toISOString()
    run = { ...run, delivery: { ...d, state: 'delivered', at: nowIso, ...(url ? { url } : {}), steps, ...(worktree ? { worktree } : {}), ...(folderLeft ? { folderLeft } : {}) }, updatedAt: nowIso }
    delete (run.delivery as { reason?: string }).reason
    await putPlans($, repo, [run])
    await recordPlan($, run, 'done@-', `delivered: ${d.mode}${url ? ` ${url}` : ''}`)
    await editRunDoc($, runId, nowIso, doc => { doc.delivery = run.delivery })
    await writeReport($, run)
    const words = deliveredWords(run.delivery as { mode: 'pr' | 'merge' | 'branch' | 'none'; state: 'delivered'; url?: string }, run.branch)
    // delivery.handoffToApp (D-72, off by default): the chat's model is asked to bind the pull request to the app's monitor
    if (url && parsed.profile.delivery.handoffToApp) await $.prompt.submit({ text: `foreman opened the pull request ${url} for the plan ${run.title}. Bind it to the app's pull request monitor (the ccd_pr tools), then say so in one line.` }).catch(() => undefined)
    await notice($, parsed, `${runId}: delivered, ${words}${d.note ? ` (${d.note})` : ''}; the report is ${report}`, d.note && d.mode === 'branch' && d.note.includes('ask a person') ? 'stop' : 'info', runId)
    return `Delivered ${runId}: ${words}.`
  } finally {
    deliveringNow.delete(runId)
  }
}

/** Stops the plan's threads whose process is still alive (their parts are done): a live one holds the worktree's folder (H-4). */
async function stopPlanThreads($: EngineInterface, run: ForemanPlanRun): Promise<void> {
  const ids = new Set((await read($, cycles)).filter(c => c.runId === run.id).map(c => c.implThread))
  const rows = await listRows($).catch(() => [] as ForemanAgentRow[])
  for (const t of (await read($, threads)).filter(x => ids.has(x.id))) {
    const row = background.rowOf(t, rows)
    if (row?.kind !== 'background' || row.pid === undefined) continue
    await $.process.run(background.stopArgv(claudeExe(), t.id), { timeoutMs: 30_000 }).catch(() => undefined)
  }
}

/** A worktree's empty folder a process held at the delivery: removed once nothing holds it (H-4); it stays listed until then. */
async function removeLeftFolder($: EngineInterface, run: ForemanPlanRun): Promise<void> {
  const left = run.delivery?.folderLeft
  if (!left || removingFolder.has(run.id)) return
  removingFolder.add(run.id)
  try {
    const { repo } = await roots($)
    let gone = !(await $.fs.exists(left))
    if (!gone) {
      const isWindows = (await $.env.get('OS')) === 'Windows_NT'
      const r = await $.process.run(emptyDirRemoveArgv(isWindows), { cwd: repo, env: { FOREMAN_RMDIR: left }, timeoutMs: 30_000 }).catch(() => undefined)
      gone = r?.exitCode === 0 && !(await $.fs.exists(left))
    }
    if (!gone) return
    const nowIso = new Date(await $.clock.now()).toISOString()
    const delivery = { ...(run.delivery as NonNullable<ForemanPlanRun['delivery']>), worktree: 'removed; the branch stays' }
    delete delivery.folderLeft
    const next: ForemanPlanRun = { ...run, delivery, updatedAt: nowIso }
    await putPlans($, repo, [next])
    await recordPlan($, next, 'done@-', 'the worktree\'s empty folder is gone')
    await editRunDoc($, run.id, nowIso, doc => { doc.delivery = next.delivery })
    await writeReport($, next)
  } finally {
    removingFolder.delete(run.id)
  }
}

/** The plan a command names (its id or its file), else the active one. */
async function planNamed($: EngineInterface, ref: string | undefined): Promise<ForemanPlanRun | string> {
  const list = await putPlans($, (await roots($)).repo, [])
  const run = ref ? list.find(p => p.id === ref || normPath(p.plan) === normPath(ref)) : list.find(isPlanActive)
  return run ?? (ref ? `No plan "${ref}" here.` : 'No active plan here.')
}

/** The cycle of the run's current part, as the registry has it. */
async function currentCycle($: EngineInterface, run: ForemanPlanRun): Promise<ForemanCycle | undefined> {
  const part = run.parts[run.current]
  return part ? (await read($, cycles)).find(c => c.id === partCycleId(run.id, part.id)) : undefined
}

async function pauseOrResume($: EngineInterface, args: string, what: 'pause' | 'resume'): Promise<string> {
  const run = await planNamed($, parseArgs(args).positional[1])
  if (typeof run === 'string') return run
  const { repo } = await roots($)
  const at = new Date(await $.clock.now()).toISOString()
  const from = `${run.status}@${run.parts[run.current]?.id ?? '-'}`
  if (what === 'pause') {
    if (run.status !== 'running') return `${run.id} is ${run.status}; nothing to pause.`
    const next = pauseRun(run, at, 'paused by the person; Continue (or /foreman resume) goes on')
    await putPlans($, repo, [next])
    await recordPlan($, next, from, 'paused')
    await writeProgress($, run.id)
    return `Paused ${run.id}: the part in progress goes on, the next one waits for Continue.`
  }
  if (run.status !== 'paused') return `${run.id} is ${run.status}; nothing to resume.`
  // at a part boundary the person's resume answers whatever stopped before the next part (D-76, D-66)
  const atBoundary = (await currentCycle($, run))?.phase === 'ready'
  const next = resumeRun(run, at, atBoundary)
  await putPlans($, repo, [next])
  await recordPlan($, next, from, atBoundary ? `resumed: part ${next.parts[next.current + 1]?.id ?? '-'} may start` : 'resumed')
  await writeProgress($, run.id)
  spawnSync($, true)
  return `Resumed ${run.id}: ${runLine(next, await read($, cycles))}.`
}


/** Stop (the pane's button, `/foreman stop`): the plan ends, its current part is closed and its thread stopped for the person. */
async function stopPlan($: EngineInterface, runId: string): Promise<string> {
  const { repo } = await roots($)
  const run = (await putPlans($, repo, [])).find(p => p.id === runId)
  if (!run) return `No plan "${runId}" here.`
  if (!isPlanActive(run)) return `${run.id} is ${run.status} already.`
  const at = new Date(await $.clock.now()).toISOString()
  const c = await currentCycle($, run)
  const notes: string[] = []
  if (c && isActive(c)) {
    const closed = moveTo(c, 'closed', at)
    await putCycles($, repo, [closed])
    await recordCycle($, closed, c.phase, 'closed: the plan was stopped')
    const t = (await pullThreads($, repo)).find(x => x.id === c.implThread)
    if (t && !['done', 'stopped', 'failed'].includes(t.state)) {
      const failed = await holdThread($, t, 'stopped with its plan')
      if (failed) notes.push(failed)
    }
  }
  const stopped = stopRun(run, at, 'stopped by the person')
  await putPlans($, repo, [stopped])
  await recordPlan($, stopped, `${run.status}@${run.parts[run.current]?.id ?? '-'}`)
  // its reviewer and its supervisor end with it (review F-1)
  const cut = await cutPlanProcesses($, run.id)
  if (cut.length) await recordPlan($, stopped, `stopped@${stopped.parts[stopped.current]?.id ?? '-'}`, `the Stop cut ${cut.map(k => (k.startsWith('supervisor:') ? 'the supervisor' : 'the reviewer')).join(' and ')}`)
  await writeProgress($, run.id)
  return `Stopped ${run.id}${notes.length ? ` (${notes.join('; ')})` : ''}. Its commits and files stay; /foreman go ${run.plan} --parts <ids> starts again from the parts you name.`
}


/**
 * One look at every active cycle this session may drive. Only the owner acts
 * (owner.ts); an orphan is claimed first and driven from the next look, so two
 * chats that both adopt it settle on one before either acts. What each phase
 * needs done is derived from the record, not from the transition alone, so an
 * adoption or a reload finishes an effect the previous run left half done and
 * never repeats one already done (review N-02).
 */
async function advanceCycles($: EngineInterface, repo: string, parsed: ParsedProfile, rows: readonly ForemanAgentRow[], nowIso: string): Promise<void> {
  const me = await $.session.id()
  for (const c0 of (await putCycles($, repo, [])).filter(isActive)) {
    const s = standing(c0.owner, me, rows)
    if (s === 'other') continue
    if (s === 'orphan') {
      const claimed: ForemanCycle = { ...c0, owner: me, claimedAt: nowIso, updatedAt: nowIso }
      await putCycles($, repo, [claimed])
      await recordCycle($, claimed, c0.phase, `adopted by ${me.slice(0, 8)}`)
      continue
    }
    let c = c0
    let revs = await storedReviews($, repo)
    // a review the request already started (this run or the previous owner's): bind it, never start a second
    const found = pendingRequest(c, revs)
    if (found) c = bindRound(c, found, nowIso)
    const thread = (await read($, threads)).find(t => t.id === c.implThread)
    const last = c.rounds.at(-1)
    const runPaused = (await read($, plans)).find(p => p.id === c.runId)?.status === 'paused'
    const step = stepCycle(c, { thread, review: last ? revs.find(r => r.agentId === last.agentId) : undefined, nowIso, runPaused })
    c = step.cycle
    if (c !== c0) await putCycles($, repo, [c])
    if (step.moved) await recordCycle($, c, c0.phase)
    // a part that is ready is its implementer's end: the thread is done, not "ready for review" (review O-4)
    if (c.phase === 'ready' && c0.phase !== 'ready' && thread && thread.state === 'ready') {
      const done: ForemanThread = { ...thread, state: 'done', updatedAt: nowIso }
      await putThreads($, repo, [done])
      await recordRun($, done, thread.state, `part ${c.part} ready`)
    }
    for (const eff of step.effects) {
      if (eff.kind === 'notify') await notice($, parsed, eff.text, eff.level, c.runId)
      if (eff.kind === 'revive' && thread) c = await reviveThread($, parsed, c, thread)
      if (eff.kind === 'decided') await appendDecision($, c, { ...eff.note, part: c.part, ...(eff.reason ? { reason: eff.reason } : {}), ...(eff.question ? { question: eff.question.slice(0, 600) } : {}) })
    }
    // supervising: the supervisor runs in the background (one at a time per part); a decision made and not yet
    // carried out (a reload between the two) is carried out now, never twice
    if (c.phase === 'supervising') {
      if (c.deciding !== undefined) c = await carryDecision($, parsed, c)
      else if (!supervisingNow.has(c.id)) void superviseInBackground($, c.id).catch(err => $.ui.log(`the supervisor of ${c.id} failed: ${errText(err)}`))
    }
    // reviewing with no round for the request yet: start the review (once: a bound round ends this)
    revs = await storedReviews($, repo)
    if (c.phase === 'reviewing' && c.reviewRequestedAt !== undefined && !pendingRequest(c, revs) && !requestBound(c, revs)) {
      // the previous review is the last one that counted; after "could not run", the retry is told how to run the gates (D-124)
      const previous = [...c.rounds].reverse().find(r => !r.free)?.file
      const note = c.rounds.at(-1)?.free === 'could-not-run' ? COULD_NOT_RUN_NOTE : undefined
      const out = await spawnReview($, { runId: c.runId, part: c.part, base: c.base, plan: c.plan, ...(previous ? { previous } : {}), ...(note ? { note } : {}) })
      const settled = 'error' in out ? (await storedReviews($, repo)).find(r => r.runId === c.runId && r.part === c.part && Date.parse(r.startedAt) >= Date.parse(c.reviewRequestedAt as string)) : out.review
      if (settled) {
        c = bindRound(c, settled, new Date(await $.clock.now()).toISOString())
        await putCycles($, repo, [c])
        await recordCycle($, c, c.phase, `review r${settled.n} started`)
      } else if ('error' in out) {
        const from = c.phase
        c = moveTo(c, 'waiting', new Date(await $.clock.now()).toISOString(), { waitingOn: 'person', reason: `the review could not start: ${out.error}` })
        await putCycles($, repo, [c])
        await recordCycle($, c, from)
        await notice($, parsed, `${c.id}: waiting, ${c.reason}`, 'stop', c.runId)
      }
    }
    // applying: resume the implementer on the review's path, unless that was already sent
    if (c.phase === 'applying') {
      const round = c.rounds.at(-1)
      const t = (await pullThreads($, repo)).find(x => x.id === c.implThread)
      const at = new Date(await $.clock.now()).toISOString()
      if (round && t && t.sentAt !== undefined && Date.parse(t.sentAt) >= Date.parse(c.phaseAt)) {
        const from = c.phase
        c = moveTo(c, 'implementing', at)
        await putCycles($, repo, [c])
        await recordCycle($, c, from, `resume for review r${round.n} already sent`)
      } else if (round && t) {
        const sent = await sendToThread($, t, applyMessage(round), `apply review r${round.n}`)
        const from = c.phase
        if ('thread' in sent) c = moveTo(c, 'implementing', sent.thread.sentAt ?? at)
        else if (!/the thread is working/.test(sent.error)) c = moveTo(c, 'waiting', at, { waitingOn: 'person', reason: `could not resume the implementer: ${sent.error}` })
        if (c.phase !== from) {
          await putCycles($, repo, [c])
          await recordCycle($, c, from, 'thread' in sent ? `implementer resumed on ${round.file}` : undefined)
          if (c.phase === 'waiting') await notice($, parsed, `${c.id}: waiting, ${c.reason}`, 'stop', c.runId)
        }
      }
    }
    if (c !== c0) await writeProgress($, c.runId)
  }
}

/** The cycles whose supervisor runs now in this session (a look never starts a second one). */
const supervisingNow = new Set<string>()

/** The repo's delivery rule, in the supervisor's words (D-72: delivery is code, Phase 4). */
function deliveryWords(mode: string): string {
  switch (mode) {
    case 'pr': return 'pr: once every part is ready, foreman pushes the plan\'s branch and opens a pull request; nobody else pushes, opens a PR or merges.'
    case 'merge': return 'merge: once every part is ready, foreman merges the plan\'s branch locally; nobody else pushes or merges.'
    case 'none': return 'none: the commits stay where they are; nothing is pushed, no pull request, no merge.'
    default: return 'branch: the work stays on its branch; nothing is pushed, no pull request, no merge.'
  }
}

/** A line of the run's decisions.jsonl (D-68), and the cycle's short note of it. */
async function appendDecision($: EngineInterface, c: ForemanCycle, r: DecisionRecord): Promise<void> {
  const run = (await read($, plans)).find(p => p.id === c.runId)
  if (!run) return
  const path = planFile(run.dir, PLAN_FILES.decisions)
  try {
    const old = await $.fs.read(path).catch(() => '')
    await $.fs.write(path, `${typeof old === 'string' ? old : ''}${JSON.stringify(r)}\n`)
  } catch (err) {
    $.ui.log(`could not write ${path}: ${errText(err)}`)
  }
}

/**
 * The supervisor at a stop (D-68): a `claude -p` process in the work tree,
 * read-only, with the brief on stdin (the part, its criteria, what stopped as
 * data, the review's first lines, the delivery rule, the authority table, the
 * decisions it may take, the earlier ones). Its JSON is checked by code; no
 * JSON, a timeout, a decision out of the set or past the table is `escalate`.
 * It runs in the background: the watcher and the commands go on meanwhile, and
 * the decision is carried out when it lands, unless the part moved on.
 */
async function superviseInBackground($: EngineInterface, id: string): Promise<void> {
  if (supervisingNow.has(id)) return
  supervisingNow.add(id)
  try {
    const { work, repo } = await roots($)
    const parsed = await loadProfile($, work)
    let c = (await putCycles($, repo, [])).find(x => x.id === id)
    if (!c || c.phase !== 'supervising' || !c.supervising || c.deciding) return
    const stop = c.supervising
    const runs = (c.supervisorRuns ?? 0) + 1
    // a start that never answered was lost with foreman's reload: it starts once more, uncounted; the next loss is the person's
    const attempts = (c.supervisorAttempts ?? 0) + 1
    c = { ...c, supervisorAttempts: attempts, updatedAt: new Date(await $.clock.now()).toISOString() }
    await putCycles($, repo, [c])
    const allowed = allowedFor(stop, { replanned: c.replanned === true, roundsLeft: c.maxCycles - roundsUsed(c) })
    const pp = await planPartOf($, work, c.plan, c.part)
    const reviewText = stop.reviewFile ? await $.fs.read(stop.reviewFile).catch(() => undefined) : undefined
    const template = (await readPrompt($, 'supervisor.md')) ?? '{{stop}}\n{{implementer}}\n{{allowed}}'
    const brief = supervisorBrief(template, {
      plan: c.plan, part: c.part, partTitle: pp?.title ?? c.part, partText: pp?.text ?? '', criteria: pp?.criteria ?? [], stop,
      ...(typeof reviewText === 'string' ? { reviewText } : {}),
      delivery: deliveryWords(parsed.profile.delivery.mode), allowed,
      history: (c.decisions ?? []).map(n => historyLine({ ...n, part: c?.part ?? '' })), runsLeft: SUPERVISOR_BUDGET - runs,
    })
    const rc = roleAt(parsed.profile, 'supervisor')
    const argv = processArgv({ exe: claudeExe(), role: 'supervisor', name: threadName(c.runId, 'supervisor', c.part), model: rc.model, effort: rc.effort, maxTurns: MAX_TURNS.supervisor })
    const startedAt = await $.clock.now()
    let outcome: ProcessOutcome
    let stoppedBy = false
    if (attempts > 2) {
      outcome = { ok: false, why: 'its run ended twice without an answer (foreman was reloaded while it ran)', denials: [] }
    } else {
      try {
        const tree = (await read($, plans)).find(x => x.id === c?.runId)?.tree ?? work
        // through spawn, so a Stop can end it (review F-1)
        const out = await spawnCut($, argv, tree, brief, SUPERVISOR_TIMEOUT_MS, `supervisor:${id}`)
        if (out.stopped) stoppedBy = true
        outcome = readProcess(out)
      } catch (err) {
        outcome = readProcess({ exitCode: -1, stdout: '', stderr: errText(err) })
      }
    }
    if (cutByStop.delete(`supervisor:${id}`)) stoppedBy = true
    const durationMs = (await $.clock.now()) - startedAt
    const parsedDecision = outcome.ok ? parseDecision(outcome.result) : { why: `the supervisor gave no answer: ${outcome.why}` }
    const by: 'supervisor' | 'code' = 'decision' in parsedDecision ? 'supervisor' : 'code'
    const raw: Decision = 'decision' in parsedDecision ? parsedDecision.decision : { decision: 'escalate', reason: `foreman: ${parsedDecision.why}`, question: stop.text }
    const decision = checkDecision(raw, allowed, stop.text)
    const nowIso = new Date(await $.clock.now()).toISOString()
    const record: DecisionRecord = {
      at: nowIso, part: c.part, stop: stop.kind, by: decision === raw ? by : 'code', decision: decision.decision,
      ...('text' in decision ? { text: decision.text } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.decision === 'escalate' ? { question: decision.question.slice(0, 600) } : {}),
      ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}), durationMs,
    }
    // the run is counted now that it answered (a lost one was not); the part may have moved on while it ran (the person
    // answered): then the decision is kept, not carried out
    const latest = (await putCycles($, repo, [])).find(x => x.id === id)
    const counted = (x: ForemanCycle): ForemanCycle => {
      const y: ForemanCycle = { ...x, supervisorRuns: attempts > 2 ? x.supervisorRuns ?? 0 : (x.supervisorRuns ?? 0) + 1, updatedAt: nowIso }
      delete y.supervisorAttempts
      return y
    }
    if (stoppedBy) {
      // a Stop cut it (review F-1): nothing it said is carried out
      if (latest) await putCycles($, repo, [counted(latest)])
      const cutNote: DecisionRecord = { at: nowIso, part: c.part, stop: stop.kind, by: 'code', decision: 'escalate', reason: 'cut: the plan was stopped while the supervisor ran; nothing was carried out', question: stop.text.slice(0, 600), ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}), durationMs }
      await appendDecision($, c, cutNote)
      return
    }
    if (!latest || latest.phase !== 'supervising' || latest.supervising?.at !== stop.at || latest.deciding) {
      if (latest) await putCycles($, repo, [counted(latest)])
      await appendDecision($, c, { ...record, reason: `${record.reason ?? ''} (not carried out: the part moved on while the supervisor ran)`.trim() })
      return
    }
    const now = counted(latest)
    await appendDecision($, now, record)
    const step = decide(now, decision, record.by, nowIso)
    await putCycles($, repo, [step.cycle])
    await recordCycle($, step.cycle, now.phase, `supervisor (${record.by}): ${decision.decision}${outcome.costUsd !== undefined ? `, ${outcome.costUsd.toFixed(3)} USD` : ''}`)
    for (const eff of step.effects) if (eff.kind === 'notify') await notice($, parsed, eff.text, eff.level, now.runId)
    if (step.cycle.deciding !== undefined) await carryDecision($, parsed, step.cycle)
    await writeProgress($, now.runId)
  } finally {
    supervisingNow.delete(id)
    spawnSync($, true)
  }
}

/**
 * Carries out an answer or a replan the supervisor decided (`deciding`): the
 * message to the implementer, once. A message already sent (the thread's
 * `sentAt` is after the decision) only moves the part on; a thread at work
 * waits for the next look; any other failure waits for the person.
 */
async function carryDecision($: EngineInterface, parsed: ParsedProfile, c: ForemanCycle): Promise<ForemanCycle> {
  const d = c.deciding
  if (!d) return c
  const { repo } = await roots($)
  const t = (await pullThreads($, repo)).find(x => x.id === c.implThread)
  const at = new Date(await $.clock.now()).toISOString()
  const move = async (next: ForemanCycle, note: string): Promise<ForemanCycle> => {
    await putCycles($, repo, [next])
    await recordCycle($, next, c.phase, note)
    return next
  }
  if (!t) return move(moveTo(c, 'waiting', at, { waitingOn: 'person', reason: `the supervisor decided (${d.decision}) but the implementer thread is gone` }), 'decision not carried out')
  if (t.sentAt !== undefined && Date.parse(t.sentAt) >= Date.parse(d.at)) return move(moveTo(c, 'implementing', at), `${d.decision} already sent`)
  let message = answerMessage(d.text)
  if (d.decision === 'replan') {
    const run = (await read($, plans)).find(p => p.id === c.runId)
    const original = t.brief ? await $.fs.read(t.brief).catch(() => '') : ''
    const path = run ? planFile(run.dir, briefFile(`${c.part}-replan`)) : undefined
    if (!path) return move(moveTo(c, 'waiting', at, { waitingOn: 'person', reason: 'the supervisor replanned the part but its run folder is gone' }), 'decision not carried out')
    await $.fs.write(path, replanBrief(typeof original === 'string' ? original : '', d.text, c.supervising?.text ?? ''))
    message = replanMessage(path)
  }
  const sent = await sendToThread($, t, message, d.decision === 'answer' ? 'the supervisor answered' : 'the supervisor replanned the part')
  if ('thread' in sent) return move(moveTo(c, 'implementing', sent.thread.sentAt ?? at), `${d.decision} sent to the implementer`)
  if (/the thread is working/.test(sent.error)) return c
  const next = moveTo(c, 'waiting', at, { waitingOn: 'person', reason: `the supervisor decided (${d.decision}) but it did not reach the implementer: ${sent.error}` })
  await notice($, parsed, `${c.id}: waiting for you, ${next.reason}`, 'stop', c.runId)
  return move(next, 'decision not carried out')
}

/**
 * Resumes a part's implementer whose process ended mid-turn (the app or the
 * computer closed, D-69): `--bg --resume` with a re-brief that says where the
 * work is written down. The cycle already counted it (`revived`, at most
 * REVIVE_MAX); a resume that does not take waits for the person.
 */
async function reviveThread($: EngineInterface, parsed: ParsedProfile, c: ForemanCycle, t: ForemanThread): Promise<ForemanCycle> {
  const { repo } = await roots($)
  // read again, right before the resume: an Open or a Stop the person pressed since this look decides (D-100, D-101)
  const now = (await pullThreads($, repo)).find(x => x.id === t.id) ?? t
  if (now.openedAt !== undefined || now.heldBy !== undefined) {
    await recordCycle($, c, c.phase, `not resumed: ${now.openedAt !== undefined ? 'opened in the app' : 'stopped by the person'} meanwhile`)
    return c
  }
  const run = (await read($, plans)).find(p => p.id === c.runId)
  const message = reviveMessage({ part: c.part, plan: c.plan, ...(t.brief ? { brief: t.brief } : {}), ...(run ? { progress: planFile(run.dir, PLAN_FILES.progress) } : {}) })
  const sent = await sendToThread($, now, message, `resumed after its process ended mid-turn (${c.revived ?? 1} of ${REVIVE_MAX})`)
  if ('thread' in sent) {
    await recordCycle($, c, c.phase, `implementer resumed on a re-brief (${c.revived ?? 1} of ${REVIVE_MAX})`)
    return c
  }
  const waiting = moveTo(c, 'waiting', new Date(await $.clock.now()).toISOString(), { waitingOn: 'person', reason: `its implementer stopped mid-turn and could not be resumed: ${sent.error}` })
  await putCycles($, repo, [waiting])
  await recordCycle($, waiting, c.phase)
  await notice($, parsed, `${c.id}: waiting, ${waiting.reason}`, 'stop', c.runId)
  return waiting
}

/** The cycle's last round is the review its current request started. */
function requestBound(c: ForemanCycle, revs: readonly ForemanReview[]): boolean {
  // by count when the cycle says how many rounds it had at the request (a re-review starts at the same second as the last one)
  if (c.reviewAfter !== undefined) return c.rounds.length > c.reviewAfter
  const last = c.rounds.at(-1)
  const r = last ? revs.find(x => x.agentId === last.agentId) : undefined
  return r !== undefined && c.reviewRequestedAt !== undefined && Date.parse(r.startedAt) >= Date.parse(c.reviewRequestedAt)
}

/**
 * One look at every running plan this session may drive (the same owner rule
 * as cycles): a part that ended ready starts the next one, unless the plan
 * asks for a pause first; the last one ends the plan (run.ts).
 */
async function advancePlans($: EngineInterface, repo: string, parsed: ParsedProfile, rows: readonly ForemanAgentRow[]): Promise<void> {
  const me = await $.session.id()
  // this session's plans: an install command a reload cut runs again; a finished plan not delivered yet is delivered (D-71, D-72)
  for (const r of (await putPlans($, repo, [])).filter(p => standing(p.owner, me, rows) === 'mine')) {
    if (r.status === 'running' && r.prepare?.state === 'running' && !preparingNow.has(r.id)) void prepareTree($, r.id).catch(err => $.ui.log(`prepare ${r.id}: ${errText(err)}`, { to: 'debug' }))
    if (r.status === 'done' && r.delivery && r.delivery.state === undefined && !deliveringNow.has(r.id)) void deliverPlan($, r.id).catch(err => $.ui.log(`deliver ${r.id}: ${errText(err)}`, { to: 'debug' }))
    // a delivery no module is running was cut by a reload: not delivered, with Retry; never published again by itself (H-2)
    if (r.status === 'done' && r.delivery?.state === 'pending' && !deliveringNow.has(r.id)) await cutDelivery($, parsed, r)
    // the empty folder a live process held at the delivery goes once nothing holds it (H-4)
    if (r.status === 'done' && r.delivery?.folderLeft) await removeLeftFolder($, r)
  }
  for (const r0 of (await putPlans($, repo, [])).filter(p => p.status === 'running')) {
    const nowIso = new Date(await $.clock.now()).toISOString()
    const s = standing(r0.owner, me, rows)
    if (s === 'other') continue
    if (s === 'orphan') {
      const claimed: ForemanPlanRun = { ...r0, owner: me, updatedAt: nowIso }
      await putPlans($, repo, [claimed])
      await recordPlan($, claimed, `${r0.status}@${r0.parts[r0.current]?.id ?? '-'}`, `adopted by ${me.slice(0, 8)}`)
      continue
    }
    const part = r0.parts[r0.current]
    const current = part ? (await read($, cycles)).find(c => c.id === partCycleId(r0.id, part.id)) : undefined
    const step = stepPlan(r0, current, nowIso)
    let run = step.run
    if (step.moved) {
      await putPlans($, repo, [run])
      await recordPlan($, run, `${r0.status}@${part?.id ?? '-'}`)
      await writeProgress($, run.id)
    }
    for (const eff of step.effects) {
      if (eff.kind === 'notify') await notice($, parsed, eff.text, eff.level, run.id)
      if (eff.kind === 'start') {
        const next = run.parts[eff.index]
        // this session is starting it right now (go, or a look before this one): nothing to do yet
        if (next && partStarting.has(partCycleId(run.id, next.id))) continue
        const exists = next ? (await read($, cycles)).find(c => c.id === partCycleId(run.id, next.id)) : undefined
        if (exists) {
          // started before (a reload, an adoption): the run only moves to it
          run = atPart(run, eff.index, nowIso)
          await putPlans($, repo, [run])
          continue
        }
        const out = await beginPart($, run, eff.index)
        if ('error' in out) {
          const paused = pauseRun(run, new Date(await $.clock.now()).toISOString(), `part ${next?.id ?? eff.index + 1} could not start: ${out.error}`)
          await putPlans($, repo, [paused])
          await recordPlan($, paused, `${run.status}@${part?.id ?? '-'}`)
          await writeProgress($, run.id)
          await notice($, parsed, `${run.id}: paused, ${paused.reason}`, 'stop', run.id)
        } else {
          run = out.run
          if (eff.index > 0) await notice($, parsed, `${run.id}: part ${next?.id} started (${out.thread.name})`, 'info', run.id)
        }
      }
    }
  }
}

/**
 * Threads at a usage limit whose reset has passed: told to go on, by their
 * owner (an orphan is claimed first, as a cycle). The reset time lives in the
 * registry (`retryAt`), so a reload or a new session retries it too.
 */
async function retryLimits($: EngineInterface, repo: string, rows: readonly ForemanAgentRow[], now: number): Promise<void> {
  const me = await $.session.id()
  for (const t of await pullThreads($, repo)) {
    if (t.closed || t.state !== 'limit' || t.retryAt === undefined || Date.parse(t.retryAt) > now) continue
    const s = standing(t.owner, me, rows)
    if (s === 'other') continue
    if (s === 'orphan') {
      await putThreads($, repo, [{ ...t, owner: me, updatedAt: new Date(now).toISOString() }])
      continue
    }
    const out = await sendToThread($, t, LIMIT_RESUME, 'usage limit reset: resumed')
    if ('error' in out) $.ui.log(`could not resume ${t.name} after its usage limit: ${out.error}`)
  }
}

/** Wakes the watcher at the earliest pending reset (the 30 s watcher would also find it; this is the exact time). */
async function scheduleRetries($: EngineInterface, repo: string): Promise<void> {
  const now = await $.clock.now()
  const next = (await storedThreads($, repo)).filter(t => t.state === 'limit' && t.retryAt).map(t => Date.parse(t.retryAt as string)).filter(x => x > now).sort((a, b) => a - b)[0]
  if (next !== undefined) $.clock.after(Math.min(next - now, 2 ** 31 - 1), () => spawnSync($, true))
}

function cycleLine(c: ForemanCycle): string {
  const rounds = c.rounds.map(r => `r${r.n} ${r.verdict}`).join(', ') || 'no review yet'
  return `- Part ${c.part} of ${c.runId}: ${c.phase}${c.reason ? ` (${c.reason})` : ''} · ${rounds} · max ${c.maxCycles}`
}

/** What 0.1 left in the store, said once in status (D-80): its records are read, never driven or written. */
async function legacyNote($: EngineInterface, repo: string): Promise<string | undefined> {
  const [t, c, r] = await Promise.all(legacyKeys(repo).map(k => $.store.get(k)))
  const open = (Array.isArray(t) ? (t as { closed?: boolean; state?: string }[]) : []).filter(x => !x.closed && x.state !== 'done').length
  const cyc = (Array.isArray(c) ? (c as { phase?: string }[]) : []).filter(x => x.phase !== 'ready' && x.phase !== 'closed').length
  const rev = (Array.isArray(r) ? (r as { finishedAt?: string }[]) : []).filter(x => !x.finishedAt).length
  if (open + cyc + rev === 0) return undefined
  return `foreman 0.1 left ${open} open thread(s), ${cyc} unfinished cycle(s) and ${rev} pending review(s) in this repo; 0.2 shows and drives only its own. The 0.1 run files under .claude/runs/ stay where they are.`
}

// ---------------------------------------------------------------- the pane's buttons (Phase 6 of 0.1)

/** Runs a pane action and shows its answer as a toast; a failure is said, never thrown into the drawing. */
async function paneAction($: EngineInterface, label: string, act: () => Promise<string>): Promise<void> {
  let text: string
  try {
    text = (await act()).split('\n')[0] ?? ''
  } catch (err) {
    text = `failed: ${errText(err)}`
  }
  $.ui.toast(text)
  // the pane says it too: a toast the surface does not show must not leave a press looking like it did nothing
  const at = new Date(await $.clock.now()).toISOString()
  await update($, paneUi, ui => ({ ...ui, lastAction: { at, text: `${label}: ${text}` } }))
  spawnSync($, true)
}

/** Pause when the plan runs, Continue when it is paused: the pane's one button for both. */
async function togglePlan($: EngineInterface, runId: string): Promise<string> {
  const run = (await putPlans($, (await roots($)).repo, [])).find(p => p.id === runId)
  if (!run) return `No plan "${runId}" here.`
  return pauseOrResume($, `${run.status === 'paused' ? 'resume' : 'pause'} ${runId}`, run.status === 'paused' ? 'resume' : 'pause')
}

/**
 * Every press on the pane's buttons, by key (`ui.press`): the action runs from
 * here, not from the closure of the tree that drew the button, so a press the
 * surface sends after a redraw still lands (the Phase 2 acceptance saw a
 * Resume do nothing). Each press of a plan's button is kept in its foreman.json.
 */
async function panePress($: EngineInterface, element: string, surface: string): Promise<boolean> {
  const key = parseKey(element)
  if (!key) return false
  const at = new Date(await $.clock.now()).toISOString()
  const thread = key.action === 'open' || key.action === 'review' ? (await read($, threads)).find(t => t.id === key.id) : undefined
  const runId = thread ? thread.runId : ['toggle', 'continue', 'stop', 'stop-confirm', 'stop-cancel', 'why', 'retry', 'report'].includes(key.action) ? key.id : undefined
  if (runId && isSafeId(runId) && runId !== ADHOC) await editRunDoc($, runId, at, doc => { doc.presses = [...(doc.presses ?? []), { at, element, surface }].slice(-200) })
  $.ui.log(`pane: ${element} pressed on ${surface}`, { to: 'debug' })
  switch (key.action) {
    case 'refresh': spawnSync($, true); break
    case 'toggle': void paneAction($, 'Pause/Continue', () => togglePlan($, key.id)); break
    case 'continue': void paneAction($, 'Continue', () => pauseOrResume($, `resume ${key.id}`, 'resume')); break
    // Stop asks in the pane (D-113: $.ui.ask from a press is not proven): Stop again confirms, Keep going does nothing
    case 'stop': await update($, paneUi, ui => ({ ...ui, confirmStop: key.id })); break
    case 'stop-confirm': await update($, paneUi, ui => ({ ...ui, confirmStop: undefined })); void paneAction($, 'Stop', () => stopPlan($, key.id)); break
    case 'stop-cancel': await update($, paneUi, ui => ({ ...ui, confirmStop: undefined })); void paneAction($, 'Keep going', async () => `Not stopped: ${key.id} goes on.`); break
    case 'open': void paneAction($, 'Open', () => paneOpen($, key.id)); break
    case 'review': void paneAction($, 'Review', () => paneShowReview($, key.id)); break
    case 'why': await update($, paneUi, ui => ({ ...ui, why: ui.why !== true })); break
    case 'retry': void paneAction($, 'Retry delivery', () => retryDelivery($, key.id)); break
    case 'report': void paneAction($, 'Report', () => paneShowReport($, key.id)); break
    case 'details': await update($, paneUi, ui => ({ ...ui, details: ui.details !== true })); break
  }
  return true
}

/**
 * Send in the pane's "Needs you" (`ui.input`, by key): the person's words to
 * the thread. The field is drawn anew, empty, and "Sent ✓" shows a few seconds.
 */
async function paneInput($: EngineInterface, element: string, text: string, surface = 'unknown'): Promise<void> {
  const id = replyThread(element)
  if (id === undefined) return
  const pressedAt = new Date(await $.clock.now()).toISOString()
  const runId = (await read($, threads)).find(t => t.id === id)?.runId
  if (runId && isSafeId(runId) && runId !== ADHOC) await editRunDoc($, runId, pressedAt, doc => { doc.presses = [...(doc.presses ?? []), { at: pressedAt, element, surface }].slice(-200) })
  let sentOk = false
  await paneAction($, 'Send', async () => {
    const out = await paneReply($, id, text)
    sentOk = out.startsWith('Sent to ')
    return out
  })
  if (!sentOk) return
  const at = new Date(await $.clock.now()).toISOString()
  await update($, paneUi, ui => ({ ...ui, replies: { ...(ui.replies ?? {}), [id]: (ui.replies?.[id] ?? 0) + 1 }, sent: { at, thread: id } }))
  $.clock.after(SENT_MS + 500, () => void clearSent($, at))
}

/** "Sent ✓" goes after its few seconds, unless a later Send replaced it. */
async function clearSent($: EngineInterface, at: string): Promise<void> {
  await update($, paneUi, ui => (ui.sent?.at === at ? { ...ui, sent: undefined } : ui))
}

async function paneOpen($: EngineInterface, id: string): Promise<string> {
  const t = (await pullThreads($, (await roots($)).repo)).find(x => x.id === id)
  return t ? openInApp($, t) : `No thread ${id}.`
}

/** The most of a review the pane draws (M5): the verdict and the findings come first in the file. */
const SHOWN_MAX_LINES = 160
const SHOWN_MAX_CHARS = 12_000

/** Show review: the review's text in the pane (M5), cut to fit; pressed again, hidden. */
async function paneShowReview($: EngineInterface, threadId: string): Promise<string> {
  const shown = (await read($, paneUi)).shown
  // the thread's last review: its part's last round
  const file = threadId === '' ? undefined : [...(await read($, cycles))].reverse().find(c => c.implThread === threadId)?.rounds.at(-1)?.file
  if (threadId === '' || (file !== undefined && shown?.file === file)) {
    await update($, paneUi, ui => ({ ...ui, shown: undefined }))
    return 'Review hidden.'
  }
  if (file === undefined) return 'No review of this part yet.'
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string') return `Cannot read ${file}.`
  const lines = text.split(/\r?\n/)
  let cut = lines.slice(0, SHOWN_MAX_LINES).join('\n')
  if (cut.length > SHOWN_MAX_CHARS) cut = cut.slice(0, SHOWN_MAX_CHARS)
  const more = cut.length < text.trimEnd().length ? `\n\n…(${lines.length} lines in all: ${file})` : ''
  await update($, paneUi, ui => ({ ...ui, shown: { file, text: `${cut}${more}` } }))
  return `Showing ${file.split(/[\\/]/).pop() ?? file}.`
}

/** A delivery a reload cut halfway: "Done, not delivered", with Retry delivery in "Needs you" (H-2 of the Phase 4 review). */
async function cutDelivery($: EngineInterface, parsed: ParsedProfile, run: ForemanPlanRun): Promise<void> {
  const { repo } = await roots($)
  const nowIso = new Date(await $.clock.now()).toISOString()
  const reason = 'foreman was reloaded during the delivery'
  const next: ForemanPlanRun = { ...run, delivery: { ...(run.delivery as NonNullable<ForemanPlanRun['delivery']>), state: 'failed', at: nowIso, reason }, updatedAt: nowIso }
  await putPlans($, repo, [next])
  await recordPlan($, next, 'done@-', `not delivered: ${reason}`)
  await editRunDoc($, run.id, nowIso, doc => { doc.delivery = next.delivery })
  await notice($, parsed, `${run.id}: done, not delivered: ${reason}. Retry delivery is in the pane.`, 'stop', run.id)
}

/** Retry delivery (D-72): a plan "Done, not delivered" runs its delivery again. */
async function retryDelivery($: EngineInterface, runId: string): Promise<string> {
  const { repo } = await roots($)
  const run = (await putPlans($, repo, [])).find(p => p.id === runId)
  if (!run || run.status !== 'done' || run.delivery?.state !== 'failed') return `${runId} waits for no delivery.`
  return deliverPlan($, runId)
}

/** Show report: the plan's report.md in the pane; pressed again, hidden. */
async function paneShowReport($: EngineInterface, runId: string): Promise<string> {
  const run = (await read($, plans)).find(p => p.id === runId)
  if (!run) return `No plan "${runId}" here.`
  const file = planFile(run.dir, PLAN_FILES.report)
  if ((await read($, paneUi)).shown?.file === file) {
    await update($, paneUi, ui => ({ ...ui, shown: undefined }))
    return 'Report hidden.'
  }
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string') return `No report yet: ${file}.`
  await update($, paneUi, ui => ({ ...ui, shown: { file, text: text.slice(0, SHOWN_MAX_CHARS) } }))
  return 'Showing the report.'
}

async function paneReply($: EngineInterface, id: string, text: string): Promise<string> {
  if (!text.trim()) return 'Nothing to send.'
  const t = (await pullThreads($, (await roots($)).repo)).find(x => x.id === id)
  if (!t) return `No thread ${id}.`
  const out = await sendToThread($, t, text.trim(), 'message sent from the pane')
  return 'error' in out ? out.error : `Sent to ${t.name}.`
}

async function status($: EngineInterface): Promise<string> {
  await syncFresh($)
  const now = await $.clock.now()
  const { repo } = await roots($)
  const cyc = (await read($, cycles)).filter(c => isActive(c) || Date.parse(c.updatedAt) > now - 86_400_000)
  const runs = (await read($, plans)).filter(p => isPlanActive(p) || Date.parse(p.updatedAt) > now - 86_400_000)
  const recent = (await storedReviews($, repo)).slice(-5)
  const lines = recent.map(r => (r.finishedAt ? `- ${reviewSummary(r)}` : `- Review ${r.part} r${r.n}: running (${r.agentId}), writes ${r.file}`))
  const parts: string[] = []
  if (runs.length) parts.push(`Plans:\n${runs.map(p => `- ${runLine(p, cyc)}`).join('\n')}`)
  if (cyc.length) parts.push(`Parts:\n${cyc.map(cycleLine).join('\n')}`)
  parts.push(statusTable(await read($, threads), now))
  if (lines.length) parts.push(`Reviews:\n${lines.join('\n')}`)
  const legacy = await legacyNote($, repo)
  if (legacy) parts.push(legacy)
  return parts.join('\n\n')
}

/**
 * `/foreman setup` (D-74) and `foreman_setup`: what foreman finds here, then
 * at most three questions (the delivery when the rules ask for pull requests,
 * the isolation when there are submodules, whether to write), and a profile
 * holding only what differs from the defaults; it offers the plan template.
 * `--show` asks nothing and writes nothing; `--claude-exe <path>` sets the
 * `claude` foreman runs. With no dialog, it says what it found and writes nothing.
 */
async function setupCommand($: EngineInterface, args: string): Promise<string> {
  const { flags } = parseArgs(args, ['show'])
  if (flags['claude-exe'] === true) return `foreman runs ${settings.claudeExe || '`claude` from PATH'}. /foreman setup --claude-exe <path> sets the one it runs; --claude-exe "" goes back to the plugin setting.`
  if (typeof flags['claude-exe'] === 'string') return setClaudeExe($, flags['claude-exe'] as string)
  const { work, repo } = await roots($)
  // a plan's worktree reads the main checkout's profile (D-128): a profile written here would be read by nobody (review S-3)
  const planTree = await isPlanTree($, work, repo)
  if (planTree && flags.show !== true) return `This is a plan's worktree: foreman reads the profile of the main checkout here. Run /foreman setup from the main checkout, ${repo}.`
  const parsed = await loadProfile($, work)
  const detected = await detectRepo($, work)
  const head = planTree ? `A plan's worktree: the profile in effect is the main checkout's (${join(repo, PROFILE_PATH)}).`
    : parsed.source === 'default' ? `No ${PROFILE_PATH}: foreman runs on its defaults here.` : `Profile: the defaults + ${PROFILE_PATH}.`
  const found = [head, '', 'What foreman finds here:', ...setupLines(detected, parsed.profile).map(l => `- ${l}`)]
  const warn = parsed.warnings.length ? ['', 'Profile warnings (each key falls back to its default):', ...parsed.warnings.map(w => `- ${w}`)] : []
  if (flags.show === true) return [...found, ...warn, '', 'The profile in effect:', '```json', JSON.stringify(parsed.profile, null, 2), '```'].join('\n')
  const path = join(work, PROFILE_PATH)
  const text = await $.fs.read(path).catch(() => undefined)
  let existing: Record<string, unknown> | undefined
  if (typeof text === 'string' && text.trim() !== '') {
    try {
      existing = JSON.parse(stripJsonComments(text)) as Record<string, unknown>
    } catch {
      return [...found, '', `${PROFILE_PATH} is not valid JSON: fix it or remove it, then run /foreman setup again.`].join('\n')
    }
  }
  const choices = proposedChoices(detected, parsed.profile)
  const noDialog = [...found, ...warn, '', 'Nothing written: there is no dialog here to ask you. /foreman setup in the app asks at most three things.'].join('\n')
  const asks: [keyof SetupChoices, SetupQuestion<string> | undefined][] = [['delivery', deliveryQuestion(detected, parsed.profile)], ['isolation', isolationQuestion(detected, parsed.profile)]]
  for (const [key, q] of asks) {
    if (!q) continue
    const v = await askSetup($, q)
    if (v === null) return noDialog
    if (v !== undefined) Object.assign(choices, { [key]: v })
  }
  const next = setupProfile(existing, choices)
  // by content, not by text: key order, `version` and `mode: "auto"` change nothing (review S-2)
  const changes = next !== undefined ? profileChanges(existing, next) : []
  const changed = changes.length > 0
  const templatePath = join(work, 'docs/plans/TEMPLATE.md')
  const hasTemplate = await $.fs.exists(templatePath)
  // only what changes, not the file's other keys, which stay as they are (review S-1); a file's comments are not kept, and that is said
  const keys = changes.join('; ')
  const comments = typeof text === 'string' && existing !== undefined && stripJsonComments(text).trim() !== text.trim()
  const rest = existing !== undefined ? ` The file's other keys stay as they are${comments ? ', and its comments go' : ''}.` : ''
  const verb = existing !== undefined ? 'Change' : 'Write'
  let writeProfile = false
  let writeTemplate = false
  if (changed) {
    const q = hasTemplate
      ? { text: `${verb} ${PROFILE_PATH}: ${keys}?${rest}`, answers: [{ label: 'Write it', value: 'profile' }, { label: 'Do not write', value: 'none' }] }
      : { text: `${verb} ${PROFILE_PATH}: ${keys}? And add docs/plans/TEMPLATE.md, a plan template?${rest}`, answers: [{ label: 'Write both', value: 'both' }, { label: 'Only the profile', value: 'profile' }, { label: 'Neither', value: 'none' }] }
    const v = await askSetup($, q)
    if (v === null) return noDialog
    writeProfile = v === 'both' || v === 'profile'
    writeTemplate = v === 'both'
  } else if (!hasTemplate) {
    const v = await askSetup($, { text: 'Nothing here differs from foreman\'s defaults, so no profile is needed. Add docs/plans/TEMPLATE.md, a plan template?', answers: [{ label: 'Add the template', value: true }, { label: 'No', value: false }] })
    if (v === null) return noDialog
    writeTemplate = v === true
  }
  const done: string[] = []
  if (writeProfile && next) {
    await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
    profileCache = undefined
    await update($, warnings, () => [])
    done.push(`Wrote ${PROFILE_PATH}: ${keys}.`)
  }
  if (writeTemplate) {
    await $.fs.write(templatePath, PLAN_TEMPLATE)
    done.push('Added docs/plans/TEMPLATE.md: copy it for a plan, then "foreman, run docs/plans/<file>.md".')
  }
  if (done.length === 0) done.push(changed ? 'Nothing written.' : `Nothing to write: ${parsed.source === 'default' ? 'the defaults fit this repo' : `${PROFILE_PATH} already says it`}.`)
  return [...found, ...warn, '', ...done].join('\n')
}

/** One question of setup's dialog: the value of the answer, undefined for one not listed, null with no dialog to ask in. */
async function askSetup<V>($: EngineInterface, q: SetupQuestion<V>): Promise<V | undefined | null> {
  try {
    const answer = await $.ui.ask(q.text, q.answers.map(a => a.label))
    return q.answers.find(a => a.label === answer)?.value
  } catch {
    return null
  }
}

/** `/foreman setup --claude-exe <path>`: the `claude` foreman runs, kept for every session; empty goes back to the plugin setting, else `claude` from PATH (D-132). */
async function setClaudeExe($: EngineInterface, value: string): Promise<string> {
  const v = value.trim()
  if (v === '') {
    await $.store.set(CLAUDE_EXE_KEY, '')
    settings.claudeExe = settings.fromOptions
    return `claudeExe cleared: foreman runs ${settings.claudeExe || '`claude` from PATH'}.`
  }
  if (!(await $.fs.exists(v))) return `${v}: no such file. Give the full path to the claude executable.`
  const r = await $.process.run([v, '--version'], { timeoutMs: 15_000 }).catch(err => ({ exitCode: -1, stdout: '', stderr: errText(err) }))
  if (r.exitCode !== 0) return `${v} did not answer --version (exit ${r.exitCode}): ${firstLine(r.stderr || r.stdout).slice(0, 200)}`
  await $.store.set(CLAUDE_EXE_KEY, v)
  settings.claudeExe = v
  return `foreman runs ${v} (${r.stdout.trim().split('\n')[0]}) from now on, in every session.`
}

async function dispatch($: EngineInterface, args: string): Promise<string> {
  const sub = parseArgs(args).positional[0] ?? ''
  if (RETIRED[sub]) return RETIRED[sub] as string
  switch (sub) {
    case '': return togglePane($)
    case 'go': return goCommand($, args)
    case 'status': return status($)
    case 'pause': return pauseOrResume($, args, 'pause')
    case 'resume': return pauseOrResume($, args, 'resume')
    case 'review': return startReview($, args)
    case 'setup': return setupCommand($, args)
    case 'stop': return stopCommand($, args)
    case 'help': return HELP
    default: return `Unknown command: ${sub}\n${HELP}`
  }
}

// ---------------------------------------------------------------- the model's tools (M2)

/** The thread a tool means: the one named, else the only one in the given states. */
async function threadFor($: EngineInterface, ref: string | undefined, states: readonly ForemanThread['state'][], what: string): Promise<ForemanThread | string> {
  const list = await pullThreads($, (await roots($)).repo)
  if (ref) {
    const found = findThread(list, ref)
    return 'error' in found ? found.error : found.thread
  }
  const candidates = list.filter(t => !t.closed && states.includes(t.state))
  if (candidates.length === 1 && candidates[0]) return candidates[0]
  return candidates.length ? `Several threads ${what}: ${candidates.map(t => `${t.name} (${t.id}, ${t.state})`).join(', ')}; name one (thread).` : `No thread ${what}.`
}

/** foreman_reply: the person's answer to a thread that waits (a dialog needs Open instead). */
async function replyTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const text = textOf(input, 'text')
  if (!text) return 'Pass the user\'s answer as text.'
  const t = await threadFor($, textOf(input, 'thread'), ['waiting', 'blocked', 'stopped'], 'waits for an answer')
  if (typeof t === 'string') return t
  if (t.state === 'blocked') return `${t.name} waits on a dialog (${t.waitingFor ?? 'a permission prompt'}), not on an answer: open it in the app (foreman_open) and answer the dialog there.`
  const out = await sendToThread($, t, text, 'answer sent by the chat (foreman_reply)')
  return 'error' in out ? out.error : `Sent to ${t.name} (${t.id}); it is working again.`
}

/** foreman_open: the thread named, else the one that waits on a dialog or an answer. */
async function openTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const ref = textOf(input, 'thread')
  let t = await threadFor($, ref, ['blocked'], 'waits on a dialog')
  if (typeof t === 'string' && !ref) t = await threadFor($, undefined, ['waiting'], 'waits for an answer')
  return typeof t === 'string' ? t : openInApp($, t)
}

/**
 * The end of foreman_status's answer: what waits for the person, in a line
 * each, and that it is a report. The model read a waiting thread as a cue to
 * open it (Phase 2 acceptance): the answer says the person decides.
 */
async function statusAdvice($: EngineInterface): Promise<string> {
  const lines = waitingLines({ view: await read($, view), threads: await read($, threads), cycles: await read($, cycles), plans: (await read($, plans)).filter(isPlanActive), warnings: [] })
  const what = lines.length ? `Waiting for the person:\n${lines.map(l => `- ${l}`).join('\n')}` : 'Nothing waits for the person.'
  return `${what}\n(A report: tell the user what it says. Open a thread or reply only when the user asks for it.)`
}

/** A tool's answer: its text, or what broke, never a thrown error the model cannot read. */
async function toolAnswer($: EngineInterface, name: string, act: () => Promise<string>): Promise<{ result: string }> {
  try {
    if ((await threadMode($)) !== undefined) return { result: 'This session is a foreman thread: foreman is driven from the chat that coordinates it.' }
    return { result: await act() }
  } catch (err) {
    return { result: `foreman_${name} failed: ${errText(err)}` }
  }
}

// ---------------------------------------------------------------- hooks

/** A thread's status line (D-51): which thread it is, and whether the profile's guards act in it. */
async function threadStatusText($: EngineInterface, name: string): Promise<string> {
  const n = await roots($).then(r => loadProfile($, r.work)).then(p => p.profile.guards.rules.length, () => 0)
  return n > 0 ? `thread ${name}: the profile's guards are on (${n})` : `thread ${name}: no guards in the profile`
}

/**
 * The pane opens by itself once per session, when the first surface attaches
 * and the repo has work going (D-87: in the app `session.start` has no
 * surface yet). Closed by the person, it stays closed: /foreman opens it again.
 */
async function offerPane($: EngineInterface): Promise<void> {
  if ((await read($, paneUi)).offered) return
  await update($, paneUi, ui => ({ ...ui, offered: true }))
  const { repo } = await roots($)
  await pullThreads($, repo)
  await putCycles($, repo, [])
  const busy = (await putPlans($, repo, [])).some(isPlanActive) || (await read($, threads)).some(t => !t.closed && ['working', 'waiting', 'blocked', 'ready', 'limit'].includes(t.state))
  if (!busy || (await $.ui.panes()).some(p => p.id === PANE_ID)) return
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  spawnSync($, true)
}

export const register: Register = (on, options) => {
  const fromOptions = typeof options.claudeExe === 'string' ? options.claudeExe.trim() : ''
  settings = { claudeExe: fromOptions, fromOptions }
  guardsActive = false
  guardsScope = 'threads'
  reviewingNow.clear()
  inflight = undefined
  listedAt = 0
  profileCache = undefined
  rootsCache = undefined
  gitDirCache.clear()
  threadName0 = undefined
  factsCache.clear()
  partStarting.clear()
  supervisingNow.clear()
  preparingNow.clear()
  deliveringNow.clear()

  on('session.start', async ($, e, next) => {
    const thread = await threadMode($).catch(() => undefined)
    if (thread !== undefined) {
      // a foreman thread: its guards act on every call; the rest is the coordinating chat's (D-51)
      const started = await next(e)
      $.ui.status(await threadStatusText($, thread))
      return started
    }
    // the claude path the person set from the chat (/foreman setup --claude-exe) holds over the plugin setting (D-132)
    const ownExe = await $.store.get(CLAUDE_EXE_KEY).catch(() => undefined)
    if (typeof ownExe === 'string' && ownExe.trim() !== '') settings.claudeExe = ownExe.trim()
    await $.command.register({
      name: 'foreman',
      description: 'Run a plan\'s parts as background threads, each implemented, reviewed and applied until OK',
      argumentHint: '[go <plan.md>|setup|status|pause|resume|stop|review|help]',
    })
    const started = await next(e)
    try {
      // the model's tools (M2): in its prompt's tool list, not behind ToolSearch (F0-8, D-88)
      for (const t of TOOLS) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: t.isDeferred })
    } catch (err) {
      $.ui.log(`could not register foreman's tools: ${errText(err)}`, { to: 'debug' })
    }
    try {
      const { work, repo } = await roots($)
      const parsed = await loadProfile($, work)
      await update($, warnings, () => parsed.warnings)
      if (parsed.warnings.length) $.ui.toast(`${parsed.warnings.length} profile warning(s), see /foreman setup --show`)
      await pullThreads($, repo)
      await update($, reviews, () => [])
      await putReviews($, repo, [])
      await settleLost($, repo)
      await putCycles($, repo, [])
      await putPlans($, repo, [])
      await scheduleRetries($, repo)
    } catch (err) {
      $.ui.log(`could not restore the registry: ${errText(err)}`, { to: 'debug' })
    }
    $.clock.every(WATCH_MS, () => spawnSync($))
    spawnSync($, true)
    return started
  })

  // In the app the surface arrives after session.start (D-87): the pane and the thread's status line wait for it.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    try {
      const thread = await threadMode($)
      if (thread !== undefined) $.ui.status(await threadStatusText($, thread))
      else if (e.surface !== 'mobile') await offerPane($)
    } catch (err) {
      $.ui.log(`session.attach: ${errText(err)}`, { to: 'debug' })
    }
    return attached
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'foreman' }, async ($, e) => {
    const thread = await threadMode($).catch(() => undefined)
    if (thread !== undefined) return { text: `This session is the foreman thread ${thread}: /foreman runs in the chat that coordinates it.` }
    try {
      return { text: await dispatch($, e.args ?? '') }
    } catch (err) {
      // a command never fails silently: say what broke (review C-12)
      return { text: `/foreman ${(e.args ?? '').trim()} failed: ${errText(err)}` }
    }
  })

  // The model's tools (M2): each answers with text the model relays. foreman_go asks the person itself.
  on('tool.call', { tool: 'mcp__foreman__status' }, async $ => toolAnswer($, 'status', async () => `${await status($)}\n\n${await statusAdvice($)}`))
  on('tool.call', { tool: 'mcp__foreman__go' }, async ($, e) => toolAnswer($, 'go', async () => {
    const args = goArgs(e as unknown as Record<string, unknown>)
    return typeof args === 'string' ? goCommand($, args, 'tool') : args.error
  }))
  on('tool.call', { tool: 'mcp__foreman__reply' }, async ($, e) => toolAnswer($, 'reply', () => replyTool($, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: 'mcp__foreman__open' }, async ($, e) => toolAnswer($, 'open', () => openTool($, e as unknown as Record<string, unknown>)))
  on('tool.call', { tool: 'mcp__foreman__setup' }, async ($, e) => toolAnswer($, 'setup', () => setupCommand($, (e as unknown as { show?: unknown }).show === true ? 'setup --show' : 'setup')))

  // the short session section of the system prompt (plan §3)
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = await sessionSection($).catch(() => undefined)
    return text ? { ...composed, sections: [...composed.sections, { id: 'foreman:session', text, scope: 'session' as const }] } : composed
  }).catch(($, e, next) => next(e))

  // The one tool.call hook (the engine takes one without a matcher per module): the profile's guards
  // (plan §8, D-78), in foreman's threads by default, in every session that loads foreman with
  // `"scope": "everywhere"`. `warn` lets the call run and tells the model (a note it reads) and the
  // person (a toast); `deny` refuses it. The tools a session called are kept for `requireToolCalledBefore`.
  on('tool.call', async ($, e, next) => {
    const raw = e as unknown as Record<string, unknown>
    const { work } = await roots($)
    const parsed = await loadProfile($, work)
    const inThread = (await threadMode($)) !== undefined
    // a profile that declared guards and can no longer be read is not a profile without guards (P5-02)
    if (parsed.unusable && (guardsActive || (parsed.guardsNamed && (inThread || guardsScope === 'everywhere')))) {
      return { deny: `foreman guard: ${PROFILE_PATH} cannot be read or parsed (${parsed.warnings[0] ?? '?'}), and it declared guards; fix it to go on` }
    }
    const { scope, rules } = parsed.profile.guards
    if (!parsed.unusable) guardsScope = scope
    const acts = rules.length > 0 && (scope === 'everywhere' || inThread)
    if (!parsed.unusable) guardsActive = acts
    const call = callOf(String(e.tool), raw)
    if (acts) {
      const verdict = evaluateGuards(rules, call, new Set(await read($, calledTools)), work)
      if (verdict.deny !== undefined) return { deny: `foreman guard: ${verdict.deny}` }
      for (const w of verdict.warns) {
        $.ui.toast(`guard: ${w}`)
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `foreman guard (warning from this repo's profile): ${w}` }] }, ...(e.agentId ? { agentId: e.agentId } : {}) }).catch(() => undefined)
      }
    }
    const out = await next(e)
    if (acts && !('deny' in out && out.deny !== undefined)) await update($, calledTools, list => (list.includes(call.tool) ? list : [...list, call.tool].slice(-500)))
    return out
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // refused when the profile's guards act in this session, else there is nothing to guard
    return guardsActive ? { deny: 'foreman guard: the guards of this repo could not check this call, so it is refused' } : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = {
      view: await read($, view),
      threads: await read($, threads),
      cycles: await read($, cycles),
      plans: await read($, plans),
      warnings: await read($, warnings),
      notices: await read($, notices),
      ui: await read($, paneUi),
      now: await $.clock.now(),
    }
    // the closures are the fallback: presses and Sends are answered by key in the ui.press and ui.input hooks below
    return paneTree($.ui.resolve(e), data, {
      press: key => void panePress($, key, e.surface),
      reply: (key, text) => void paneInput($, key, text),
    })
  })

  on('ui.press', { component: 'Pane', requestId: 'foreman' }, async ($, e, next) => {
    return (await panePress($, e.element, e.surface)) ? { element: e.element } : next(e)
  }).catch(($, e, next) => next(e))

  // Send in "Needs you": answered by the field's key, so a Send after a redraw still reaches its thread
  on('ui.input', { component: 'Pane', requestId: 'foreman' }, async ($, e, next) => {
    if (e.kind !== 'submit' || replyThread(e.element) === undefined) return next(e)
    await paneInput($, e.element, e.value, e.surface)
    return { element: e.element, value: e.value }
  }).catch(($, e, next) => next(e))
}
