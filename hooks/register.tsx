// foreman: coordinate long-running Claude Code work as background threads.
// Entry point: registers /foreman, the pane and the watcher. Every call on `$`
// lives in this file (the engine follows `$` only into functions declared
// here, D-11); hooks/lib and hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ForemanAgentRow, ForemanCycle, ForemanLevel, ForemanReview, ForemanReviewKind, ForemanRole, ForemanThread, ForemanView } from '../types'
import { agentsArgv, isUnder, normPath, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs, splitWords } from './lib/args'
import { applyMessage, bindRound, cycleId, isActive, moveTo, nextPart, pendingRequest, stepCycle } from './lib/cycle'
import { EFFORTS, LEVELS, PROFILE_PATH, ROLES, initialProfile, isModel, isSafeId, parseProfile, roleAt } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { claudeExe, join } from './lib/repo'
import { judge, placeable } from './lib/guards'
import { standing } from './lib/owner'
import { nextNumber, reviewFileName, reviewSummary, settle } from './lib/reviews'
import { SUBAGENT_ROLES, TELL_SUFFIX, agentSpec, checkSkills, composeBrief, templateName } from './lib/roles'
import type { SubagentRole } from './lib/roles'
import {
  LIMIT_RESUME, busyIds, findThread, launchArgv, logsArgv, mergeThreads, parseLaunched, prune, resumeArgv, sendPlan, statusTable, stopArgv, syncThread, tailLines, threadName,
} from './lib/threads'
import { DIRECT_READ_MAX, TAIL_BYTES, encodeCwd, projectsDir, readTranscript, sepOf, tailArgv, transcriptPath } from './lib/transcript'
import type { TranscriptFacts } from './lib/transcript'
import { paneTree } from './ui/pane'

const PANE_ID = 'foreman'
const PANE_TITLE = 'foreman'
const WATCH_MS = 30_000
/** Closed threads are dropped from the registry after this (D-27). */
const KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000
/** Windows refuses a command line past 32,767 characters; the brief is one argument of it. */
const BRIEF_MAX = 30_000

// The values kept in $.state (declared in types/index.d.ts).
const view = atom({ plugin: 'foreman', key: 'view' } as const, { root: '', rows: [], refreshedAt: 0 } as ForemanView)
const threads = atom({ plugin: 'foreman', key: 'threads' } as const, [] as ForemanThread[])
const warnings = atom({ plugin: 'foreman', key: 'warnings' } as const, [] as string[])
const reviews = atom({ plugin: 'foreman', key: 'reviews' } as const, [] as ForemanReview[])
const cycles = atom({ plugin: 'foreman', key: 'cycles' } as const, [] as ForemanCycle[])

// The sync in flight, so a command waits for it instead of reading what it is about to replace (D-28).
// A module value: a reload loses it, which at worst lets two syncs overlap; the registry merge absorbs that.
let inflight: Promise<void> | undefined

const HELP = [
  'Usage: /foreman [command]',
  '  (none)                                  open or close the foreman pane',
  '  launch <role> "<task>" [--run <id>] [--part A] [--model m] [--effort e] [--level N1|N2|N3]',
  '                                          start a background thread with the role\'s brief',
  '  status                                  threads: role, state, since, tokens, next action',
  '  tell <thread> "<message>"               send a message to a thread (resumes it)',
  '  open <thread>                           print and copy `claude attach <id>`',
  '  log <thread> [n]                        last n lines of the thread\'s screen',
  '  stop <thread>                           stop a thread (its conversation is kept)',
  '  close <thread>                          mark a thread done and take it off the pane',
  '  review [--part A] [--base <ref>] [--run <id>] [--plan <md>]   fresh read-only reviewer: review-<part>-r<n>.md',
  '  critic [--part A] [--base <ref>] [--run <id>] [--plan <md>]   fresh acceptance critic: critic-<part>-r<n>.md',
  '  cycle <plan.md> --part A [--level N1|N2|N3] [--cycles 2] [--run <id>]   implement, review, apply until OK',
  '  night on|off|status                     chain parts, one more round, keep notices for later',
  '  init                                    write .claude/foreman.json, or check the one there',
  '  profile                                 show the profile in effect',
  '  help                                    this text',
  `Roles: ${ROLES.join(', ')}. <thread> is an id, a name, or a number from /foreman status.`,
].join('\n')

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const storeKey = (repo: string) => `threads:${normPath(repo)}`
const firstLine = (s: string) => s.trim().slice(0, 1500)

// ---------------------------------------------------------------- repo, profile

type Roots = { work: string; repo: string }

/**
 * `work`: where threads run and where the profile and runsDir are read, the
 * session's own checkout (a worktree's, when the session runs in one).
 * `repo`: the main working tree, which keys the registry and filters the pane,
 * so threads of every worktree of the repo show together (D-29).
 */
async function roots($: EngineInterface): Promise<Roots> {
  const sessionRoot = await $.session.root()
  const info = await $.session.repo()
  const repo = info?.root ?? sessionRoot
  const work = (await $.fs.exists(join(sessionRoot, '.git'))) ? sessionRoot : repo
  return { work, repo }
}

async function loadProfile($: EngineInterface, work: string): Promise<ParsedProfile> {
  const path = join(work, PROFILE_PATH)
  try {
    if (!(await $.fs.exists(path))) return parseProfile(undefined)
    return parseProfile(await $.fs.read(path))
  } catch (err) {
    const parsed = parseProfile(undefined)
    return { ...parsed, source: 'file', warnings: [`${PROFILE_PATH}: (file): cannot be read (${errText(err)}); using the defaults`] }
  }
}

async function listRows($: EngineInterface, exe: string): Promise<ForemanAgentRow[]> {
  return readAgents(await $.process.run(agentsArgv(exe), { timeoutMs: 30_000 }))
}

// ---------------------------------------------------------------- the registry

async function storedThreads($: EngineInterface, repo: string): Promise<ForemanThread[]> {
  const v = await $.store.get(storeKey(repo))
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
  await $.store.set(storeKey(repo), merged)
  await update($, threads, () => merged)
  return merged
}

/** Brings this session's copy up to the store: what other chats launched or saw happen. */
async function pullThreads($: EngineInterface, repo: string): Promise<ForemanThread[]> {
  const stored = await storedThreads($, repo)
  return update($, threads, cur => mergeThreads(cur, stored))
}

type RunDoc = {
  runId: string
  updatedAt: string
  threads: ForemanThread[]
  transitions: { at: string; thread: string; from: string; to: string; note?: string }[]
  reviews: ForemanReview[]
  cycles: ForemanCycle[]
}

/**
 * Reads <runsDir>/<runId>/foreman.json for an update, or a fresh one. A file
 * that does not parse is kept aside as foreman.json.broken-<time> (D-27). A run
 * folder that resolves outside the work root yields nothing: no write (C-04).
 */
async function openRunDoc($: EngineInterface, work: string, parsed: ParsedProfile, runId: string, at: string): Promise<{ path: string; doc: RunDoc } | undefined> {
  if (!isSafeId(runId)) return undefined
  const dir = join(work, `${parsed.profile.runsDir}/${runId}`)
  const path = `${dir}/foreman.json`
  if (await $.fs.exists(dir)) {
    const [real, base] = await Promise.all([$.fs.stat(dir, { resolve: true }), $.fs.stat(work, { resolve: true })])
    if (!real.realPath || !base.realPath || !isUnder(real.realPath, base.realPath)) {
      $.ui.log(`${dir} resolves outside ${work}; the run file is not written`)
      return undefined
    }
  }
  let doc: RunDoc = { runId, updatedAt: at, threads: [], transitions: [], reviews: [], cycles: [] }
  if (await $.fs.exists(path)) {
    const text = await $.fs.read(path)
    try {
      const old = JSON.parse(text) as Partial<RunDoc>
      doc = {
        ...doc,
        ...old,
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

/**
 * Records the thread and a transition in the run's foreman.json, when it
 * belongs to a run. A transition the file already ends with for that thread
 * is not written twice (two chats may see the same change).
 */
async function recordRun($: EngineInterface, work: string, parsed: ParsedProfile, t: ForemanThread, from: string, note?: string): Promise<void> {
  if (!t.runId) return
  try {
    const opened = await openRunDoc($, work, parsed, t.runId, t.updatedAt)
    if (!opened) return
    const { path, doc } = opened
    const { transcript: _t, usageSince: _u, usageLastId: _l, ...plain } = t
    doc.threads = [...doc.threads.filter(x => x.id !== t.id), plain]
    const last = [...doc.transitions].reverse().find(x => x.thread === t.id)
    if (!(last && last.from === from && last.to === t.state)) {
      doc.transitions = [...doc.transitions, { at: t.updatedAt, thread: t.id, from, to: t.state, ...(note ? { note } : {}) }]
    }
    doc.updatedAt = t.updatedAt
    await $.fs.write(path, JSON.stringify(doc, null, 2) + '\n')
  } catch (err) {
    $.ui.log(`could not record ${t.id} in run ${t.runId}: ${errText(err)}`)
  }
}

/** Records a review or critique, started or settled, in the run's foreman.json (plan Phase 3). */
async function recordReview($: EngineInterface, work: string, parsed: ParsedProfile, r: ForemanReview): Promise<void> {
  try {
    const at = r.finishedAt ?? r.startedAt
    const opened = await openRunDoc($, work, parsed, r.runId, at)
    if (!opened) return
    const { path, doc } = opened
    const same = (x: ForemanReview) => x.kind === r.kind && x.part === r.part && x.n === r.n
    doc.reviews = [...doc.reviews.filter(x => !same(x)), r].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    doc.updatedAt = at
    await $.fs.write(path, JSON.stringify(doc, null, 2) + '\n')
  } catch (err) {
    $.ui.log(`could not record ${r.kind} ${r.part} r${r.n} in run ${r.runId}: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------- transcripts

async function projectsRoot($: EngineInterface): Promise<string | undefined> {
  return projectsDir({
    claudeConfigDir: await $.env.get('CLAUDE_CONFIG_DIR'),
    home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  })
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

async function readFacts($: EngineInterface, path: string, t: ForemanThread): Promise<TranscriptFacts | undefined> {
  const opts = { since: t.usageSince, lastId: t.usageLastId }
  try {
    const { size } = await $.fs.stat(path)
    if (size <= DIRECT_READ_MAX) return readTranscript(await $.fs.read(path), { isTail: false, ...opts })
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const tail = tailArgv(path, TAIL_BYTES, isWindows)
    const r = await $.process.run(tail.argv, { timeoutMs: 30_000, ...(tail.env ? { env: tail.env } : {}) })
    if (r.exitCode !== 0) return undefined
    return readTranscript(r.stdout, { isTail: true, ...opts })
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- the watcher

/** One sync at a time: a caller while one runs gets that one (D-28). */
function sync($: EngineInterface): Promise<void> {
  if (!inflight) inflight = syncOnce($).finally(() => { inflight = undefined })
  return inflight
}

/** A sync that starts after now: waits for the one in flight, then runs another. */
async function syncFresh($: EngineInterface): Promise<void> {
  if (inflight) await inflight.catch(() => undefined)
  await sync($)
}

/** Starts a sync nobody awaits; a failure goes to the debug log, never unhandled. */
function spawnSync($: EngineInterface): void {
  sync($).catch(err => $.ui.log(`sync failed: ${errText(err)}`, { to: 'debug' }))
}

/** One look at every thread: `claude agents`, then each open thread's transcript. */
async function syncOnce($: EngineInterface): Promise<void> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  await update($, warnings, () => parsed.warnings)
  const now = await $.clock.now()
  let rows: ForemanAgentRow[]
  try {
    rows = await listRows($, claudeExe(parsed))
  } catch (err) {
    await update($, view, v => ({ ...v, root: repo, refreshedAt: now, error: `Could not list background sessions: ${errText(err)}` }))
    return
  }
  const mine = repoRows(rows, repo, now)
  await update($, view, () => ({ root: repo, rows: mine, refreshedAt: now }))
  const current = await pullThreads($, repo)
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
  const night = (await readNight($, repo)).on
  for (const m of moved) {
    await recordRun($, work, parsed, m.t, m.from)
    // in night mode the cycle's own notices say what matters; per-thread toasts would pile up
    if (parsed.profile.notify.toast && !night) $.ui.toast(`${m.t.name} → ${m.t.state}${m.t.waitingFor ? ` (${m.t.waitingFor.slice(0, 80)})` : ''}`)
  }
  try {
    await retryLimits($, repo, rows, now)
    await advanceCycles($, work, repo, parsed, rows, nowIso)
  } catch (err) {
    $.ui.log(`the cycle step failed: ${errText(err)}`)
  }
  const active = (await read($, cycles)).filter(isActive)
  const cyclePart = active.length ? `${active.length} cycle${active.length > 1 ? 's' : ''}` : ''
  $.ui.status([threadStatus(await read($, threads)) ?? statusLine(mine), cyclePart].filter(Boolean).join(' · ') || undefined)
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

// ---------------------------------------------------------------- commands

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

type LaunchOptions = { role: ForemanRole; task: string; runId?: string; part?: string; level?: ForemanLevel; model?: string; effort?: string; plan?: string }

/** Starts a background thread with the role's brief: the work behind /foreman launch and a cycle's implementer. */
async function launchThread($: EngineInterface, o: LaunchOptions): Promise<{ thread: ForemanThread; mode: string; missing: string[] } | { error: string }> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const exe = claudeExe(parsed)
  const rows = repoRows(await listRows($, exe), repo, await $.clock.now())
  const known = await pullThreads($, repo)
  const busy = busyIds(known, rows)
  if (busy.length >= p.limits.maxParallelThreads) {
    const names = busy.map(id => known.find(t => t.id === id)?.name ?? rows.find(r => r.id === id)?.name ?? id)
    return { error: `maxParallelThreads is ${p.limits.maxParallelThreads} and ${names.join(', ')} is still busy. Wait, /foreman stop it, or raise limits.maxParallelThreads in ${PROFILE_PATH}.` }
  }
  const rc = roleAt(p, o.role, o.level)
  const skills = checkSkills(rc.skills, await knownSkills($))
  const template = (await readPrompt($, templateName(o.role))) ?? (await readPrompt($, 'free.md')) ?? '{{task}}'
  const common = [(await readPrompt($, '_rules.md')) ?? '', (await readPrompt($, '_result.md')) ?? '']
  const brief = composeBrief(template, common, p, o.role, { task: o.task, part: o.part, level: o.level, runId: o.runId, skills: skills.kept, ...(o.plan ? { plan: o.plan } : {}) })
  if (brief.length > BRIEF_MAX) return { error: `The brief is ${brief.length} characters; Windows takes at most ${BRIEF_MAX} on one command line. Put the long part in a file and name the file in the task.` }
  const name = threadName(o.runId, o.role, o.part)
  const model = o.model ?? rc.model
  const effort = o.effort ?? rc.effort
  const argv = launchArgv({ exe, name, model, effort, permissionMode: rc.permissionMode, isolation: p.isolation, brief })
  const sentAt = new Date(await $.clock.now()).toISOString()
  const r = await $.process.run(argv, { cwd: work, timeoutMs: 60_000 })
  const launched = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
  if (!launched) return { error: `claude --bg failed (exit ${r.exitCode}):\n${firstLine(r.stderr || r.stdout)}` }
  const row = (await listRows($, exe).catch(() => [] as ForemanAgentRow[])).find(x => x.id === launched.id)
  const thread: ForemanThread = {
    id: launched.id,
    sessionId: row?.sessionId ?? '',
    name,
    role: o.role,
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.part ? { part: o.part } : {}),
    cwd: work,
    model,
    effort,
    startedAt: sentAt,
    updatedAt: sentAt,
    sentAt,
    owner: await $.session.id(),
    state: 'working',
  }
  await putThreads($, repo, [thread])
  await recordRun($, work, parsed, thread, 'none', 'launched')
  spawnSync($)
  return { thread, mode: rc.permissionMode, missing: skills.missing }
}

async function launch($: EngineInterface, args: string): Promise<string> {
  const { positional, flags } = parseArgs(args)
  const role = positional[1] as ForemanRole | undefined
  const task = positional.slice(2).join(' ').trim()
  if (!role || !ROLES.includes(role)) return `Name a role: ${ROLES.join(', ')}.\n${HELP}`
  if (!task) return 'Say what the thread should do: /foreman launch <role> "<task>"'
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const level = str('level') as ForemanLevel | undefined
  if (level !== undefined && !LEVELS.includes(level)) return `--level is one of ${LEVELS.join(', ')}`
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const effort = str('effort')
  if (effort !== undefined && !EFFORTS.includes(effort as never)) return `--effort is one of ${EFFORTS.join(', ')}`
  const runId = str('run')
  if (runId !== undefined && !isSafeId(runId)) return '--run takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const part = str('part')
  if (part !== undefined && !isSafeId(part)) return '--part takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const out = await launchThread($, { role, task, runId, part, level, model, effort })
  if ('error' in out) return out.error
  const t = out.thread
  const missing = out.missing.length ? `\nSkills not found in this session, left out of the brief: ${out.missing.join(', ')}.` : ''
  return `Launched ${t.name} as ${t.id} (${t.model}, effort ${t.effort}, ${out.mode}). Watch it with \`claude attach ${t.id}\` or /foreman open ${t.id}.${missing}`
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
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const exe = claudeExe(parsed)
  const row = (await listRows($, exe)).find(x => x.id === t.id)
  const plan = sendPlan(row)
  if ('refuse' in plan) return { error: `Not sent: ${plan.refuse}.` }
  const sessionId = t.sessionId || row?.sessionId
  if (!sessionId) return { error: `Not sent: no session id known for ${t.id} yet; try again in a few seconds.` }
  const message = `${text}\n\n${TELL_SUFFIX}`
  if (message.length > BRIEF_MAX) return { error: `Not sent: the message is ${message.length} characters (at most ${BRIEF_MAX}); put it in a file and send its path.` }
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
    await recordRun($, work, parsed, stopped, t.state, `resume failed (${note})`)
    return { error: `Not sent: ${failure}` }
  }
  const next: ForemanThread = { ...t, sessionId, state: 'working', sentAt, updatedAt: sentAt, owner: await $.session.id() }
  delete next.waitingFor
  delete next.noResult
  delete next.retryAt
  await putThreads($, repo, [next])
  await recordRun($, work, parsed, next, t.state, note)
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
  const { work, repo } = await roots($)
  const t = await pick($, repo, positional[1])
  if (typeof t === 'string') return t
  const n = Math.min(200, Math.max(1, Number(positional[2] ?? 30) || 30))
  const parsed = await loadProfile($, work)
  const r = await $.process.run(logsArgv(claudeExe(parsed), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `No screen for ${t.id}: ${firstLine(r.stderr || r.stdout).slice(0, 300)}`
  return ['```', ...tailLines(r.stdout, n), '```'].join('\n')
}

async function stopThread($: EngineInterface, args: string): Promise<string> {
  const { work, repo } = await roots($)
  const t = await pick($, repo, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const parsed = await loadProfile($, work)
  const r = await $.process.run(stopArgv(claudeExe(parsed), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `claude stop ${t.id}: ${firstLine(r.stderr || r.stdout)}`
  const next: ForemanThread = { ...t, state: 'stopped', updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, repo, [next])
  await recordRun($, work, parsed, next, t.state, 'stopped by /foreman stop')
  return `Stopped ${t.name} (${t.id}). Its conversation is kept: /foreman tell ${t.id} "…" resumes it.`
}

async function closeThread($: EngineInterface, args: string): Promise<string> {
  const { work, repo } = await roots($)
  const t = await pick($, repo, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const parsed = await loadProfile($, work)
  const next: ForemanThread = { ...t, state: 'done', closed: true, updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, repo, [next])
  await recordRun($, work, parsed, next, t.state, 'closed')
  return `Closed ${t.name} (${t.id}); the session itself is kept (\`claude rm ${t.id}\` deletes it).`
}

// ---------------------------------------------------------------- reviews and critiques (plan D2, Phase 3)

const reviewsKey = (repo: string) => `reviews:${normPath(repo)}`

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
  await $.store.set(reviewsKey(repo), list)
  await update($, reviews, () => list)
  return list
}

/**
 * Registers foreman:reviewer and foreman:critic from prompts/agents/ and the
 * profile. A spec the engine refuses with skills (a name it does not know) is
 * registered again without them, and said (N-03: skills only the model can
 * invoke may not be listed as commands, so they are passed here as given).
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

type ReviewOptions = { kind: ForemanReviewKind; runId: string; part: string; base: string; plan?: string; model?: string; previous?: string }

/**
 * Starts a fresh reviewer or critic on a run part: the work behind /foreman
 * review and /foreman critic, and a cycle's review round. A spawn the engine
 * refuses is recorded as a settled review without a verdict, so a cycle that
 * asked for it sees the failure instead of asking again.
 */
async function spawnReview($: EngineInterface, o: ReviewOptions): Promise<{ review: ForemanReview; model: string; notes: string[] } | { error: string }> {
  const { kind, runId, part, base, plan } = o
  const role: SubagentRole = kind === 'review' ? 'reviewer' : 'critic'
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const stored = await storedReviews($, repo)
  const pending = stored.find(r => !r.finishedAt && r.kind === kind && r.runId === runId && r.part === part)
  if (pending) return { error: `A ${kind} of ${runId} part ${part} is still running (r${pending.n}, ${pending.agentId}).` }
  const runRel = `${p.runsDir}/${runId}`
  const names = (await $.fs.list(join(work, runRel)).catch(() => [])).map(e => e.name)
  // a number is taken by a file, and by a record whose subagent wrote none (it stays noResult under it)
  const recorded = stored.filter(r => r.kind === kind && r.runId === runId && r.part === part).map(r => r.n)
  const n = Math.max(nextNumber(names, kind, part), ...recorded.map(x => x + 1))
  const file = `${runRel}/${reviewFileName(kind, part, n)}`
  const sep = sepOf(work)
  const fileAbs = `${work.replace(/[\\/]+$/, '')}${sep}${file.split('/').join(sep)}`
  const notes = await registerAgents($, parsed)
  const rc = roleAt(p, role)
  const skills = checkSkills(rc.skills, await knownSkills($))
  if (skills.missing.length) notes.push(`skills not found in this session, left out of the brief: ${skills.missing.join(', ')}`)
  const template = (await readPrompt($, `${kind === 'review' ? 'reviewer' : 'critic'}.md`)) ?? '{{task}}'
  const brief = composeBrief(template, [], p, role, { task: '', part, runId, base, reviewFile: fileAbs, skills: skills.kept, ...(plan ? { plan } : {}), ...(o.previous ? { previous: o.previous } : {}) })
  const startedAt = new Date(await $.clock.now()).toISOString()
  const owner = await $.session.id()
  const placeholder: ForemanReview = { kind, runId, part, n, file, agentId: '', owner, startedAt, verdict: 'none', findings: 0, base, ...(plan ? { plan } : {}) }
  // the run folder must exist before the subagent writes into it: the guard resolves its real path
  await recordReview($, work, parsed, placeholder)
  const description = `foreman ${kind} ${part} r${n}`
  const spawned = await $.agent.spawn({ subagentType: `foreman:${role}`, prompt: brief, description, model: o.model ?? rc.model, cwd: work })
  let agentId = spawned.deny === undefined ? spawned.agentId : undefined
  if (spawned.deny === undefined && !agentId) {
    // the id is core's to set; when an answer above it carries none, the agent list names the one just started
    const taken = new Set((await storedReviews($, repo)).map(r => r.agentId))
    agentId = [...(await $.agent.list().catch(() => []))].reverse().find(a => a.type === `foreman:${role}` && a.description === description && !taken.has(a.id))?.id
  }
  if (spawned.deny !== undefined || !agentId) {
    const failed: ForemanReview = { ...placeholder, agentId: `none-${startedAt}`, finishedAt: startedAt, settledBy: 'answer', noResult: true, reason: `the subagent did not start: ${spawned.deny ?? 'no agent id'}` }
    await putReviews($, repo, [failed])
    await recordReview($, work, parsed, failed)
    return { error: `The ${role} did not start: ${spawned.deny ?? 'the engine returned no agent id'}.` }
  }
  const record: ForemanReview = { ...placeholder, agentId }
  await putReviews($, repo, [record])
  await recordReview($, work, parsed, record)
  return { review: record, model: spawned.model, notes }
}

async function startReview($: EngineInterface, kind: ForemanReviewKind, args: string): Promise<string> {
  const { flags } = parseArgs(args)
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const { work, repo } = await roots($)
  const known = await pullThreads($, repo)
  const latest = [...known].reverse().find(t => t.runId !== undefined && (str('run') === undefined || t.runId === str('run')))
  const runId = str('run') ?? latest?.runId ?? 'adhoc'
  const part = str('part') ?? latest?.part ?? 'A'
  if (!isSafeId(runId)) return '--run takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  if (!isSafeId(part)) return '--part takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const plan = str('plan')
  if (plan !== undefined && !(await $.fs.exists(join(work, plan)))) return `--plan ${plan}: no such file under ${work}`
  const base = str('base') ?? (await defaultBase($, work))
  if (base === undefined) return 'No base to diff from: pass --base <ref> (the branch or commit the work started from).'
  if (!REF_RE.test(base)) return `--base ${base} is not a git ref foreman passes on`
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const out = await spawnReview($, { kind, runId, part, base, ...(plan ? { plan } : {}), ...(model ? { model } : {}) })
  if ('error' in out) return out.error
  const role = kind === 'review' ? 'reviewer' : 'critic'
  return `Started foreman:${role} (${out.model}) on ${runId} part ${part}, diff ${base}..HEAD. It writes ${out.review.file}; its verdict lands here when it ends.${out.notes.length ? `\nNote: ${out.notes.join('; ')}.` : ''}`
}

/**
 * A review is settled from what it left: its file decides (the answer, when
 * there is one, is read too). `settledBy: 'file'` marks a settlement made
 * without the subagent's answer, which that answer may still replace.
 */
async function settleFrom($: EngineInterface, r: ForemanReview, answer: string | undefined): Promise<ForemanReview> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const path = join(work, r.file)
  const text = (await $.fs.exists(path)) ? await $.fs.read(path).catch(() => undefined) : undefined
  const settled = settle(r.kind, text, answer ?? '')
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
  const reason = answer === undefined && settled.noResult ? `the subagent ended before it answered; ${settled.reason ?? 'no verdict'}` : settled.reason
  if (reason) done.reason = reason
  await putReviews($, repo, [done])
  await recordReview($, work, parsed, done)
  const line = reviewSummary(done)
  $.ui.log(`${line}`)
  if (parsed.profile.notify.toast) $.ui.toast(line)
  return done
}

/** A subagent foreman started has answered: settle its verdict from its file and its answer. */
async function settleReview($: EngineInterface, r: ForemanReview, answer: string): Promise<void> {
  await settleFrom($, r, answer)
  // a cycle waiting on this review moves now, not at the next tick
  spawnSync($)
}

/**
 * Reviews still waiting whose subagent is gone: this session's whose agent it
 * no longer lists, and orphans (no owner, or an owner session that is no
 * longer alive). Another live session's reviews are its own (review C3-03).
 * Each is settled from its file: a verdict there stands.
 */
async function settleLost($: EngineInterface, repo: string): Promise<void> {
  const open = (await storedReviews($, repo)).filter(r => !r.finishedAt)
  if (open.length === 0) return
  const me = await $.session.id()
  const parsed = await loadProfile($, (await roots($)).work)
  const rows = await listRows($, claudeExe(parsed)).catch(() => undefined)
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

// Agent ids known not to be a foreman reviewer or critic, so their calls skip
// the agent listing, and so the guard's .catch lets them through when the
// hook fails (review C3-04). A module value: a reload only means listing once more.
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

/** Why the guarded subagent's call is refused, or undefined to let it run. */
async function guardVerdict($: EngineInterface, call: { tool: string; file_path?: unknown; command?: unknown }, r: ForemanReview | 'typed'): Promise<string | undefined> {
  const { work } = await roots($)
  const parsed = await loadProfile($, work)
  const role: SubagentRole = r !== 'typed' && r.kind === 'critic' ? 'critic' : 'reviewer'
  const first = judge(call, roleAt(parsed.profile, role).tools ?? [])
  if ('deny' in first) return first.deny
  if ('allow' in first) return undefined
  if (r === 'typed') return 'this reviewer has no review file foreman expects; it may not write'
  const runDir = join(work, `${parsed.profile.runsDir}/${r.runId}`)
  const [target, dir] = await Promise.all([placedReal($, first.write), $.fs.stat(runDir, { resolve: true }).catch(() => undefined)])
  if (target === undefined || dir?.realPath === undefined) return `cannot place ${first.write}; a reviewer writes only under ${runDir}`
  return isUnder(target, dir.realPath) ? undefined : `a reviewer writes only under ${parsed.profile.runsDir}/${r.runId}/ (its file: ${r.file})`
}

// ---------------------------------------------------------------- the cycle (plan §5, Phase 4)

const cyclesKey = (repo: string) => `cycles:${normPath(repo)}`
const nightKey = (repo: string) => `night:${normPath(repo)}`

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
  await $.store.set(cyclesKey(repo), list)
  await update($, cycles, () => list)
  return list
}

/** Records the cycle and, when its phase moved, the transition in the run's foreman.json. */
async function recordCycle($: EngineInterface, work: string, parsed: ParsedProfile, c: ForemanCycle, from: string, note?: string): Promise<void> {
  try {
    const opened = await openRunDoc($, work, parsed, c.runId, c.updatedAt)
    if (!opened) return
    const { path, doc } = opened
    doc.cycles = [...doc.cycles.filter(x => x.id !== c.id), c]
    const key = `cycle:${c.part}`
    const last = [...doc.transitions].reverse().find(x => x.thread === key)
    if (from !== c.phase && !(last && last.from === from && last.to === c.phase && last.at === c.phaseAt)) {
      doc.transitions = [...doc.transitions, { at: c.phaseAt, thread: key, from, to: c.phase, ...(note ?? c.reason ? { note: note ?? c.reason } : {}) }]
    } else if (note && from === c.phase) {
      doc.transitions = [...doc.transitions, { at: c.updatedAt, thread: key, from, to: c.phase, note }]
    }
    doc.updatedAt = c.updatedAt
    await $.fs.write(path, JSON.stringify(doc, null, 2) + '\n')
  } catch (err) {
    $.ui.log(`could not record cycle ${c.id}: ${errText(err)}`)
  }
}

type Night = { on: boolean; since?: string; log: string[] }

async function readNight($: EngineInterface, repo: string): Promise<Night> {
  const v = (await $.store.get(nightKey(repo))) as Partial<Night> | undefined
  return { on: v?.on === true, ...(v?.since ? { since: v.since } : {}), log: Array.isArray(v?.log) ? v.log : [] }
}

/**
 * A notice to the person: a toast (held back in night mode, where it is kept
 * for `/foreman night off`), and the profile's `notify.command`, run by argv
 * with no shell, `{{message}}` replaced or the message appended, 15 s at most
 * (D-46; it is a command the repo's profile names, as `claudeExe`: D-23).
 */
async function notify($: EngineInterface, parsed: ParsedProfile, repo: string, text: string): Promise<void> {
  const night = await readNight($, repo)
  if (night.on) await $.store.set(nightKey(repo), { ...night, log: [...night.log, `${new Date(await $.clock.now()).toISOString()} ${text}`].slice(-200) })
  else if (parsed.profile.notify.toast) $.ui.toast(text)
  $.ui.log(`${text}`)
  const command = parsed.profile.notify.command
  if (!command) return
  const words = splitWords(command)
  if (words.length === 0) return
  const argv = words.some(w => w.includes('{{message}}')) ? words.map(w => w.split('{{message}}').join(text)) : [...words, text]
  try {
    const { work } = await roots($)
    const r = await $.process.run(argv, { cwd: work, timeoutMs: 15_000 })
    if (r.exitCode !== 0) $.ui.log(`notify.command exited ${r.exitCode}: ${firstLine(r.stderr || r.stdout).slice(0, 200)}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`notify.command did not run: ${errText(err)}`, { to: 'debug' })
  }
}

/** The commit the work starts from. */
async function headSha($: EngineInterface, work: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: work, timeoutMs: 15_000 }).catch(() => undefined)
  const sha = r?.stdout.trim()
  return r && r.exitCode === 0 && sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined
}

function slug(s: string): string {
  return s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan'
}

type CycleStart = { plan: string; part: string; level: ForemanLevel; runId: string; maxCycles: number; night: boolean; model?: string }

/** Starts a cycle: the implementer thread, and the record every chat of the repo sees. */
async function beginCycle($: EngineInterface, o: CycleStart): Promise<{ cycle: ForemanCycle; thread: ForemanThread } | { error: string }> {
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const active = (await putCycles($, repo, [])).find(c => c.runId === o.runId && isActive(c))
  if (active) return { error: `Run ${o.runId} has a cycle going (${active.id}, ${active.phase}); one cycle per run at a time.` }
  const base = await headSha($, work)
  if (!base) return { error: `Cannot read HEAD in ${work}: a cycle needs a git repository with a commit to review from.` }
  const launched = await launchThread($, {
    role: 'implementer',
    task: `Implement part ${o.part} of the plan \`${o.plan}\`, at level ${o.level}.`,
    runId: o.runId,
    part: o.part,
    level: o.level,
    plan: o.plan,
    ...(o.model ? { model: o.model } : {}),
  })
  if ('error' in launched) return launched
  const at = launched.thread.sentAt ?? launched.thread.startedAt
  const cycle: ForemanCycle = {
    id: cycleId(o.runId, o.part),
    runId: o.runId,
    part: o.part,
    plan: o.plan,
    level: o.level,
    base,
    implThread: launched.thread.id,
    maxCycles: o.maxCycles,
    rounds: [],
    phase: 'implementing',
    phaseAt: at,
    owner: await $.session.id(),
    ...(o.night ? { night: true } : {}),
    startedAt: at,
    updatedAt: at,
  }
  await putCycles($, repo, [cycle])
  await recordCycle($, work, parsed, cycle, 'none', `cycle started from ${base.slice(0, 12)}`)
  return { cycle, thread: launched.thread }
}

async function startCycle($: EngineInterface, args: string): Promise<string> {
  const { positional, flags } = parseArgs(args)
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const plan = positional[1]
  if (!plan) return 'Usage: /foreman cycle <plan.md> --part A [--level N1|N2|N3] [--cycles 2] [--run <id>] [--model m]'
  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  if (!(await $.fs.exists(join(work, plan)))) return `${plan}: no such file under ${work}`
  const part = str('part') ?? 'A'
  if (!isSafeId(part)) return '--part takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const level = (str('level') ?? 'N2') as ForemanLevel
  if (!LEVELS.includes(level)) return `--level is one of ${LEVELS.join(', ')}`
  const night = (await readNight($, repo)).on
  const asked = str('cycles')
  const maxCycles = asked !== undefined ? Number(asked) : parsed.profile.limits.maxReviewCycles + (night ? 1 : 0)
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 10) return '--cycles is a whole number from 1 to 10'
  const model = str('model')
  if (model !== undefined && !isModel(model)) return `--model ${model} is not a model (opus, sonnet, haiku, fable or a claude-* id)`
  const today = new Date(await $.clock.now()).toISOString().slice(0, 10).replace(/-/g, '')
  const runId = str('run') ?? `${today}-${slug(plan.split(/[\\/]/).pop() ?? plan)}`
  if (!isSafeId(runId)) return '--run takes a letter or digit, then letters, digits, ., _ and - (no "..", at most 64)'
  const out = await beginCycle($, { plan, part, level, runId, maxCycles, night, ...(model ? { model } : {}) })
  if ('error' in out) return out.error
  return `Cycle ${out.cycle.id} started: ${out.thread.name} (${out.thread.id}, ${out.thread.model}) implements part ${part} of ${plan} from ${out.cycle.base.slice(0, 12)}; up to ${maxCycles} review round(s)${night ? ', night mode' : ''}. foreman reviews, applies and reviews again on its own; it stops at ready, or waits for you when a thread asks, blocks or the rounds run out.`
}

/** Reads the plan for night mode: the part after this one, unless the plan pauses before it. */
async function chainTarget($: EngineInterface, work: string, c: ForemanCycle): Promise<string | undefined> {
  if (!c.night) return undefined
  const text = await $.fs.read(join(work, c.plan)).catch(() => undefined)
  return text === undefined ? undefined : nextPart(text, c.part)
}

/**
 * One look at every active cycle this session may drive. Only the owner acts
 * (owner.ts); an orphan is claimed first and driven from the next look, so two
 * chats that both adopt it settle on one before either acts. What each phase
 * needs done is derived from the record, not from the transition alone, so an
 * adoption or a reload finishes an effect the previous run left half done and
 * never repeats one already done (review N-02).
 */
async function advanceCycles($: EngineInterface, work: string, repo: string, parsed: ParsedProfile, rows: readonly ForemanAgentRow[], nowIso: string): Promise<void> {
  const me = await $.session.id()
  for (const c0 of (await putCycles($, repo, [])).filter(isActive)) {
    const s = standing(c0.owner, me, rows)
    if (s === 'other') continue
    if (s === 'orphan') {
      const claimed: ForemanCycle = { ...c0, owner: me, claimedAt: nowIso, updatedAt: nowIso }
      await putCycles($, repo, [claimed])
      await recordCycle($, work, parsed, claimed, c0.phase, `adopted by ${me.slice(0, 8)}`)
      continue
    }
    let c = c0
    let revs = await storedReviews($, repo)
    // a review the request already started (this run or the previous owner's): bind it, never start a second
    const found = pendingRequest(c, revs)
    if (found) c = bindRound(c, found, nowIso)
    const thread = (await read($, threads)).find(t => t.id === c.implThread)
    const last = c.rounds.at(-1)
    const step = stepCycle(c, { thread, review: last ? revs.find(r => r.agentId === last.agentId) : undefined, nowIso, nextPart: await chainTarget($, work, c) })
    c = step.cycle
    if (c !== c0) await putCycles($, repo, [c])
    if (step.moved) await recordCycle($, work, parsed, c, c0.phase)
    for (const eff of step.effects) {
      if (eff.kind === 'notify') await notify($, parsed, repo, eff.text)
      if (eff.kind === 'chain') {
        const exists = (await storedCycles($, repo)).some(x => x.id === cycleId(c.runId, eff.part))
        if (!exists) {
          const next = await beginCycle($, { plan: c.plan, part: eff.part, level: c.level, runId: c.runId, maxCycles: c.maxCycles, night: true })
          await notify($, parsed, repo, 'error' in next ? `${c.id}: night mode could not chain part ${eff.part}: ${next.error}` : `night mode: part ${eff.part} of ${c.plan} started (${next.cycle.id})`)
        }
      }
    }
    // reviewing with no round for the request yet: start the review (once: a bound round ends this)
    revs = await storedReviews($, repo)
    if (c.phase === 'reviewing' && c.reviewRequestedAt !== undefined && !pendingRequest(c, revs) && !requestBound(c, revs)) {
      const previous = c.rounds.at(-1)?.file
      const out = await spawnReview($, { kind: 'review', runId: c.runId, part: c.part, base: c.base, plan: c.plan, ...(previous ? { previous } : {}) })
      const settled = 'error' in out ? (await storedReviews($, repo)).find(r => r.runId === c.runId && r.part === c.part && Date.parse(r.startedAt) >= Date.parse(c.reviewRequestedAt as string)) : out.review
      if (settled) {
        c = bindRound(c, settled, new Date(await $.clock.now()).toISOString())
        await putCycles($, repo, [c])
        await recordCycle($, work, parsed, c, c.phase, `review r${settled.n} started`)
      } else if ('error' in out) {
        const from = c.phase
        c = moveTo(c, 'waiting', new Date(await $.clock.now()).toISOString(), { waitingOn: 'person', reason: `the review could not start: ${out.error}` })
        await putCycles($, repo, [c])
        await recordCycle($, work, parsed, c, from)
        await notify($, parsed, repo, `${c.id}: waiting, ${c.reason}`)
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
        await recordCycle($, work, parsed, c, from, `resume for review r${round.n} already sent`)
      } else if (round && t) {
        const sent = await sendToThread($, t, applyMessage(round), `apply review r${round.n}`)
        const from = c.phase
        if ('thread' in sent) c = moveTo(c, 'implementing', sent.thread.sentAt ?? at)
        else if (!/the thread is working/.test(sent.error)) c = moveTo(c, 'waiting', at, { waitingOn: 'person', reason: `could not resume the implementer: ${sent.error}` })
        if (c.phase !== from) {
          await putCycles($, repo, [c])
          await recordCycle($, work, parsed, c, from, 'thread' in sent ? `implementer resumed on ${round.file}` : undefined)
          if (c.phase === 'waiting') await notify($, parsed, repo, `${c.id}: waiting, ${c.reason}`)
        }
      }
    }
  }
}

/** The cycle's last round is the review its current request started. */
function requestBound(c: ForemanCycle, revs: readonly ForemanReview[]): boolean {
  const last = c.rounds.at(-1)
  const r = last ? revs.find(x => x.agentId === last.agentId) : undefined
  return r !== undefined && c.reviewRequestedAt !== undefined && Date.parse(r.startedAt) >= Date.parse(c.reviewRequestedAt)
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
  if (next !== undefined) $.clock.after(Math.min(next - now, 2 ** 31 - 1), () => spawnSync($))
}

async function nightCommand($: EngineInterface, args: string): Promise<string> {
  const sub = parseArgs(args).positional[1] ?? 'status'
  const { repo } = await roots($)
  const night = await readNight($, repo)
  const now = new Date(await $.clock.now()).toISOString()
  if (sub === 'on') {
    await $.store.set(nightKey(repo), { on: true, since: now, log: night.log })
    const active = (await putCycles($, repo, [])).filter(isActive).map(c => ({ ...c, night: true, maxCycles: c.night ? c.maxCycles : c.maxCycles + 1, updatedAt: now }))
    if (active.length) await putCycles($, repo, active)
    return `Night mode on: cycles get one more review round, a part that ends ready chains to the next unless the plan pauses before it, and notices are kept for /foreman night off. Closed stops (a question, a blocker, rounds used up) still stop.${active.length ? ` Applied to ${active.map(c => c.id).join(', ')}.` : ''}`
  }
  if (sub === 'off') {
    await $.store.set(nightKey(repo), { on: false, log: [] })
    const active = (await putCycles($, repo, [])).filter(c => isActive(c) && c.night).map(c => ({ ...c, night: false, updatedAt: now }))
    if (active.length) await putCycles($, repo, active)
    return ['Night mode off.', ...(night.log.length ? ['', 'While it was on:', ...night.log.map(l => `- ${l}`)] : ['Nothing happened while it was on.'])].join('\n')
  }
  return night.on ? `Night mode is on since ${night.since ?? '?'} (${night.log.length} notice(s) kept).` : 'Night mode is off.'
}

function cycleLine(c: ForemanCycle): string {
  const rounds = c.rounds.map(r => `r${r.n} ${r.verdict}`).join(', ') || 'no review yet'
  return `- Cycle ${c.id}: ${c.phase}${c.reason ? ` (${c.reason})` : ''} · ${rounds} · max ${c.maxCycles}${c.night ? ' · night' : ''}`
}

async function status($: EngineInterface): Promise<string> {
  await syncFresh($)
  const now = await $.clock.now()
  const table = statusTable(await read($, threads), now)
  const { repo } = await roots($)
  const cyc = (await putCycles($, repo, [])).filter(c => isActive(c) || Date.parse(c.updatedAt) > now - 86_400_000)
  const recent = (await storedReviews($, repo)).slice(-5)
  const lines = recent.map(r => (r.finishedAt ? `- ${reviewSummary(r)}` : `- ${r.kind === 'review' ? 'Review' : 'Critique'} ${r.part} r${r.n}: running (${r.agentId}), writes ${r.file}`))
  const parts = [table]
  if (cyc.length) parts.push(`Cycles:\n${cyc.map(cycleLine).join('\n')}`)
  if (lines.length) parts.push(`Reviews:\n${lines.join('\n')}`)
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
  const names = (await $.fs.list(work).catch(() => [])).map(entry => entry.name)
  const profile = initialProfile({
    hasPackageJson: names.includes('package.json'),
    slnFiles: names.filter(n => n.toLowerCase().endsWith('.sln')),
    hasPyproject: names.includes('pyproject.toml'),
  })
  await $.fs.write(path, JSON.stringify(profile, null, 2) + '\n')
  await update($, warnings, () => [])
  return `Wrote ${path}. Every key is optional; edit it or delete it to run on the defaults.`
}

async function showProfile($: EngineInterface): Promise<string> {
  const parsed = await loadProfile($, (await roots($)).work)
  const head = parsed.source === 'default' ? `No ${PROFILE_PATH}: running on the defaults.` : `Profile: defaults + ${PROFILE_PATH}.`
  const warn = parsed.warnings.length ? ['', 'Warnings:', ...parsed.warnings.map(w => `  - ${w}`)] : []
  return [head, ...warn, '', '```json', JSON.stringify(parsed.profile, null, 2), '```'].join('\n')
}

async function dispatch($: EngineInterface, args: string): Promise<string> {
  const sub = parseArgs(args).positional[0] ?? ''
  switch (sub) {
    case '': return togglePane($)
    case 'launch': return launch($, args)
    case 'status': return status($)
    case 'tell': return tell($, args)
    case 'open': return openThread($, args)
    case 'log': return logThread($, args)
    case 'stop': return stopThread($, args)
    case 'close': return closeThread($, args)
    case 'review': return startReview($, 'review', args)
    case 'critic': return startReview($, 'critic', args)
    case 'cycle': return startCycle($, args)
    case 'night': return nightCommand($, args)
    case 'init': return init($)
    case 'profile': return showProfile($)
    case 'help': return HELP
    default: return `Unknown command: ${sub}\n${HELP}`
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'foreman',
      description: 'Coordinate background threads: launch, status, tell, open, log, stop, close',
      argumentHint: '[launch|status|tell|open|log|stop|close|init|profile|help]',
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
      await scheduleRetries($, repo)
    } catch (err) {
      $.ui.log(`could not restore the registry: ${errText(err)}`, { to: 'debug' })
    }
    $.clock.every(WATCH_MS, () => spawnSync($))
    spawnSync($)
    return started
  })

  on('command.run', { command: 'foreman' }, async ($, e) => {
    try {
      return { text: await dispatch($, e.args) }
    } catch (err) {
      // a command never fails silently: say what broke (review C-12)
      return { text: `/foreman ${e.args.trim()} failed: ${errText(err)}` }
    }
  })

  // foreman's agent types are spawned by foreman alone, under its guard: hidden from the model
  on('agent.offer', { agent: 'foreman:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'foreman:critic' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // a review subagent's answer: settle its verdict from the file it wrote
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
  // (seen live, Phase 4). foreman settles the verdict from the file itself (plan D3: no model in the
  // coordinator), so the hand-back is held back; the person sees the drop's reason. Fails open (D-47).
  on('prompt.submit', async ($, e, next) => {
    const o = e.origin as { kind?: string; from?: string; senderTaskId?: string; handback?: boolean } | undefined
    if (o?.kind === 'peer' && o.handback === true) {
      const id = o.senderTaskId ?? o.from
      const r = id === undefined ? undefined : (await read($, reviews)).find(x => x.agentId === id)
      if (r) return { drop: `foreman settles ${r.kind === 'review' ? 'review' : 'critique'} ${r.part} r${r.n} from its file (${r.file}); its hand-back is not sent to this chat's model.` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the reviewer guard: only subagents foreman runs as reviewer or critic are judged
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const r = await guardedReview($, e.agentId)
    if (r === undefined) return next(e)
    const call = e as unknown as { tool: string; file_path?: unknown; command?: unknown }
    const why = await guardVerdict($, { tool: String(e.tool), file_path: call.file_path, command: call.command }, r)
    return why === undefined ? next(e) : { deny: `foreman: ${why}` }
  }).catch(($, e, next) => {
    // the main loop's calls are not this guard's, nor those of a subagent known to be someone else's;
    // a call of a foreman reviewer, or of an agent nobody could place, that it could not judge is refused
    if (e.agentId === undefined || otherAgents.has(e.agentId)) return next(e)
    return next.called ? next(e) : { deny: 'foreman: the reviewer guard could not check this call, so it is refused' }
  })

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = { view: await read($, view), threads: await read($, threads), reviews: await read($, reviews), cycles: await read($, cycles), warnings: await read($, warnings) }
    return paneTree($.ui.resolve(e), data, { refresh: () => spawnSync($) })
  })
}
