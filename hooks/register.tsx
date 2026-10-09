// foreman: coordinate long-running Claude Code work as background threads.
// Entry point: registers /foreman, the pane and the watcher. Every call on `$`
// lives in this file (the engine follows `$` only into functions declared
// here, D-11); hooks/lib and hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ForemanAgentRow, ForemanLevel, ForemanRole, ForemanThread, ForemanView } from '../types'
import { agentsArgv, normPath, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs } from './lib/args'
import { EFFORTS, LEVELS, PROFILE_PATH, ROLES, initialProfile, isModel, parseProfile, roleAt } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { claudeExe, join } from './lib/repo'
import { composeBrief, templateName } from './lib/roles'
import {
  busyThreads, findThread, launchArgv, logsArgv, parseLaunched, resumeArgv, sendPlan, statusTable, stopArgv, syncThread, tailLines, threadName,
} from './lib/threads'
import { DIRECT_READ_MAX, TAIL_BYTES, encodeCwd, parseResultFence, projectsDir, readTranscript, tailArgv, transcriptPath } from './lib/transcript'
import type { FenceRead, TranscriptFacts } from './lib/transcript'
import { paneTree } from './ui/pane'

const PANE_ID = 'foreman'
const PANE_TITLE = 'foreman'
const WATCH_MS = 30_000

// The values kept in $.state (declared in types/index.d.ts).
const view = atom({ plugin: 'foreman', key: 'view' } as const, { root: '', rows: [], refreshedAt: 0 } as ForemanView)
const threads = atom({ plugin: 'foreman', key: 'threads' } as const, [] as ForemanThread[])
const warnings = atom({ plugin: 'foreman', key: 'warnings' } as const, [] as string[])

// Module state: lost on reload, which only means one sync may overlap.
let syncing = false

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

/** Starts work nobody awaits; a failure goes to the debug log, never unhandled. */
function spawnSync($: EngineInterface): void {
  sync($).catch(err => $.ui.log(`foreman: sync failed: ${errText(err)}`, { to: 'debug' }))
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const storeKey = (root: string) => `threads:${normPath(root)}`

// ---------------------------------------------------------------- repo, profile

/** The git root of the session (the main working tree's for a worktree), else its cwd. */
async function repoRoot($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()
  return repo?.root ?? (await $.session.cwd())
}

async function loadProfile($: EngineInterface, root: string): Promise<ParsedProfile> {
  const path = join(root, PROFILE_PATH)
  if (!(await $.fs.exists(path))) return parseProfile(undefined)
  try {
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

/** Restores this repo's threads from $.store into the session's state (after a reload the state is kept). */
async function restoreThreads($: EngineInterface, root: string): Promise<void> {
  if ((await read($, threads)).length > 0) return
  const stored = await $.store.get(storeKey(root))
  if (Array.isArray(stored)) await update($, threads, () => stored as ForemanThread[])
}

/** Replaces the threads `changed` names (by id) or adds them, then persists the list. */
async function putThreads($: EngineInterface, root: string, changed: readonly ForemanThread[]): Promise<ForemanThread[]> {
  const list = await update($, threads, cur => {
    const out = [...cur]
    for (const t of changed) {
      const i = out.findIndex(x => x.id === t.id)
      if (i >= 0) out[i] = t
      else out.push(t)
    }
    return out
  })
  await $.store.set(storeKey(root), list)
  return list
}

/** Records the thread and a transition in <runsDir>/<runId>/foreman.json, when it belongs to a run. */
async function recordRun($: EngineInterface, root: string, parsed: ParsedProfile, t: ForemanThread, from: string, note?: string): Promise<void> {
  if (!t.runId) return
  const path = join(root, `${parsed.profile.runsDir}/${t.runId}/foreman.json`)
  let doc: { runId: string; updatedAt: string; threads: ForemanThread[]; transitions: unknown[] } = { runId: t.runId, updatedAt: t.updatedAt, threads: [], transitions: [] }
  try {
    if (await $.fs.exists(path)) {
      const old = JSON.parse(await $.fs.read(path)) as Partial<typeof doc>
      doc = { ...doc, ...old, threads: Array.isArray(old.threads) ? old.threads : [], transitions: Array.isArray(old.transitions) ? old.transitions : [] }
    }
  } catch { /* a broken file is rewritten from what foreman knows */ }
  const { transcript: _t, usageSince: _u, ...plain } = t
  doc.threads = [...doc.threads.filter(x => x.id !== t.id), plain]
  doc.transitions = [...doc.transitions, { at: t.updatedAt, thread: t.id, from, to: t.state, ...(note ? { note } : {}) }]
  doc.updatedAt = t.updatedAt
  try {
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

/** The thread's transcript: the cached path, the encoded cwd, else a scan of the projects folder. */
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
  const dirs = await $.fs.list(projects).catch(() => [])
  const prefix = encodeCwd(t.cwd)
  const ordered = [...dirs].sort((a, b) => Number(b.name.startsWith(prefix)) - Number(a.name.startsWith(prefix)))
  for (const d of ordered) {
    const p = `${projects}/${d.name}/${t.sessionId}.jsonl`
    if (await $.fs.exists(p)) return p
  }
  return undefined
}

async function readFacts($: EngineInterface, path: string, since: string | undefined): Promise<TranscriptFacts | undefined> {
  try {
    const { size } = await $.fs.stat(path)
    if (size <= DIRECT_READ_MAX) return readTranscript(await $.fs.read(path), { isTail: false, since })
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const r = await $.process.run(tailArgv(path, TAIL_BYTES, isWindows), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return undefined
    return readTranscript(r.stdout, { isTail: true, since })
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- the watcher

/** One look at every thread: `claude agents`, then each open thread's transcript. */
async function sync($: EngineInterface): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const root = await repoRoot($)
    const parsed = await loadProfile($, root)
    await update($, warnings, () => parsed.warnings)
    const now = await $.clock.now()
    let rows: ForemanAgentRow[]
    try {
      rows = await listRows($, claudeExe(parsed))
    } catch (err) {
      await update($, view, v => ({ ...v, root, refreshedAt: now, error: `Could not list background sessions: ${errText(err)}` }))
      return
    }
    const mine = repoRows(rows, root, now)
    await update($, view, () => ({ root, rows: mine, refreshedAt: now }))
    const current = await read($, threads)
    const nowIso = new Date(now).toISOString()
    const changed: ForemanThread[] = []
    for (const t of current) {
      if (t.closed || t.state === 'done') continue
      const row = rows.find(r => r.id === t.id)
      const base = row && !t.sessionId ? { ...t, sessionId: row.sessionId } : t
      const transcript = await findTranscript($, base, row)
      const facts = transcript ? await readFacts($, transcript, base.usageSince) : undefined
      // the row can still say done for the previous turn right after a resume: the transcript decides
      const turnOver = row !== undefined && row.state !== 'working' && row.status !== 'busy' && row.state !== 'blocked' && facts?.turnEnded === true
      const fence: FenceRead | undefined = facts && turnOver ? parseResultFence(facts.lastText) : undefined
      const s = syncThread({ ...base, ...(transcript ? { transcript } : {}) }, row, facts, fence, nowIso)
      if (s.changed || transcript !== t.transcript || base !== t) changed.push(s.thread)
      if (s.thread.state !== s.from) {
        await recordRun($, root, parsed, s.thread, s.from)
        if (parsed.profile.notify.toast) $.ui.toast(`${s.thread.name} → ${s.thread.state}${s.thread.waitingFor ? ` (${s.thread.waitingFor.slice(0, 80)})` : ''}`)
      }
    }
    const list = changed.length ? await putThreads($, root, changed) : current
    $.ui.status(threadStatus(list) ?? statusLine(mine))
  } finally {
    syncing = false
  }
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
  await sync($)
  return opened.isPlaced ? 'foreman pane opened.' : 'foreman pane is waiting for room: widen the terminal.'
}

async function readPrompt($: EngineInterface, name: string): Promise<string | undefined> {
  try {
    return await $.fs.read(`${$.plugin.root}/prompts/${name}`)
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
  if (runId !== undefined && !/^[A-Za-z0-9._-]+$/.test(runId)) return '--run takes letters, digits, ., _ and -'
  const part = str('part')

  const root = await repoRoot($)
  const parsed = await loadProfile($, root)
  const p = parsed.profile
  const busy = busyThreads(await read($, threads))
  if (busy.length >= p.limits.maxParallelThreads) {
    return `maxParallelThreads is ${p.limits.maxParallelThreads} and ${busy.map(t => t.name).join(', ')} is still busy. Wait, /foreman stop it, or raise limits.maxParallelThreads in ${PROFILE_PATH}.`
  }
  const rc = roleAt(p, role, level)
  const template = (await readPrompt($, templateName(role))) ?? (await readPrompt($, 'free.md')) ?? '{{task}}'
  const contract = (await readPrompt($, '_result.md')) ?? ''
  const brief = composeBrief(template, contract, p, role, { task, part, level, runId })
  const name = threadName(runId, role, part)
  const exe = claudeExe(parsed)
  const argv = launchArgv({ exe, name, model: model ?? rc.model, effort: effort ?? rc.effort, permissionMode: rc.permissionMode, isolation: p.isolation, brief })
  const r = await $.process.run(argv, { cwd: root, timeoutMs: 60_000 })
  const launched = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
  if (!launched) return `claude --bg failed (exit ${r.exitCode}):\n${(r.stderr || r.stdout).trim().slice(0, 1500)}`
  const row = (await listRows($, exe).catch(() => [] as ForemanAgentRow[])).find(x => x.id === launched.id)
  const nowIso = new Date(await $.clock.now()).toISOString()
  const thread: ForemanThread = {
    id: launched.id,
    sessionId: row?.sessionId ?? '',
    name,
    role,
    ...(runId ? { runId } : {}),
    ...(part ? { part } : {}),
    cwd: root,
    model: model ?? rc.model,
    effort: effort ?? rc.effort,
    startedAt: nowIso,
    updatedAt: nowIso,
    state: 'working',
  }
  await putThreads($, root, [thread])
  await recordRun($, root, parsed, thread, 'none', 'launched')
  spawnSync($)
  return `Launched ${name} as ${launched.id} (${thread.model}, effort ${thread.effort}, ${rc.permissionMode}). Watch it with \`claude attach ${launched.id}\` or /foreman open ${launched.id}.`
}

async function pick($: EngineInterface, ref: string | undefined): Promise<ForemanThread | string> {
  const found = findThread(await read($, threads), ref)
  return 'error' in found ? found.error : found.thread
}

async function tell($: EngineInterface, args: string): Promise<string> {
  const { positional } = parseArgs(args)
  const t = await pick($, positional[1])
  if (typeof t === 'string') return t
  const text = positional.slice(2).join(' ').trim()
  if (!text) return 'Say what to send: /foreman tell <thread> "<message>"'
  const root = await repoRoot($)
  const parsed = await loadProfile($, root)
  const exe = claudeExe(parsed)
  const row = (await listRows($, exe)).find(x => x.id === t.id)
  const plan = sendPlan(row)
  if ('refuse' in plan) return `Not sent: ${plan.refuse}.`
  const sessionId = t.sessionId || row?.sessionId
  if (!sessionId) return `Not sent: no session id known for ${t.id} yet; try again in a few seconds.`
  if (plan.steps.includes('stop')) {
    const s = await $.process.run(stopArgv(exe, t.id), { timeoutMs: 30_000 })
    if (s.exitCode !== 0) return `Not sent: claude stop ${t.id} failed: ${(s.stderr || s.stdout).trim()}`
  }
  const message = `${text}\n\n(When you finish, end your turn with the foreman-result block.)`
  const r = await $.process.run(resumeArgv(exe, sessionId, message), { cwd: t.cwd, timeoutMs: 60_000 })
  const resumed = r.exitCode === 0 ? parseLaunched(r.stdout) : undefined
  if (!resumed) return `claude --bg --resume failed (exit ${r.exitCode}):\n${(r.stderr || r.stdout).trim().slice(0, 1500)}`
  const nowIso = new Date(await $.clock.now()).toISOString()
  const next: ForemanThread = { ...t, sessionId, state: 'working', updatedAt: nowIso }
  delete next.waitingFor
  delete next.noResult
  await putThreads($, root, [next])
  await recordRun($, root, parsed, next, t.state, 'message sent')
  const copy = resumed.isCopy || resumed.id !== t.id ? ` Note: the CLI answered with ${resumed.id}, not ${t.id}.` : ''
  return `Sent to ${t.name} (${t.id}); it is working again.${copy}`
}

async function openThread($: EngineInterface, args: string): Promise<string> {
  const t = await pick($, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const cmd = `claude attach ${t.id}`
  const copied = await $.ui.copy({ text: cmd }).catch(() => ({ isCopied: false }))
  const desktop = (await $.session.surfaces()).includes('desktop') && t.sessionId ? `\nIn the desktop app: \`claude --desktop --resume ${t.sessionId}\`` : ''
  return `Run in a terminal: \`${cmd}\`${copied.isCopied ? ' (copied)' : ''}${desktop}`
}

async function logThread($: EngineInterface, args: string): Promise<string> {
  const { positional } = parseArgs(args)
  const t = await pick($, positional[1])
  if (typeof t === 'string') return t
  const n = Math.min(200, Math.max(1, Number(positional[2] ?? 30) || 30))
  const parsed = await loadProfile($, await repoRoot($))
  const r = await $.process.run(logsArgv(claudeExe(parsed), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `No screen for ${t.id}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`
  return ['```', ...tailLines(r.stdout, n), '```'].join('\n')
}

async function stopThread($: EngineInterface, args: string): Promise<string> {
  const t = await pick($, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const root = await repoRoot($)
  const parsed = await loadProfile($, root)
  const r = await $.process.run(stopArgv(claudeExe(parsed), t.id), { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return `claude stop ${t.id}: ${(r.stderr || r.stdout).trim()}`
  const next: ForemanThread = { ...t, state: 'stopped', updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, root, [next])
  await recordRun($, root, parsed, next, t.state, 'stopped by /foreman stop')
  return `Stopped ${t.name} (${t.id}). Its conversation is kept: /foreman tell ${t.id} "…" resumes it.`
}

async function closeThread($: EngineInterface, args: string): Promise<string> {
  const t = await pick($, parseArgs(args).positional[1])
  if (typeof t === 'string') return t
  const root = await repoRoot($)
  const parsed = await loadProfile($, root)
  const next: ForemanThread = { ...t, state: 'done', closed: true, updatedAt: new Date(await $.clock.now()).toISOString() }
  await putThreads($, root, [next])
  await recordRun($, root, parsed, next, t.state, 'closed')
  return `Closed ${t.name} (${t.id}); the session itself is kept (\`claude rm ${t.id}\` deletes it).`
}

async function status($: EngineInterface): Promise<string> {
  await sync($)
  return statusTable(await read($, threads), await $.clock.now())
}

async function init($: EngineInterface): Promise<string> {
  const root = await repoRoot($)
  const path = join(root, PROFILE_PATH)
  if (await $.fs.exists(path)) {
    const parsed = parseProfile(await $.fs.read(path))
    await update($, warnings, () => parsed.warnings)
    return parsed.warnings.length === 0
      ? `${PROFILE_PATH} is valid.`
      : [`${PROFILE_PATH} has ${parsed.warnings.length} warning(s); each key falls back to its default:`, ...parsed.warnings.map(w => `  - ${w}`)].join('\n')
  }
  const names = (await $.fs.list(root).catch(() => [])).map(entry => entry.name)
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
  const parsed = await loadProfile($, await repoRoot($))
  const head = parsed.source === 'default' ? `No ${PROFILE_PATH}: running on the defaults.` : `Profile: defaults + ${PROFILE_PATH}.`
  const warn = parsed.warnings.length ? ['', 'Warnings:', ...parsed.warnings.map(w => `  - ${w}`)] : []
  return [head, ...warn, '', '```json', JSON.stringify(parsed.profile, null, 2), '```'].join('\n')
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
    const root = await repoRoot($)
    const parsed = await loadProfile($, root)
    await update($, warnings, () => parsed.warnings)
    if (parsed.warnings.length) $.ui.toast(`${parsed.warnings.length} profile warning(s), see /foreman profile`)
    await restoreThreads($, root)
    $.clock.every(WATCH_MS, () => spawnSync($))
    spawnSync($)
    return started
  })

  on('command.run', { command: 'foreman' }, async ($, e) => {
    const sub = parseArgs(e.args).positional[0] ?? ''
    switch (sub) {
      case '': return { text: await togglePane($) }
      case 'launch': return { text: await launch($, e.args) }
      case 'status': return { text: await status($) }
      case 'tell': return { text: await tell($, e.args) }
      case 'open': return { text: await openThread($, e.args) }
      case 'log': return { text: await logThread($, e.args) }
      case 'stop': return { text: await stopThread($, e.args) }
      case 'close': return { text: await closeThread($, e.args) }
      case 'init': return { text: await init($) }
      case 'profile': return { text: await showProfile($) }
      case 'help': return { text: HELP }
      default: return { text: `Unknown command: ${sub}\n${HELP}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = { view: await read($, view), threads: await read($, threads), warnings: await read($, warnings) }
    return paneTree($.ui.resolve(e), data, { refresh: () => spawnSync($) })
  })
}
