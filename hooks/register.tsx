// foreman: run a plan's parts as background threads, each implemented, reviewed
// and applied until its review is OK, from one chat. Entry point: registers
// /foreman, the pane and the watcher. Every call on `$` lives in this file (the
// engine follows `$` only into functions declared here, D-11); hooks/lib and
// hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ForemanAgentRow, ForemanCycle, ForemanPlanRun, ForemanReview, ForemanRole, ForemanThread, ForemanView } from '../types'
import { agentsArgv, isUnder, normPath, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs, splitWords } from './lib/args'
import { applyMessage, bindRound, cycleId, isActive, moveTo, pendingRequest, stepCycle } from './lib/cycle'
import { detect } from './lib/detect'
import type { Detected } from './lib/detect'
import { freeSlug, parsePlan, pickParts, planPreview, planSlug } from './lib/plan'
import type { ParsedPlan, PlanPart } from './lib/plan'
import { EFFORTS, PROFILE_PATH, RETIRED_ROLES, ROLES, initialProfile, isModel, isSafeId, parseProfile, roleAt } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { join } from './lib/repo'
import { callOf, evaluateGuards, judge, placeable } from './lib/guards'
import { standing } from './lib/owner'
import { nextNumber, reviewSummary, settle } from './lib/reviews'
import { SUBAGENT_ROLES, TELL_SUFFIX, agentSpec, checkSkills, composeBrief, gateCommands, readBrief, templateName } from './lib/roles'
import { atPart, isPlanActive, partCycleId, pauseRun, progressMarkdown, resumeRun, runLine, stepPlan, stopRun } from './lib/run'
import { ADHOC, PLAN_FILES, briefFile, planDir, planFile, reviewFile, storageOf } from './lib/storage'
import type { Storage } from './lib/storage'
import {
  LIMIT_RESUME, busyIds, parseThreadName, findThread, launchArgv, logsArgv, mergeThreads, parseLaunched, prune, resumeArgv, sendPlan, statusTable, stopArgv, syncThread, tailLines, threadName,
} from './lib/threads'
import { DIRECT_READ_MAX, TAIL_BYTES, encodeCwd, projectsDir, readTranscript, sepOf, tailArgv, transcriptPath, zeroUsage } from './lib/transcript'
import type { TranscriptFacts } from './lib/transcript'
import { paneTree } from './ui/pane'

const PANE_ID = 'foreman'
const PANE_TITLE = 'foreman'
/** The store is read this often, so a second chat's pane shows what the first one launched (D-79). */
const WATCH_MS = 30_000
/** With nothing open, `claude agents` and the transcripts are looked at this often at most (D-79, A-05). */
const IDLE_LIST_MS = 5 * 60_000
/** Closed threads are dropped from the registry after this (D-27). */
const KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000
/** Windows refuses a command line past 32,767 characters; a message to a thread is one argument of it. */
const MESSAGE_MAX = 30_000

// The values kept in $.state (declared in types/index.d.ts).
const view = atom({ plugin: 'foreman', key: 'view' } as const, { root: '', rows: [], refreshedAt: 0 } as ForemanView)
const threads = atom({ plugin: 'foreman', key: 'threads' } as const, [] as ForemanThread[])
const warnings = atom({ plugin: 'foreman', key: 'warnings' } as const, [] as string[])
const reviews = atom({ plugin: 'foreman', key: 'reviews' } as const, [] as ForemanReview[])
const cycles = atom({ plugin: 'foreman', key: 'cycles' } as const, [] as ForemanCycle[])
const plans = atom({ plugin: 'foreman', key: 'plans' } as const, [] as ForemanPlanRun[])
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

// The plugin's own settings (plugin.json userConfig, /config): the commands foreman runs without anyone
// typing come from here, never from a repo's profile (review C-13, D-57). Set by register at every load.
let settings: { claudeExe: string; notifyCommand: string } = { claudeExe: '', notifyCommand: '' }

/** The `claude` command: the plugin setting, else `claude` from PATH (D-06). */
function claudeExe(): string {
  return settings.claudeExe || 'claude'
}

const HELP = [
  'Usage: /foreman [command]',
  '  (none)                                  open or close the foreman pane',
  '  go <plan.md> [--parts A,B] [--model m] [--yes]',
  '                                          run the plan\'s parts in order: each one implemented, reviewed and applied until OK',
  '  status                                  plans, threads, reviews',
  '  pause [plan] | resume [plan]            stop chaining the plan\'s parts, or go on (also past a pause the plan asks for)',
  '  review [--part A] [--base <ref>] [--run <id>]   a fresh read-only review of the diff',
  '  launch implementer "<task>"             one thread outside any plan',
  '  tell <thread> "<message>"               send a message to a thread (resumes it)',
  '  open <thread>                           how to watch a thread',
  '  log <thread> [n]                        last n lines of the thread\'s screen',
  '  stop <thread>                           stop a thread (its conversation is kept)',
  '  close <thread>                          mark a thread done and take it off the pane',
  '  init                                    write .claude/foreman.json with the gates found here, or check the one there',
  '  profile                                 show the profile in effect',
  '  help                                    this text',
  '<thread> is an id, a name, or a number from /foreman status.',
].join('\n')

/** 0.1 commands 0.2 dropped, and what to use instead (D-75, D-80). */
const RETIRED: Record<string, string> = {
  cycle: '/foreman cycle is now /foreman go <plan.md> [--parts A,B]: it runs the plan\'s parts in order, each until its review is OK.',
  night: 'Night mode is gone in 0.2: /foreman go chains the parts by itself, and a pause written in the plan stops before the next part (/foreman resume goes on).',
  critic: 'The critic is gone in 0.2: the review of each part checks it against the plan\'s acceptance criteria (/foreman review).',
}

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

/** The profile, read again only when the file's mtime or size changed (A-04). */
async function loadProfile($: EngineInterface, work: string): Promise<ParsedProfile> {
  const path = join(work, PROFILE_PATH)
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
    if (!(last && last.from === from && last.to === t.state)) {
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
  if (threadName0 === undefined) threadName0 = (await $.env.get('FOREMAN_THREAD')) ?? ''
  return threadName0 === '' ? undefined : threadName0
}

/**
 * The plugin's folder when foreman runs from a folder (`claude --plugin-dir`),
 * not from an installation under the configuration's plugins: then a thread is
 * launched with the same `--plugin-dir`, so the profile's guards act inside it.
 * An installed foreman loads in every session by itself.
 */
async function inlinePluginDir($: EngineInterface): Promise<string | undefined> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${((await homeDir($)) ?? '').replace(/[\\/]+$/, '')}/.claude`
  return isUnder($.plugin.root, `${configDir}/plugins`) ? undefined : $.plugin.root
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
    return `You are the foreman thread \`${name}\`${role ? ` (role ${role}${part ? `, part ${part}` : ''})` : ''}. End every turn with the foreman-result block.`
  }
  const open = (await read($, threads)).filter(t => !t.closed)
  const waiting = open.filter(t => ['waiting', 'blocked', 'failed', 'limit'].includes(t.state)).map(t => `${t.name} (${t.state})`)
  const active = (await read($, plans)).filter(isPlanActive).map(p => `${p.id} (${p.status}, part ${p.parts[p.current]?.id ?? '-'})`)
  if (waiting.length === 0 && active.length === 0) return undefined
  return [
    'foreman runs plans in this repo as background threads (/foreman status for details).',
    ...(active.length ? [`Active plans: ${active.join(', ')}.`] : []),
    ...(waiting.length ? [`Threads waiting for the person: ${waiting.join(', ')}.`] : []),
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
  for (const cwd of [row?.cwd, t.cwd]) {
    if (!cwd) continue
    const p = transcriptPath(projects, cwd, t.sessionId)
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
  const p = (await read($, plans)).some(isPlanActive)
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
    $.ui.status(statusLine((await read($, view)).rows) || undefined)
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
    const row = rows.find(r => r.id === t.id)
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
    // only the thread's owner says it moved: every chat of the repo sees the move (A-11)
    if (parsed.profile.notify.toast && m.t.owner === me) $.ui.toast(`${m.t.name} → ${m.t.state}${m.t.waitingFor ? ` (${m.t.waitingFor.slice(0, 80)})` : ''}`)
  }
  try {
    await retryLimits($, repo, rows, now)
    await advanceCycles($, repo, parsed, rows, nowIso)
    await advancePlans($, repo, parsed, rows)
  } catch (err) {
    $.ui.log(`the plan step failed: ${errText(err)}`)
  }
  const active = (await read($, plans)).filter(isPlanActive)
  const planPart = active.length ? `${active.length} plan${active.length > 1 ? 's' : ''}` : ''
  $.ui.status([threadStatus(await read($, threads)) ?? statusLine(mine), planPart].filter(Boolean).join(' · ') || undefined)
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

type LaunchOptions = {
  role: ForemanRole
  task: string
  runId: string
  part?: string
  plan?: string
  planPart?: PlanPart
  model?: string
  effort?: string
}

/**
 * Starts a background thread on a brief written to its run's folder (D-69):
 * the work behind /foreman launch and each part of a plan.
 */
async function launchThread($: EngineInterface, o: LaunchOptions): Promise<{ thread: ForemanThread; mode: string; missing: string[] } | { error: string }> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const rows = repoRows(await listRows($), repo, await $.clock.now())
  const known = await pullThreads($, repo)
  const busy = busyIds(known, rows)
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
  })
  const at = new Date(await $.clock.now()).toISOString()
  const briefPath = planFile(dir, briefFile(o.part ?? `t${at.replace(/\D/g, '').slice(0, 14)}`))
  await $.fs.write(briefPath, brief)
  const name = threadName(o.runId, o.role, o.part)
  const model = o.model ?? rc.model
  const effort = o.effort ?? rc.effort
  const pluginDir = await inlinePluginDir($)
  // isolation lands in Phase 4 (D-71): until then every thread works in this checkout
  const argv = launchArgv({ exe: claudeExe(), name, model, effort, permissionMode: rc.permissionMode, isolation: 'none', brief: readBrief(briefPath), ...(pluginDir ? { pluginDir } : {}) })
  const sentAt = new Date(await $.clock.now()).toISOString()
  const r = await $.process.run(argv, { cwd: work, timeoutMs: 60_000 })
  const launched = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
  if (!launched) return { error: `claude --bg failed (exit ${r.exitCode}):\n${firstLine(r.stderr || r.stdout)}` }
  const row = (await listRows($).catch(() => [] as ForemanAgentRow[])).find(x => x.id === launched.id)
  const thread: ForemanThread = {
    id: launched.id,
    sessionId: row?.sessionId ?? '',
    name,
    role: o.role,
    runId: o.runId,
    ...(o.part ? { part: o.part } : {}),
    cwd: work,
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

async function launch($: EngineInterface, args: string): Promise<string> {
  const { positional, flags } = parseArgs(args)
  const role = positional[1]
  const task = positional.slice(2).join(' ').trim()
  if ((RETIRED_ROLES as readonly string[]).includes(role ?? '')) return `The ${role} role was retired in 0.2. A plan's work: /foreman go <plan.md>; one task: /foreman launch implementer "<task>".`
  if (role !== 'implementer') return `${role && (ROLES as readonly string[]).includes(role) ? `The ${role} is not a thread: /foreman review starts a reviewer.` : 'Name the role: implementer.'}\n${HELP}`
  if (!task) return 'Say what the thread should do: /foreman launch implementer "<task>"'
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  if (flags.level !== undefined) return '--level is gone in 0.2: pass --model (opus, sonnet, haiku, fable).'
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const effort = str('effort')
  if (effort !== undefined && !EFFORTS.includes(effort as never)) return `--effort is one of ${EFFORTS.join(', ')}`
  const runId = str('run') ?? ADHOC
  if (!isSafeId(runId)) return '--run takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const part = str('part')
  if (part !== undefined && !isSafeId(part)) return '--part takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const out = await launchThread($, { role: 'implementer', task, runId, ...(part ? { part } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
  if ('error' in out) return out.error
  const t = out.thread
  const missing = out.missing.length ? `\nSkills not found in this session, left out of the brief: ${out.missing.join(', ')}.` : ''
  return `Launched ${t.name} as ${t.id} (${t.model}, effort ${t.effort}, ${out.mode}); its brief is ${t.brief}. Watch it with \`claude attach ${t.id}\` or /foreman open ${t.id}.${missing}`
}

async function pick($: EngineInterface, repo: string, ref: string | undefined): Promise<ForemanThread | string> {
  const found = findThread(await pullThreads($, repo), ref)
  return 'error' in found ? found.error : found.thread
}

/**
 * Sends `text` to a thread (stop if live, then `--bg --resume`, D-03): the work
 * behind /foreman tell, a cycle's apply and a usage-limit retry. A resume that
 * does not take leaves the thread `stopped` in the registry (review C-12).
 */
async function sendToThread($: EngineInterface, t: ForemanThread, text: string, note: string): Promise<{ thread: ForemanThread } | { error: string }> {
  const { repo } = await roots($)
  const exe = claudeExe()
  const row = (await listRows($)).find(x => x.id === t.id)
  const plan = sendPlan(row)
  if ('refuse' in plan) return { error: `Not sent: ${plan.refuse}.` }
  const sessionId = t.sessionId || row?.sessionId
  if (!sessionId) return { error: `Not sent: no session id known for ${t.id} yet; try again in a few seconds.` }
  const message = `${text}\n\n${TELL_SUFFIX}`
  if (message.length > MESSAGE_MAX) return { error: `Not sent: the message is ${message.length} characters (at most ${MESSAGE_MAX}); put it in a file and send its path.` }
  const at = async () => new Date(await $.clock.now()).toISOString()
  if (plan.steps.includes('stop')) {
    const s = await $.process.run(stopArgv(exe, t.id), { timeoutMs: 30_000 })
    if (s.exitCode !== 0) return { error: `Not sent: claude stop ${t.id} failed: ${firstLine(s.stderr || s.stdout)}` }
  }
  const sentAt = await at()
  let failure: string | undefined
  try {
    const r = await $.process.run(resumeArgv(exe, sessionId, message), { cwd: t.cwd, timeoutMs: 60_000 })
    const resumed = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
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
  await putThreads($, repo, [next])
  await recordRun($, next, t.state, note)
  return { thread: next }
}

async function tell($: EngineInterface, args: string): Promise<string> {
  const { positional } = parseArgs(args)
  const { repo } = await roots($)
  const t = await pick($, repo, positional[1])
  if (typeof t === 'string') return t
  const text = positional.slice(2).join(' ').trim()
  if (!text) return 'Say what to send: /foreman tell <thread> "<message>"'
  const out = await sendToThread($, t, text, 'message sent')
  return 'error' in out ? out.error : `Sent to ${t.name} (${t.id}); it is working again.`
}

async function openThread($: EngineInterface, args: string): Promise<string> {
  const t = await pick($, (await roots($)).repo, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const cmd = `claude attach ${t.id}`
  const copied = await $.ui.copy({ text: cmd }).catch(() => ({ isCopied: false }))
  const desktop = (await $.session.surfaces()).includes('desktop') && t.sessionId ? `\nIn the desktop app: \`claude --desktop --resume ${t.sessionId}\`` : ''
  return `Run in a terminal: \`${cmd}\`${copied.isCopied ? ' (copied)' : ''}${desktop}`
}

async function logThread($: EngineInterface, args: string): Promise<string> {
  const { positional } = parseArgs(args)
  const { repo } = await roots($)
  const t = await pick($, repo, positional[1])
  if (typeof t === 'string') return t
  const n = Math.min(200, Math.max(1, Number(positional[2] ?? 30) || 30))
  const r = await $.process.run(logsArgv(claudeExe(), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `No screen for ${t.id}: ${firstLine(r.stderr || r.stdout).slice(0, 300)}`
  return ['```', ...tailLines(r.stdout, n), '```'].join('\n')
}

async function stopThread($: EngineInterface, args: string): Promise<string> {
  const { repo } = await roots($)
  const t = await pick($, repo, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const r = await $.process.run(stopArgv(claudeExe(), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `claude stop ${t.id}: ${firstLine(r.stderr || r.stdout)}`
  const next: ForemanThread = { ...t, state: 'stopped', updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, repo, [next])
  await recordRun($, next, t.state, 'stopped by /foreman stop')
  return `Stopped ${t.name} (${t.id}). Its conversation is kept: /foreman tell ${t.id} "…" resumes it.`
}

async function closeThread($: EngineInterface, args: string): Promise<string> {
  const { repo } = await roots($)
  const t = await pick($, repo, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const next: ForemanThread = { ...t, state: 'done', closed: true, updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, repo, [next])
  await recordRun($, next, t.state, 'closed')
  return `Closed ${t.name} (${t.id}); the session itself is kept (\`claude rm ${t.id}\` deletes it).`
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

/**
 * Registers foreman:reviewer from prompts/agents/ and the profile. A spec the
 * engine refuses with skills (a name it does not know) is registered again
 * without them, and said (N-03).
 */
async function registerAgents($: EngineInterface, parsed: ParsedProfile): Promise<string[]> {
  const notes: string[] = []
  for (const role of SUBAGENT_ROLES) {
    const prompt = (await readPrompt($, `agents/${role}.md`)) ?? `You are foreman's ${role}.`
    try {
      await $.agent.register(agentSpec(role, prompt, parsed.profile, true))
    } catch (err) {
      try {
        await $.agent.register(agentSpec(role, prompt, parsed.profile, false))
        notes.push(`foreman:${role} registered without its skills (${errText(err)})`)
      } catch (err2) {
        notes.push(`foreman:${role} could not be registered: ${errText(err2)}`)
      }
    }
  }
  return notes
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

type ReviewOptions = { runId: string; part: string; base: string; plan?: string; model?: string; previous?: string }

/**
 * Starts a fresh reviewer on a run's part: the work behind /foreman review and
 * a cycle's review round. Its file goes to the run's folder (D-70). A spawn the
 * engine refuses is recorded as a settled review without a verdict, so a cycle
 * that asked for it sees the failure instead of asking again.
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
  // a number is taken by a file, and by a record whose reviewer wrote none (it stays noResult under it)
  const recorded = stored.filter(r => r.runId === runId && r.part === part).map(r => r.n)
  const n = Math.max(nextNumber(names, part), ...recorded.map(x => x + 1))
  const file = planFile(dir, reviewFile(part, n))
  const notes = await registerAgents($, parsed)
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
  })
  const startedAt = new Date(await $.clock.now()).toISOString()
  const owner = await $.session.id()
  const placeholder: ForemanReview = { kind: 'review', runId, part, n, file, agentId: '', owner, startedAt, verdict: 'none', findings: 0, base, ...(plan ? { plan } : {}) }
  // the run folder must exist before the reviewer writes into it: the guard resolves its real path
  await recordReview($, placeholder)
  const description = `foreman review ${part} r${n}`
  const spawned = await $.agent.spawn({ subagentType: 'foreman:reviewer', prompt: brief, description, model: o.model ?? rc.model, cwd: work })
  let agentId = spawned.deny === undefined ? spawned.agentId : undefined
  if (spawned.deny === undefined && !agentId) {
    // the id is core's to set; when an answer above it carries none, the agent list names the one just started
    const taken = new Set((await storedReviews($, repo)).map(r => r.agentId))
    agentId = [...(await $.agent.list().catch(() => []))].reverse().find(a => a.type === 'foreman:reviewer' && a.description === description && !taken.has(a.id))?.id
  }
  if (spawned.deny !== undefined || !agentId) {
    const failed: ForemanReview = { ...placeholder, agentId: `none-${startedAt}`, finishedAt: startedAt, settledBy: 'answer', noResult: true, reason: `the reviewer did not start: ${spawned.deny ?? 'no agent id'}` }
    await putReviews($, repo, [failed])
    await recordReview($, failed)
    return { error: `The reviewer did not start: ${spawned.deny ?? 'the engine returned no agent id'}.` }
  }
  const record: ForemanReview = { ...placeholder, agentId }
  await putReviews($, repo, [record])
  await recordReview($, record)
  return { review: record, model: spawned.model, notes }
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
  return `Started foreman:reviewer (${out.model}) on ${runId} part ${part}, diff ${base}..HEAD. It writes ${out.review.file}; its verdict lands here when it ends.${out.notes.length ? `\nNote: ${out.notes.join('; ')}.` : ''}`
}

/**
 * A review is settled from what it left: its file decides (the answer, when
 * there is one, is read too). `settledBy: 'file'` marks a settlement made
 * without the reviewer's answer, which that answer may still replace.
 */
async function settleFrom($: EngineInterface, r: ForemanReview, answer: string | undefined): Promise<ForemanReview> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const text = (await $.fs.exists(r.file)) ? await $.fs.read(r.file).catch(() => undefined) : undefined
  const settled = settle(text, answer ?? '')
  const done: ForemanReview = {
    ...r,
    verdict: settled.verdict,
    findings: settled.findings,
    settledBy: answer === undefined ? 'file' : 'answer',
    finishedAt: new Date(await $.clock.now()).toISOString(),
  }
  // what an earlier settlement from the file said gives way to this one
  delete done.noResult
  delete done.reason
  if (settled.noResult) done.noResult = true
  const reason = answer === undefined && settled.noResult ? `the reviewer ended before it answered; ${settled.reason ?? 'no verdict'}` : settled.reason
  if (reason) done.reason = reason
  await putReviews($, repo, [done])
  await recordReview($, done)
  const line = reviewSummary(done)
  $.ui.log(`${line}`)
  if (parsed.profile.notify.toast && r.owner === (await $.session.id())) $.ui.toast(line)
  return done
}

/** A reviewer foreman started has answered: settle its verdict from its file and its answer. */
async function settleReview($: EngineInterface, r: ForemanReview, answer: string): Promise<void> {
  await settleFrom($, r, answer)
  // a cycle waiting on this review moves now, not at the next tick
  spawnSync($, true)
}

/**
 * Reviews still waiting whose reviewer is gone: this session's whose agent it
 * no longer lists, and orphans (no owner, or an owner session that is no
 * longer alive). Another live session's reviews are its own (review C3-03).
 * Each is settled from its file: a verdict there stands.
 */
async function settleLost($: EngineInterface, repo: string): Promise<void> {
  const open = (await storedReviews($, repo)).filter(r => !r.finishedAt)
  if (open.length === 0) return
  const me = await $.session.id()
  const rows = await listRows($).catch(() => undefined)
  if (rows === undefined) return // nobody can tell who is alive: leave them be
  const live = new Set((await $.agent.list()).map(a => a.id))
  for (const r of open) {
    const s = standing(r.owner, me, rows)
    if (s === 'other') continue
    if (s === 'mine' && live.has(r.agentId)) continue
    await settleFrom($, r, undefined)
  }
}

// ---------------------------------------------------------------- the reviewer guard (C-17)

// Agent ids known not to be a foreman reviewer, so their calls skip the agent listing, and so the
// guard's .catch lets them through when the hook fails (review C3-04). A reload only means listing once more.
const otherAgents = new Set<string>()

/** The review a subagent's call belongs to, if the subagent is one foreman guards. */
async function guardedReview($: EngineInterface, agentId: string): Promise<ForemanReview | 'typed' | undefined> {
  if (otherAgents.has(agentId)) return undefined
  const mine = (await read($, reviews)).find(r => r.agentId === agentId)
  if (mine) return mine
  const info = (await $.agent.list()).find(a => a.id === agentId)
  // a foreman type spawned before its record landed, or by someone else: guarded, with no folder to write to
  if (info && SUBAGENT_ROLES.some(role => info.type === `foreman:${role}`)) return 'typed'
  // listed and not foreman's: someone else's. Not listed at all (a workflow's agents are not):
  // not guarded, but not trusted either, so the .catch refuses it should this hook fail
  if (info) otherAgents.add(agentId)
  return undefined
}

/** Where a Write lands, resolved: the file's real path, else its folder's plus the name; undefined when it cannot be placed. */
async function placedReal($: EngineInterface, path: string): Promise<string | undefined> {
  const p = placeable(path)
  if ('why' in p) return undefined
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (own) return own.realPath
  const dir = await $.fs.stat(p.folder, { resolve: true }).catch(() => undefined)
  return dir?.realPath === undefined ? undefined : `${dir.realPath.replace(/[\\/]+$/, '')}${sepOf(dir.realPath)}${p.name}`
}

/** Why the guarded reviewer's call is refused, or undefined to let it run: it writes only in its run's folder. */
async function guardVerdict($: EngineInterface, call: { tool: string; file_path?: unknown; command?: unknown }, r: ForemanReview | 'typed'): Promise<string | undefined> {
  const first = judge(call, [...SUBAGENT_TOOLS])
  if ('deny' in first) return first.deny
  if ('allow' in first) return undefined
  if (r === 'typed') return 'this reviewer has no review file foreman expects; it may not write'
  const runDir = r.file.replace(/[\\/][^\\/]*$/, '')
  const [target, dir] = await Promise.all([placedReal($, first.write), $.fs.stat(runDir, { resolve: true }).catch(() => undefined)])
  if (target === undefined || dir?.realPath === undefined) return `cannot place ${first.write}; a reviewer writes only under ${runDir}`
  return isUnder(target, dir.realPath) ? undefined : `a reviewer writes only in its run's folder (its file: ${r.file})`
}

/** The tools the reviewer guard lets a reviewer call (D-78: foreman's, not the profile's). */
const SUBAGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write'] as const

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

/**
 * A notice to the person: a toast, and the plugin setting `notifyCommand`, run
 * by argv with no shell, `{{message}}` replaced or the message appended, 15 s at
 * most (D-46). It comes from the plugin's settings, never from a repo (D-57).
 */
async function notify($: EngineInterface, parsed: ParsedProfile, text: string): Promise<void> {
  if (parsed.profile.notify.toast) $.ui.toast(text)
  $.ui.log(`${text}`)
  const command = settings.notifyCommand
  if (!command) return
  const words = splitWords(command)
  if (words.length === 0) return
  const argv = words.some(w => w.includes('{{message}}')) ? words.map(w => w.split('{{message}}').join(text)) : [...words, text]
  try {
    const { work } = await roots($)
    const r = await $.process.run(argv, { cwd: work, timeoutMs: 15_000 })
    if (r.exitCode !== 0) $.ui.log(`notifyCommand exited ${r.exitCode}: ${firstLine(r.stderr || r.stdout).slice(0, 200)}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`notifyCommand did not run: ${errText(err)}`, { to: 'debug' })
  }
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
async function beginPart($: EngineInterface, run: ForemanPlanRun, index: number, model?: string): Promise<{ cycle: ForemanCycle; thread: ForemanThread; run: ForemanPlanRun } | { error: string }> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const part = run.parts[index]
  if (!part) return { error: `${run.id} has no part ${index + 1}` }
  const id = partCycleId(run.id, part.id)
  const existing = (await putCycles($, repo, [])).find(c => c.id === id)
  if (existing) return { error: `part ${part.id} of ${run.id} has a cycle already (${existing.phase})` }
  const base = await headSha($, work)
  if (!base) return { error: `Cannot read HEAD in ${work}: a plan needs a git repository with a commit to review from.` }
  const pp = await planPartOf($, work, run.plan, part.id)
  const launched = await launchThread($, {
    role: 'implementer',
    task: `Implement part ${part.id} (${part.title}) of the plan \`${run.plan}\`.`,
    runId: run.id,
    part: part.id,
    plan: run.plan,
    ...(pp ? { planPart: pp } : {}),
    ...(model ? { model } : {}),
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
  return { cycle, thread: launched.thread, run: moved }
}

async function goCommand($: EngineInterface, args: string): Promise<string> {
  const { positional, flags } = parseArgs(args, ['yes'])
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const plan = positional[1]
  if (!plan) return 'Usage: /foreman go <plan.md> [--parts A,B] [--model m] [--yes]'
  if (flags.level !== undefined) return '--level is gone in 0.2: pass --model (opus, sonnet, haiku, fable).'
  if (flags.mode !== undefined && str('mode') !== 'auto') return '--mode review arrives with the supervisor; this version runs every plan in auto (parts chained, each stop waits for you).'
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
      : `Plan ${active.id} (${active.plan}) is active in this repo, and foreman runs one plan at a time: ${line}. Let it finish, or /foreman pause it and stop its thread.`
  }
  const preview = planPreview({ ...parsedPlan, parts: picked.parts })
  let note = ''
  if (!str('parts') && flags.yes !== true) {
    try {
      const answer = await $.ui.ask(`Run ${picked.parts.length} part(s) of ${plan} in order?\n${preview.map(l => `• ${l}`).join('\n')}`, ['Run them', 'Cancel'])
      if (answer !== 'Run them') return `Not started (${answer || 'cancelled'}). /foreman go ${plan} --parts <ids> runs the parts you name.`
    } catch {
      note = ' (Nobody to confirm with in this session: started as asked.)'
    }
  }
  const storage = await storageFor($, work, parsed)
  if (!storage) return 'No place for foreman\'s files: this folder is not in a git repository, and no home folder is known.'
  const taken = new Set([...(await $.fs.list(storage.base).catch(() => [])).map(e => e.name), ...(await read($, plans)).map(p => p.id)])
  const slug = freeSlug(planSlug(plan), taken)
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
  }
  await putPlans($, repo, [run])
  await recordPlan($, run, 'none', `${picked.parts.length} part(s): ${picked.parts.map(p => p.id).join(', ')}`)
  const started = await beginPart($, run, 0, model)
  if ('error' in started) {
    const stopped = stopRun(run, new Date(await $.clock.now()).toISOString(), `the first part did not start: ${started.error}`)
    await putPlans($, repo, [stopped])
    await recordPlan($, stopped, 'running@' + (run.parts[0]?.id ?? '-'))
    await writeProgress($, run.id)
    return `Plan ${slug} not started: ${started.error}`
  }
  const isolation = parsed.profile.isolation !== 'none' ? `\nNote: isolation "${parsed.profile.isolation}" arrives in a later version; this plan runs in this checkout.` : ''
  return [
    `Plan ${slug} started${note}: ${picked.parts.length} part(s), in order:`,
    ...preview.map(l => `  ${l}`),
    `Part ${picked.parts[0]?.id}: ${started.thread.name} (${started.thread.id}, ${started.thread.model}) from ${started.cycle.base.slice(0, 12)}; up to ${started.cycle.maxCycles} review round(s) per part.`,
    `Files: ${run.dir} (brief, progress.md, reviews, foreman.json). foreman reviews, applies and goes on to the next part by itself; it stops when a thread asks, blocks, or the rounds run out.${isolation}`,
  ].join('\n')
}

async function pauseOrResume($: EngineInterface, args: string, what: 'pause' | 'resume'): Promise<string> {
  const ref = parseArgs(args).positional[1]
  const { repo } = await roots($)
  const list = await putPlans($, repo, [])
  const run = ref ? list.find(p => p.id === ref || normPath(p.plan) === normPath(ref)) : list.find(isPlanActive)
  if (!run) return ref ? `No plan "${ref}" here.` : 'No active plan here.'
  const at = new Date(await $.clock.now()).toISOString()
  const from = `${run.status}@${run.parts[run.current]?.id ?? '-'}`
  if (what === 'pause') {
    if (run.status !== 'running') return `${run.id} is ${run.status}; nothing to pause.`
    const next = pauseRun(run, at, 'paused by the person; /foreman resume goes on')
    await putPlans($, repo, [next])
    await recordPlan($, next, from, 'paused')
    await writeProgress($, run.id)
    return `Paused ${run.id}: the part in progress goes on, the next one waits for /foreman resume ${run.id}.`
  }
  if (run.status !== 'paused') return `${run.id} is ${run.status}; nothing to resume.`
  const next = resumeRun(run, at)
  await putPlans($, repo, [next])
  await recordPlan($, next, from, 'resumed')
  await writeProgress($, run.id)
  spawnSync($, true)
  return `Resumed ${run.id}: ${runLine(next, await read($, cycles))}.`
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
    const step = stepCycle(c, { thread, review: last ? revs.find(r => r.agentId === last.agentId) : undefined, nowIso })
    c = step.cycle
    if (c !== c0) await putCycles($, repo, [c])
    if (step.moved) await recordCycle($, c, c0.phase)
    for (const eff of step.effects) if (eff.kind === 'notify') await notify($, parsed, eff.text)
    // reviewing with no round for the request yet: start the review (once: a bound round ends this)
    revs = await storedReviews($, repo)
    if (c.phase === 'reviewing' && c.reviewRequestedAt !== undefined && !pendingRequest(c, revs) && !requestBound(c, revs)) {
      const previous = c.rounds.at(-1)?.file
      const out = await spawnReview($, { runId: c.runId, part: c.part, base: c.base, plan: c.plan, ...(previous ? { previous } : {}) })
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
        await notify($, parsed, `${c.id}: waiting, ${c.reason}`)
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
          if (c.phase === 'waiting') await notify($, parsed, `${c.id}: waiting, ${c.reason}`)
        }
      }
    }
    if (c !== c0) await writeProgress($, c.runId)
  }
}

/** The cycle's last round is the review its current request started. */
function requestBound(c: ForemanCycle, revs: readonly ForemanReview[]): boolean {
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
      if (eff.kind === 'notify') await notify($, parsed, eff.text)
      if (eff.kind === 'start') {
        const next = run.parts[eff.index]
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
          await notify($, parsed, `${run.id}: paused, ${paused.reason}`)
        } else {
          run = out.run
          if (eff.index > 0) await notify($, parsed, `${run.id}: part ${next?.id} started (${out.thread.name})`)
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
async function paneAction($: EngineInterface, act: () => Promise<string>): Promise<void> {
  try {
    $.ui.toast((await act()).split('\n')[0] ?? '')
  } catch (err) {
    $.ui.toast(`failed: ${errText(err)}`)
  }
  spawnSync($, true)
}

async function paneOpen($: EngineInterface, id: string, surface: string): Promise<string> {
  const cmd = `claude attach ${id}`
  const copied = await $.ui.copy({ text: cmd, surface: surface as never }).catch(() => ({ isCopied: false }))
  return copied.isCopied ? `Copied: ${cmd}` : `Run in a terminal: ${cmd}`
}

async function paneReview($: EngineInterface, id: string): Promise<string> {
  const t = (await pullThreads($, (await roots($)).repo)).find(x => x.id === id)
  if (!t?.runId) return 'This thread belongs to no run: /foreman review --run <id> --part <part> --base <ref>'
  return startReview($, `review --run ${t.runId}${t.part ? ` --part ${t.part}` : ''}`)
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
  const table = statusTable(await read($, threads), now)
  const { repo } = await roots($)
  const cyc = (await read($, cycles)).filter(c => isActive(c) || Date.parse(c.updatedAt) > now - 86_400_000)
  const runs = (await read($, plans)).filter(p => isPlanActive(p) || Date.parse(p.updatedAt) > now - 86_400_000)
  const recent = (await storedReviews($, repo)).slice(-5)
  const lines = recent.map(r => (r.finishedAt ? `- ${reviewSummary(r)}` : `- Review ${r.part} r${r.n}: running (${r.agentId}), writes ${r.file}`))
  const parts = [table]
  if (runs.length) parts.push(`Plans:\n${runs.map(p => `- ${runLine(p, cyc)}`).join('\n')}`)
  if (cyc.length) parts.push(`Parts:\n${cyc.map(cycleLine).join('\n')}`)
  if (lines.length) parts.push(`Reviews:\n${lines.join('\n')}`)
  const legacy = await legacyNote($, repo)
  if (legacy) parts.push(legacy)
  return parts.join('\n\n')
}

async function init($: EngineInterface): Promise<string> {
  const { work } = await roots($)
  const path = join(work, PROFILE_PATH)
  if (await $.fs.exists(path)) {
    const parsed = await loadProfile($, work)
    await update($, warnings, () => parsed.warnings)
    return parsed.warnings.length === 0
      ? `${PROFILE_PATH} is valid.`
      : [`${PROFILE_PATH} has ${parsed.warnings.length} warning(s); each key falls back to its default:`, ...parsed.warnings.map(w => `  - ${w}`)].join('\n')
  }
  const found = await detectRepo($, work)
  await $.fs.write(path, JSON.stringify(initialProfile(gateCommands(parseProfile(undefined).profile, found.gates)), null, 2) + '\n')
  await update($, warnings, () => [])
  return `Wrote ${path}${found.gates.length ? ` with the gates found here: ${found.gates.join(', ')}` : ''}. Every key is optional; edit it or delete it to run on the defaults.`
}

async function showProfile($: EngineInterface): Promise<string> {
  const parsed = await loadProfile($, (await roots($)).work)
  const head = parsed.source === 'default' ? `No ${PROFILE_PATH}: running on the defaults.` : `Profile: defaults + ${PROFILE_PATH}.`
  const warn = parsed.warnings.length ? ['', 'Warnings:', ...parsed.warnings.map(w => `  - ${w}`)] : []
  return [head, ...warn, '', '```json', JSON.stringify(parsed.profile, null, 2), '```'].join('\n')
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
    case 'launch': return launch($, args)
    case 'tell': return tell($, args)
    case 'open': return openThread($, args)
    case 'log': return logThread($, args)
    case 'stop': return stopThread($, args)
    case 'close': return closeThread($, args)
    case 'init': return init($)
    case 'profile': return showProfile($)
    case 'help': return HELP
    default: return `Unknown command: ${sub}\n${HELP}`
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  settings = {
    claudeExe: typeof options.claudeExe === 'string' ? options.claudeExe.trim() : '',
    notifyCommand: typeof options.notifyCommand === 'string' ? options.notifyCommand.trim() : '',
  }
  guardsActive = false
  guardsScope = 'threads'
  otherAgents.clear()
  inflight = undefined
  listedAt = 0
  profileCache = undefined
  rootsCache = undefined
  gitDirCache.clear()
  threadName0 = undefined
  factsCache.clear()

  on('session.start', async ($, e, next) => {
    const thread = await threadMode($).catch(() => undefined)
    if (thread !== undefined) {
      // a foreman thread: its guards act on every call; the rest is the coordinating chat's (D-51)
      const started = await next(e)
      const n = await roots($).then(r => loadProfile($, r.work)).then(p => p.profile.guards.rules.length, () => 0)
      $.ui.status(n > 0 ? `thread ${thread}: the profile's guards are on (${n})` : `thread ${thread}: no guards in the profile`)
      return started
    }
    await $.command.register({
      name: 'foreman',
      description: 'Run a plan\'s parts as background threads, each implemented, reviewed and applied until OK',
      argumentHint: '[go <plan.md>|status|pause|resume|review|launch|tell|open|log|stop|close|init|profile|help]',
    })
    const started = await next(e)
    try {
      const { work, repo } = await roots($)
      const parsed = await loadProfile($, work)
      await update($, warnings, () => parsed.warnings)
      if (parsed.warnings.length) $.ui.toast(`${parsed.warnings.length} profile warning(s), see /foreman profile`)
      await pullThreads($, repo)
      const notes = await registerAgents($, parsed)
      for (const n of notes) $.ui.log(`${n}`, { to: 'debug' })
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

  // foreman's agent type is spawned by foreman alone, under its guard: hidden from the model
  on('agent.offer', { agent: 'foreman:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // a reviewer's answer: settle its verdict from the file it wrote
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      try {
        // pending, or settled from its file while this answer was on its way: the answer settles it
        const r = (await read($, reviews)).find(x => x.agentId === e.agentId && (!x.finishedAt || x.settledBy === 'file'))
        if (r) await settleReview($, r, e.answer)
      } catch (err) {
        $.ui.log(`could not settle the review of ${e.agentId}: ${errText(err)}`)
      }
    }
    return next(e)
  })

  // A reviewer's hand-back arrives as a peer prompt and would wake this chat's model for a turn per review
  // (seen live, 0.1 Phase 4). foreman settles the verdict from the file itself (plan D3: no model in the
  // coordinator), so the hand-back is held back; the person sees the drop's reason. Fails open (D-47).
  on('prompt.submit', async ($, e, next) => {
    const o = e.origin as { kind?: string; from?: string; senderTaskId?: string; handback?: boolean } | undefined
    if (o?.kind === 'peer' && o.handback === true) {
      const id = o.senderTaskId ?? o.from
      const r = id === undefined ? undefined : (await read($, reviews)).find(x => x.agentId === id)
      if (r) return { drop: `foreman settles review ${r.part} r${r.n} from its file (${r.file}); its hand-back is not sent to this chat's model.` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the short session section of the system prompt (plan §3)
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = await sessionSection($).catch(() => undefined)
    return text ? { ...composed, sections: [...composed.sections, { id: 'foreman:session', text, scope: 'session' as const }] } : composed
  }).catch(($, e, next) => next(e))

  // The one tool.call hook (the engine takes one without a matcher per module) holds both guards:
  // - the reviewer guard (C-17, D-40): only subagents foreman runs as reviewer are judged;
  // - the profile's guards (plan §8, D-78): in foreman's threads by default, in every session that
  //   loads foreman with `"scope": "everywhere"`. `warn` lets the call run and tells the model (a note it
  //   reads) and the person (a toast); `deny` refuses it. The tools a session called are kept for
  //   `requireToolCalledBefore`.
  on('tool.call', async ($, e, next) => {
    const raw = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) {
      const r = await guardedReview($, e.agentId)
      if (r !== undefined) {
        const why = await guardVerdict($, { tool: String(e.tool), file_path: raw.file_path, command: raw.command }, r)
        if (why !== undefined) return { deny: `foreman: ${why}` }
      }
    }
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
    // a call of a foreman reviewer, or of a subagent nobody could place, that could not be judged is refused (C3-04)
    if (e.agentId !== undefined && !otherAgents.has(e.agentId)) return { deny: 'foreman: the reviewer guard could not check this call, so it is refused' }
    // any other call: refused when the profile's guards act in this session, else there is nothing to guard
    return guardsActive ? { deny: 'foreman guard: the guards of this repo could not check this call, so it is refused' } : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = { view: await read($, view), threads: await read($, threads), reviews: await read($, reviews), cycles: await read($, cycles), plans: await read($, plans), warnings: await read($, warnings) }
    return paneTree($.ui.resolve(e), data, {
      refresh: () => spawnSync($, true),
      open: (id, surface) => void paneAction($, () => paneOpen($, id, surface)),
      review: id => void paneAction($, () => paneReview($, id)),
      reply: (id, text) => void paneAction($, () => paneReply($, id, text)),
    })
  })
}
