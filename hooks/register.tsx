// foreman: coordinate long-running Claude Code work as background threads.
// Entry point: registers /foreman, the pane and the timers. Every call on `$`
// lives in this file (the engine follows `$` only into functions declared
// here); hooks/lib and hooks/ui are pure.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { agentsArgv, readAgents, repoRows, statusLine } from './lib/agents'
import { parseArgs } from './lib/args'
import { PROFILE_PATH, initialProfile, parseProfile } from './lib/profile'
import type { ParsedProfile } from './lib/profile'
import { claudeExe, join } from './lib/repo'
import { paneTree } from './ui/pane'
import type { ForemanView } from '../types'

const PANE_ID = 'foreman'
const PANE_TITLE = 'foreman'

// The values kept in $.state (declared in types/index.d.ts).
const view = atom({ plugin: 'foreman', key: 'view' } as const, { root: '', rows: [], refreshedAt: 0 } as ForemanView)
const warnings = atom({ plugin: 'foreman', key: 'warnings' } as const, [] as string[])

const HELP = [
  'Usage: /foreman [command]',
  '  (none)     open or close the foreman pane',
  '  init       write .claude/foreman.json for this repo, or check the one there',
  '  profile    show the profile in effect (defaults + .claude/foreman.json)',
  '  help       this text',
].join('\n')

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

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

/** Lists this repo's background sessions into the pane's state and the status line. */
async function refresh($: EngineInterface): Promise<void> {
  const root = await repoRoot($)
  const parsed = await loadProfile($, root)
  await update($, warnings, () => parsed.warnings)
  const now = await $.clock.now()
  try {
    const result = await $.process.run(agentsArgv(claudeExe(parsed)), { timeoutMs: 30_000 })
    const rows = repoRows(readAgents(result), root, now)
    await update($, view, () => ({ root, rows, refreshedAt: now }))
    $.ui.status(statusLine(rows))
  } catch (err) {
    const error = `Could not list background sessions: ${errText(err)}`
    await update($, view, v => ({ ...v, root, refreshedAt: now, error }))
  }
}

async function togglePane($: EngineInterface): Promise<string> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE_ID)
  if (isOpen) {
    await $.ui.close({ id: PANE_ID })
    return 'foreman pane closed.'
  }
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  await refresh($)
  return opened.isPlaced ? 'foreman pane opened.' : 'foreman pane is waiting for room: widen the terminal.'
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'foreman',
      description: 'Coordinate background threads: pane, init, profile, help',
      argumentHint: '[init|profile|help]',
    })
    const started = await next(e)
    const parsed = await loadProfile($, await repoRoot($))
    await update($, warnings, () => parsed.warnings)
    if (parsed.warnings.length) $.ui.toast(`foreman: ${parsed.warnings.length} profile warning(s), see /foreman profile`)
    return started
  })

  on('command.run', { command: 'foreman' }, async ($, e) => {
    const { positional } = parseArgs(e.args)
    const sub = positional[0] ?? ''
    if (sub === '') return { text: await togglePane($) }
    if (sub === 'init') return { text: await init($) }
    if (sub === 'profile') return { text: await showProfile($) }
    if (sub === 'help') return { text: HELP }
    return { text: `Unknown command: ${sub}\n${HELP}` }
  })

  on('ui.render', { component: 'Pane', requestId: 'foreman' }, async ($, e) => {
    const data = { view: await read($, view), warnings: await read($, warnings) }
    return paneTree($.ui.resolve(e), data, { refresh: () => void refresh($) })
  })
}
