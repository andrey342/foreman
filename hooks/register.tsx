// foreman: coordinate long-running Claude Code work as background threads.
// Entry point: registers /foreman, the pane and the watcher. Every call on `$`
// lives in this file (the engine follows `$` only into functions declared
// here, D-11); hooks/lib and hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ForemanAgentRow, ForemanLevel, ForemanRole, ForemanThread, ForemanView } from '../types'
import { agentsArgv, isUnder, normPath, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs } from './lib/args'
import { EFFORTS, LEVELS, PROFILE_PATH, ROLES, initialProfile, isModel, isSafeId, parseProfile, roleAt } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { claudeExe, join } from './lib/repo'
import { TELL_SUFFIX, checkSkills, composeBrief, templateName } from './lib/roles'
import {
  busyIds, findThread, launchArgv, logsArgv, mergeThreads, parseLaunched, prune, resumeArgv, sendPlan, statusTable, stopArgv, syncThread, tailLines, threadName,
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

type RunDoc = { runId: string; updatedAt: string; threads: ForemanThread[]; transitions: { at: string; thread: string; from: string; to: string; note?: string }[] }

/**
 * Records the thread and a transition in <runsDir>/<runId>/foreman.json, when
 * it belongs to a run. A transition the file already ends with for that thread
 * is not written twice (two chats may see the same change). A file that does
 * not parse is kept aside as foreman.json.broken-<time> (D-27).
 */
async function recordRun($: EngineInterface, work: string, parsed: ParsedProfile, t: ForemanThread, from: string, note?: string): Promise<void> {
  if (!t.runId || !isSafeId(t.runId)) return
  const dir = join(work, `${parsed.profile.runsDir}/${t.runId}`)
  const path = `${dir}/foreman.json`
  try {
    if (await $.fs.exists(dir)) {
      const [real, base] = await Promise.all([$.fs.stat(dir, { resolve: true }), $.fs.stat(work, { resolve: true })])
      if (!real.realPath || !base.realPath || !isUnder(real.realPath, base.realPath)) {
        $.ui.log(`foreman: ${dir} resolves outside ${work}; the run file is not written`)
        return
      }
    }
    let doc: RunDoc = { runId: t.runId, updatedAt: t.updatedAt, threads: [], transitions: [] }
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path)
      try {
        const old = JSON.parse(text) as Partial<RunDoc>
        doc = { ...doc, ...old, threads: Array.isArray(old.threads) ? old.threads : [], transitions: Array.isArray(old.transitions) ? old.transitions : [] }
      } catch {
        const aside = `${path}.broken-${t.updatedAt.replace(/[:.]/g, '-')}`
        await $.fs.write(aside, text)
        $.ui.log(`foreman: ${path} did not parse; kept it as ${aside} and started a new one`)
      }
    }
    const { transcript: _t, usageSince: _u, usageLastId: _l, ...plain } = t
    doc.threads = [...doc.threads.filter(x => x.id !== t.id), plain]
    const last = [...doc.transitions].reverse().find(x => x.thread === t.id)
    if (!(last && last.from === from && last.to === t.state)) {
      doc.transitions = [...doc.transitions, { at: t.updatedAt, thread: t.id, from, to: t.state, ...(note ? { note } : {}) }]
    }
    doc.updatedAt = t.updatedAt
    await $.fs.write(path, JSON.stringify(doc, null, 2) + '\n')
  } catch (err) {
    $.ui.log(`foreman: could not write ${path}: ${errText(err)}`)
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
  sync($).catch(err => $.ui.log(`foreman: sync failed: ${errText(err)}`, { to: 'debug' }))
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
  const list = changed.length ? await putThreads($, repo, changed) : current
  for (const m of moved) {
    await recordRun($, work, parsed, m.t, m.from)
    if (parsed.profile.notify.toast) $.ui.toast(`${m.t.name} → ${m.t.state}${m.t.waitingFor ? ` (${m.t.waitingFor.slice(0, 80)})` : ''}`)
  }
  $.ui.status(threadStatus(list) ?? statusLine(mine))
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

  const { work, repo } = await roots($)
  const parsed = await loadProfile($, work)
  const p = parsed.profile
  const exe = claudeExe(parsed)
  const rows = repoRows(await listRows($, exe), repo, await $.clock.now())
  const known = await pullThreads($, repo)
  const busy = busyIds(known, rows)
  if (busy.length >= p.limits.maxParallelThreads) {
    const names = busy.map(id => known.find(t => t.id === id)?.name ?? rows.find(r => r.id === id)?.name ?? id)
    return `maxParallelThreads is ${p.limits.maxParallelThreads} and ${names.join(', ')} is still busy. Wait, /foreman stop it, or raise limits.maxParallelThreads in ${PROFILE_PATH}.`
  }
  const rc = roleAt(p, role, level)
  const skills = checkSkills(rc.skills, await knownSkills($))
  const template = (await readPrompt($, templateName(role))) ?? (await readPrompt($, 'free.md')) ?? '{{task}}'
  const common = [(await readPrompt($, '_rules.md')) ?? '', (await readPrompt($, '_result.md')) ?? '']
  const brief = composeBrief(template, common, p, role, { task, part, level, runId, skills: skills.kept })
  if (brief.length > BRIEF_MAX) return `The brief is ${brief.length} characters; Windows takes at most ${BRIEF_MAX} on one command line. Put the long part in a file and name the file in the task.`
  const name = threadName(runId, role, part)
  const argv = launchArgv({ exe, name, model: model ?? rc.model, effort: effort ?? rc.effort, permissionMode: rc.permissionMode, isolation: p.isolation, brief })
  const sentAt = new Date(await $.clock.now()).toISOString()
  const r = await $.process.run(argv, { cwd: work, timeoutMs: 60_000 })
  const launched = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
  if (!launched) return `claude --bg failed (exit ${r.exitCode}):\n${firstLine(r.stderr || r.stdout)}`
  const row = (await listRows($, exe).catch(() => [] as ForemanAgentRow[])).find(x => x.id === launched.id)
  const thread: ForemanThread = {
    id: launched.id,
    sessionId: row?.sessionId ?? '',
    name,
    role,
    ...(runId ? { runId } : {}),
    ...(part ? { part } : {}),
    cwd: work,
    model: model ?? rc.model,
    effort: effort ?? rc.effort,
    startedAt: sentAt,
    updatedAt: sentAt,
    sentAt,
    state: 'working',
  }
  await putThreads($, repo, [thread])
  await recordRun($, work, parsed, thread, 'none', 'launched')
  spawnSync($)
  const missing = skills.missing.length ? `\nSkills not found in this session, left out of the brief: ${skills.missing.join(', ')}.` : ''
  return `Launched ${name} as ${launched.id} (${thread.model}, effort ${thread.effort}, ${rc.permissionMode}). Watch it with \`claude attach ${launched.id}\` or /foreman open ${launched.id}.${missing}`
}

async function pick($: EngineInterface, repo: string, ref: string | undefined): Promise<ForemanThread | string> {
  const found = findThread(await pullThreads($, repo), ref)
  return 'error' in found ? found.error : found.thread
}

async function tell($: EngineInterface, args: string): Promise<string> {
  const { positional } = parseArgs(args)
  const { work, repo } = await roots($)
  const t = await pick($, repo, positional[1])
  if (typeof t === 'string') return t
  const text = positional.slice(2).join(' ').trim()
  if (!text) return 'Say what to send: /foreman tell <thread> "<message>"'
  const parsed = await loadProfile($, work)
  const exe = claudeExe(parsed)
  const row = (await listRows($, exe)).find(x => x.id === t.id)
  const plan = sendPlan(row)
  if ('refuse' in plan) return `Not sent: ${plan.refuse}.`
  const sessionId = t.sessionId || row?.sessionId
  if (!sessionId) return `Not sent: no session id known for ${t.id} yet; try again in a few seconds.`
  const message = `${text}\n\n${TELL_SUFFIX}`
  if (message.length > BRIEF_MAX) return `Not sent: the message is ${message.length} characters (at most ${BRIEF_MAX}); put it in a file and send its path.`
  const at = async () => new Date(await $.clock.now()).toISOString()
  if (plan.steps.includes('stop')) {
    const s = await $.process.run(stopArgv(exe, t.id), { timeoutMs: 30_000 })
    if (s.exitCode !== 0) return `Not sent: claude stop ${t.id} failed: ${firstLine(s.stderr || s.stdout)}`
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
    // the session was stopped (or had exited) and did not wake: say so in the registry too (review C-12)
    const stopped: ForemanThread = { ...t, sessionId, state: 'stopped', waitingFor: 'a message failed to resume it', updatedAt: await at() }
    await putThreads($, repo, [stopped])
    await recordRun($, work, parsed, stopped, t.state, 'resume failed')
    return `Not sent: ${failure}`
  }
  const next: ForemanThread = { ...t, sessionId, state: 'working', sentAt, updatedAt: sentAt }
  delete next.waitingFor
  delete next.noResult
  await putThreads($, repo, [next])
  await recordRun($, work, parsed, next, t.state, 'message sent')
  return `Sent to ${t.name} (${t.id}); it is working again.`
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

async function status($: EngineInterface): Promise<string> {
  await syncFresh($)
  return statusTable(await read($, threads), await $.clock.now())
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
    } catch (err) {
      $.ui.log(`foreman: could not restore the registry: ${errText(err)}`, { to: 'debug' })
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

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = { view: await read($, view), threads: await read($, threads), warnings: await read($, warnings) }
    return paneTree($.ui.resolve(e), data, { refresh: () => spawnSync($) })
  })
}
