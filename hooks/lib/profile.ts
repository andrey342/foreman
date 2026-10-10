// The repo profile, .claude/foreman.json: defaults, validation and merging.
// Every key is optional (D8). A bad value produces one warning naming the key
// and falls back to that key's default; nothing here ever throws.

import type { ForemanEffort, ForemanLevel, ForemanPermissionMode, ForemanRole } from '../../types'

export const PROFILE_PATH = '.claude/foreman.json'

export const ROLES: readonly ForemanRole[] = ['planner', 'implementer', 'reviewer', 'critic', 'qa', 'triage', 'free']
export const LEVELS: readonly ForemanLevel[] = ['N1', 'N2', 'N3']
export const EFFORTS: readonly ForemanEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const PERMISSION_MODES: readonly ForemanPermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'inherit']

export type RoleOverride = { model?: string; effort?: ForemanEffort; permissionMode?: ForemanPermissionMode; skills?: string[]; extra?: string }

export type RoleConfig = {
  model: string
  effort: ForemanEffort
  permissionMode: ForemanPermissionMode
  kind: 'thread' | 'subagent'
  skills: string[]
  tools?: string[]
  extra: string
  contract?: string
  byLevel: Partial<Record<ForemanLevel, RoleOverride>>
}

export type Guard = {
  when: { tool?: string; pathGlob?: string; commandRegex?: string }
  requireToolCalledBefore?: string
  mode: 'warn' | 'deny'
  reason?: string
}

export type Profile = {
  version: 1
  runsDir: string
  isolation: 'none' | 'worktree'
  repos: { name: string; path: string }[]
  roles: Record<ForemanRole, RoleConfig>
  gates: Record<string, string[]>
  guards: Guard[]
  limits: { maxParallelThreads: number; maxReviewCycles: number; serialBuilds: boolean }
  hooks: { onRunCreate: string | null }
  injectHandoff: boolean
  /** `command` lives in the plugin's settings (`notifyCommand`, D-57). */
  notify: { toast: boolean }
}

function role(model: string, effort: ForemanEffort, kind: 'thread' | 'subagent', extra: Partial<RoleConfig> = {}): RoleConfig {
  return { model, effort, permissionMode: 'auto', kind, skills: [], extra: '', byLevel: {}, ...extra }
}

/** The profile a repo without .claude/foreman.json runs with (plan D4, D8). */
export function defaultProfile(): Profile {
  return {
    version: 1,
    runsDir: '.claude/runs',
    isolation: 'none',
    repos: [{ name: 'root', path: '.' }],
    roles: {
      planner: role('opus', 'high', 'thread'),
      implementer: role('opus', 'high', 'thread', { byLevel: { N1: { model: 'sonnet' } } }),
      reviewer: role('fable', 'high', 'subagent', { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'] }),
      critic: role('fable', 'high', 'subagent', { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'] }),
      qa: role('sonnet', 'medium', 'thread'),
      triage: role('haiku', 'low', 'subagent', { tools: ['Read', 'Grep', 'Glob'] }),
      free: role('sonnet', 'high', 'thread'),
    },
    gates: {},
    guards: [],
    limits: { maxParallelThreads: 1, maxReviewCycles: 2, serialBuilds: true },
    hooks: { onRunCreate: null },
    injectHandoff: true,
    notify: { toast: true },
  }
}

const TOP_KEYS = ['version', 'runsDir', 'claudeExe', 'isolation', 'repos', 'roles', 'gates', 'guards', 'limits', 'hooks', 'injectHandoff', 'notify']
const ROLE_KEYS = ['model', 'effort', 'permissionMode', 'kind', 'skills', 'tools', 'extra', 'contract', 'byLevel']
const OVERRIDE_KEYS = ['model', 'effort', 'permissionMode', 'skills', 'extra']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** A relative path with no `..` segment, no drive and no leading separator. */
export function isRelativeInside(p: string): boolean {
  return p.trim() !== '' && !/^[\\/]/.test(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..')
}

/** A run id or part as it may appear in a file name: a letter or digit first, then letters, digits, `.`, `_`, `-`; never `..` (review C-04). */
export function isSafeId(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) && !v.includes('..')
}

export function isModel(v: unknown): v is string {
  return typeof v === 'string' && (MODEL_ALIASES.includes(v) || /^claude-[a-z0-9.-]+$/.test(v))
}

/** Strips // and /* *\/ comments outside strings, so a jsonc profile parses. */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const d = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') { out += d ?? ''; i++ } else if (c === '"') inString = false
    } else if (c === '"') { inString = true; out += c } else if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && d === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return out
}

type Warn = (key: string, why: string) => void

function readOverride(path: string, raw: unknown, warn: Warn): RoleOverride | undefined {
  if (!isObject(raw)) { warn(path, 'must be an object'); return undefined }
  const out: RoleOverride = {}
  for (const k of Object.keys(raw)) if (!OVERRIDE_KEYS.includes(k)) warn(`${path}.${k}`, 'unknown key, ignored')
  if (raw.model !== undefined) isModel(raw.model) ? (out.model = raw.model) : warn(`${path}.model`, `not a model: ${JSON.stringify(raw.model)}`)
  if (raw.effort !== undefined) EFFORTS.includes(raw.effort as ForemanEffort) ? (out.effort = raw.effort as ForemanEffort) : warn(`${path}.effort`, `one of ${EFFORTS.join(', ')}`)
  if (raw.permissionMode !== undefined) PERMISSION_MODES.includes(raw.permissionMode as ForemanPermissionMode) ? (out.permissionMode = raw.permissionMode as ForemanPermissionMode) : warn(`${path}.permissionMode`, `one of ${PERMISSION_MODES.join(', ')}`)
  if (raw.skills !== undefined) isStringArray(raw.skills) ? (out.skills = raw.skills) : warn(`${path}.skills`, 'must be a list of names')
  if (raw.extra !== undefined) typeof raw.extra === 'string' ? (out.extra = raw.extra) : warn(`${path}.extra`, 'must be a string')
  return out
}

function readRole(name: ForemanRole, raw: unknown, base: RoleConfig, warn: Warn): RoleConfig {
  const path = `roles.${name}`
  if (!isObject(raw)) { warn(path, 'must be an object'); return base }
  const out: RoleConfig = { ...base, byLevel: { ...base.byLevel } }
  for (const k of Object.keys(raw)) if (!ROLE_KEYS.includes(k)) warn(`${path}.${k}`, 'unknown key, ignored')
  const o = readOverride(path, Object.fromEntries(Object.entries(raw).filter(([k]) => OVERRIDE_KEYS.includes(k))), warn)
  Object.assign(out, o)
  if (raw.kind !== undefined) raw.kind === 'thread' || raw.kind === 'subagent' ? (out.kind = raw.kind) : warn(`${path}.kind`, 'one of thread, subagent')
  if (raw.tools !== undefined) isStringArray(raw.tools) ? (out.tools = raw.tools) : warn(`${path}.tools`, 'must be a list of tool names')
  if (raw.contract !== undefined) typeof raw.contract === 'string' ? (out.contract = raw.contract) : warn(`${path}.contract`, 'must be a path')
  if (raw.byLevel !== undefined) {
    if (!isObject(raw.byLevel)) warn(`${path}.byLevel`, 'must be an object')
    else for (const [lv, v] of Object.entries(raw.byLevel)) {
      if (!LEVELS.includes(lv as ForemanLevel)) { warn(`${path}.byLevel.${lv}`, `unknown level, one of ${LEVELS.join(', ')}`); continue }
      const ov = readOverride(`${path}.byLevel.${lv}`, v, warn)
      if (ov) out.byLevel[lv as ForemanLevel] = ov
    }
  }
  return out
}

function readGuard(i: number, raw: unknown, warn: Warn): Guard | undefined {
  const path = `guards[${i}]`
  if (!isObject(raw) || !isObject(raw.when)) { warn(path, 'needs a "when" object'); return undefined }
  const when: Guard['when'] = {}
  for (const k of ['tool', 'pathGlob', 'commandRegex'] as const) {
    const v = raw.when[k]
    if (v === undefined) continue
    if (typeof v !== 'string') { warn(`${path}.when.${k}`, 'must be a string'); return undefined }
    if (k !== 'pathGlob') {
      try { new RegExp(k === 'tool' ? `^(?:${v})$` : v) } catch { warn(`${path}.when.${k}`, 'not a valid regular expression'); return undefined }
    }
    when[k] = v
  }
  const mode = raw.mode ?? 'warn'
  if (mode !== 'warn' && mode !== 'deny') { warn(`${path}.mode`, 'one of warn, deny'); return undefined }
  const g: Guard = { when, mode }
  if (raw.requireToolCalledBefore !== undefined) {
    if (typeof raw.requireToolCalledBefore !== 'string') { warn(`${path}.requireToolCalledBefore`, 'must be a tool name'); return undefined }
    try { new RegExp(`^(?:${raw.requireToolCalledBefore})$`) } catch { warn(`${path}.requireToolCalledBefore`, 'not a valid tool name or pattern'); return undefined }
    g.requireToolCalledBefore = raw.requireToolCalledBefore
  }
  if (raw.reason !== undefined) typeof raw.reason === 'string' ? (g.reason = raw.reason) : warn(`${path}.reason`, 'must be a string')
  return g
}

/**
 * `unusable`: a file is there but could not be read or parsed, so the
 * defaults stand in for it; the guards' hook refuses calls then, rather than
 * run them unguarded (review P5-02), when the file declared guards: an
 * earlier good read in the session did, or its text names `"guards"`
 * (`guardsNamed`), so a session that starts on a broken file is guarded too.
 */
export type ParsedProfile = { profile: Profile; warnings: string[]; source: 'default' | 'file'; unusable?: true; guardsNamed?: true }

/** The commands foreman runs on its own (no one typing): set in the plugin's settings, never by a repo (C-13, D-57). */
export const MOVED_TO_SETTINGS = 'runs a command without anyone typing, so it is set in the plugin settings (claude plugin configure foreman), not in a repo profile; ignored'

const namesGuards = (text: string): { guardsNamed?: true } => (/["']?guards["']?\s*:/.test(text) ? { guardsNamed: true } : {})

/** Parses the text of .claude/foreman.json (undefined: no file) over the defaults. */
export function parseProfile(text: string | undefined): ParsedProfile {
  const profile = defaultProfile()
  const warnings: string[] = []
  const warn: Warn = (key, why) => warnings.push(`${PROFILE_PATH}: ${key}: ${why}`)
  if (text === undefined) return { profile, warnings, source: 'default' }
  if (text.trim() === '') return { profile, warnings, source: 'file' }
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonComments(text))
  } catch (err) {
    warn('(file)', `not valid JSON (${err instanceof Error ? err.message : String(err)}); using the defaults`)
    return { profile, warnings, source: 'file', unusable: true, ...namesGuards(text) }
  }
  if (!isObject(raw)) {
    warn('(file)', 'must be a JSON object; using the defaults')
    return { profile, warnings, source: 'file', unusable: true, ...namesGuards(text) }
  }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) warn(k, 'unknown key, ignored')

  if (raw.version !== undefined && raw.version !== 1) warn('version', 'only version 1 is known; read as 1')
  if (raw.runsDir !== undefined) {
    typeof raw.runsDir === 'string' && isRelativeInside(raw.runsDir)
      ? (profile.runsDir = raw.runsDir.replace(/[\\/]+$/, ''))
      : warn('runsDir', 'must be a relative path inside the repo')
  }
  if (raw.claudeExe !== undefined && raw.claudeExe !== null) warn('claudeExe', MOVED_TO_SETTINGS)
  if (raw.isolation !== undefined) raw.isolation === 'none' || raw.isolation === 'worktree' ? (profile.isolation = raw.isolation) : warn('isolation', 'one of none, worktree')
  if (raw.repos !== undefined) {
    const ok = Array.isArray(raw.repos) && raw.repos.length > 0 && raw.repos.every(r => isObject(r) && typeof r.name === 'string' && typeof r.path === 'string')
    ok ? (profile.repos = (raw.repos as { name: string; path: string }[]).map(r => ({ name: r.name, path: r.path }))) : warn('repos', 'must be a non-empty list of { name, path }')
  }
  if (raw.roles !== undefined) {
    if (!isObject(raw.roles)) warn('roles', 'must be an object')
    else for (const [name, v] of Object.entries(raw.roles)) {
      if (!ROLES.includes(name as ForemanRole)) { warn(`roles.${name}`, `unknown role, one of ${ROLES.join(', ')}`); continue }
      profile.roles[name as ForemanRole] = readRole(name as ForemanRole, v, profile.roles[name as ForemanRole], warn)
    }
  }
  if (raw.gates !== undefined) {
    if (!isObject(raw.gates)) warn('gates', 'must be an object of lists of commands')
    else for (const [name, v] of Object.entries(raw.gates)) isStringArray(v) ? (profile.gates[name] = v) : warn(`gates.${name}`, 'must be a list of commands')
  }
  if (raw.guards !== undefined) {
    if (!Array.isArray(raw.guards)) warn('guards', 'must be a list')
    else profile.guards = raw.guards.map((g, i) => readGuard(i, g, warn)).filter((g): g is Guard => g !== undefined)
  }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) warn('limits', 'must be an object')
    else {
      for (const k of Object.keys(raw.limits)) if (!['maxParallelThreads', 'maxReviewCycles', 'serialBuilds'].includes(k)) warn(`limits.${k}`, 'unknown key, ignored')
      for (const k of ['maxParallelThreads', 'maxReviewCycles'] as const) {
        const v = raw.limits[k]
        if (v === undefined) continue
        Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10 ? (profile.limits[k] = v as number) : warn(`limits.${k}`, 'must be a whole number from 1 to 10')
      }
      const s = raw.limits.serialBuilds
      if (s !== undefined) typeof s === 'boolean' ? (profile.limits.serialBuilds = s) : warn('limits.serialBuilds', 'must be true or false')
    }
  }
  if (raw.hooks !== undefined) {
    if (!isObject(raw.hooks)) warn('hooks', 'must be an object')
    else {
      for (const k of Object.keys(raw.hooks)) if (k !== 'onRunCreate') warn(`hooks.${k}`, 'unknown key, ignored')
      const v = raw.hooks.onRunCreate
      if (v !== undefined) v === null || typeof v === 'string' ? (profile.hooks.onRunCreate = v) : warn('hooks.onRunCreate', 'must be a command or null')
    }
  }
  if (raw.injectHandoff !== undefined) typeof raw.injectHandoff === 'boolean' ? (profile.injectHandoff = raw.injectHandoff) : warn('injectHandoff', 'must be true or false')
  if (raw.notify !== undefined) {
    if (!isObject(raw.notify)) warn('notify', 'must be an object')
    else {
      for (const k of Object.keys(raw.notify)) if (k !== 'toast' && k !== 'command') warn(`notify.${k}`, 'unknown key, ignored')
      if (raw.notify.toast !== undefined) typeof raw.notify.toast === 'boolean' ? (profile.notify.toast = raw.notify.toast) : warn('notify.toast', 'must be true or false')
      const c = raw.notify.command
      if (c !== undefined && c !== null) warn('notify.command', MOVED_TO_SETTINGS)
    }
  }
  return { profile, warnings, source: 'file' }
}

/** The role's settings at a level: its byLevel entry over its own. */
export function roleAt(profile: Profile, name: ForemanRole, level?: ForemanLevel): Omit<RoleConfig, 'byLevel'> {
  const { byLevel, ...base } = profile.roles[name]
  const o = level ? byLevel[level] : undefined
  return o ? { ...base, ...o } : base
}

export type RepoFacts = { hasPackageJson: boolean; slnFiles: string[]; hasPyproject: boolean }

/** The profile /foreman init writes: the defaults that matter, plus gates guessed from the repo. */
export function initialProfile(facts: RepoFacts): Record<string, unknown> {
  const gates: Record<string, string[]> = {}
  if (facts.hasPackageJson) gates.node = ['npm test']
  if (facts.slnFiles.length > 0) gates.dotnet = [`dotnet test ${facts.slnFiles[0]}`]
  if (facts.hasPyproject) gates.python = ['python -m pytest']
  const d = defaultProfile()
  return {
    version: 1,
    runsDir: d.runsDir,
    roles: {
      implementer: { model: 'opus', effort: 'high', byLevel: { N1: { model: 'sonnet' } } },
      reviewer: { model: 'fable', effort: 'high' },
    },
    gates,
    limits: d.limits,
    injectHandoff: d.injectHandoff,
  }
}
