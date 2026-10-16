// The repo profile, .claude/foreman.json (version 2): defaults, validation,
// and the 0.1 profile read through aliases (D-80). Every key is optional (D8).
// A bad value produces one warning naming the key and falls back to that key's
// default; a key 0.2 retired produces one warning and is ignored; nothing here
// ever throws.

import type { ForemanEffort, ForemanPermissionMode, ForemanRole } from '../../types'

export const PROFILE_PATH = '.claude/foreman.json'

export const ROLES: readonly ForemanRole[] = ['implementer', 'reviewer', 'supervisor']
/** The 0.1 roles 0.2 dropped (D-75). */
export const RETIRED_ROLES = ['planner', 'critic', 'qa', 'triage', 'free'] as const
export const EFFORTS: readonly ForemanEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const PERMISSION_MODES: readonly ForemanPermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
export const ISOLATIONS = ['worktree', 'branch', 'none'] as const
export const DELIVERY_MODES = ['pr', 'merge', 'branch', 'none'] as const
export const GUARD_SCOPES = ['threads', 'everywhere'] as const
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'inherit']

export type RoleConfig = {
  model: string
  effort: ForemanEffort
  permissionMode: ForemanPermissionMode
  skills: string[]
  extra: string
}

export type Guard = {
  when: { tool?: string; pathGlob?: string; commandRegex?: string }
  requireToolCalledBefore?: string
  mode: 'warn' | 'deny'
  reason?: string
}

export type Profile = {
  version: 2
  /** Where a plan's threads work (D-71): its own worktree and branch (the default), a branch in the checkout, or the checkout as it is. */
  isolation: (typeof ISOLATIONS)[number]
  /** A folder of the repo's own for foreman's files (its convention); unset, they live under `.git/foreman/` (D-70). */
  runsDir?: string
  roles: Record<ForemanRole, RoleConfig>
  gates: Record<string, string[]>
  /** The repo's guards and where they act: foreman's threads only (the default), or every session that loads foreman (D-78). */
  guards: { scope: (typeof GUARD_SCOPES)[number]; rules: Guard[] }
  limits: { maxParallelThreads: number; reviewRounds: number }
  /** What happens to the plan's branch at the end (D-72; acted on from Phase 4). */
  delivery: { mode: (typeof DELIVERY_MODES)[number]; handoffToApp: boolean }
  /** `command` lives in the plugin's settings (D-57); `quiet` groups notices (D-66). */
  notify: { toast: boolean; quiet: boolean }
}

function role(model: string, effort: ForemanEffort, permissionMode: ForemanPermissionMode = 'auto'): RoleConfig {
  return { model, effort, permissionMode, skills: [], extra: '' }
}

/** The profile a repo without .claude/foreman.json runs with (plan D-74, D-77). */
export function defaultProfile(): Profile {
  return {
    version: 2,
    isolation: 'worktree',
    roles: {
      implementer: role('opus', 'high'),
      // read-only processes: dontAsk keeps their allow list binding (D-112)
      reviewer: role('fable', 'high', 'dontAsk'),
      supervisor: role('opus', 'high', 'dontAsk'),
    },
    gates: {},
    guards: { scope: 'threads', rules: [] },
    limits: { maxParallelThreads: 1, reviewRounds: 3 },
    delivery: { mode: 'branch', handoffToApp: false },
    notify: { toast: true, quiet: false },
  }
}

const TOP_KEYS = ['version', 'mode', 'isolation', 'runsDir', 'roles', 'gates', 'guards', 'limits', 'delivery', 'notify']
/** 0.1 keys 0.2 no longer reads, each with why (D-80). */
const RETIRED_TOP: Record<string, string> = {
  repos: 'retired in 0.2: submodules are found by git; ignored',
  hooks: 'retired in 0.2 (hooks.onRunCreate ran a repo command on its own); ignored',
  injectHandoff: 'retired in 0.2: foreman keeps progress.md itself; ignored',
}
const ROLE_KEYS = ['model', 'effort', 'permissionMode', 'skills', 'extra']
/** Why `mode` other than "auto" is ignored (D-111). */
export const ONE_MODE = 'one mode in 0.2: a plan\'s parts chain by themselves, and a pause written in the plan still stops before the next part; ignored'
const RETIRED_ROLE_KEYS: Record<string, string> = {
  kind: 'retired in 0.2: the implementer is a thread, the reviewer and the supervisor are runs foreman starts; ignored',
  contract: 'retired in 0.2: the result contract is foreman\'s own; ignored',
  byLevel: 'retired in 0.2 (levels N1–N3 are gone): pass --model to /foreman go instead; ignored',
  tools: 'retired in 0.2: foreman fixes the reviewer\'s and the supervisor\'s tools; ignored',
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

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

function readRole(name: ForemanRole, raw: unknown, base: RoleConfig, warn: Warn): RoleConfig {
  const path = `roles.${name}`
  if (!isObject(raw)) { warn(path, 'must be an object'); return base }
  const out: RoleConfig = { ...base }
  for (const k of Object.keys(raw)) {
    if (RETIRED_ROLE_KEYS[k]) warn(`${path}.${k}`, RETIRED_ROLE_KEYS[k] as string)
    else if (!ROLE_KEYS.includes(k)) warn(`${path}.${k}`, 'unknown key, ignored')
  }
  if (raw.model !== undefined) isModel(raw.model) ? (out.model = raw.model) : warn(`${path}.model`, `not a model: ${JSON.stringify(raw.model)}`)
  if (raw.effort !== undefined) oneOf(EFFORTS, raw.effort) ? (out.effort = raw.effort) : warn(`${path}.effort`, `one of ${EFFORTS.join(', ')}`)
  if (raw.permissionMode !== undefined) {
    // the reviewer and the supervisor are read-only processes: dontAsk keeps their allow list binding, auto would not (D-112)
    if (name !== 'implementer') { if (raw.permissionMode !== 'dontAsk') warn(`${path}.permissionMode`, 'the reviewer and the supervisor are read-only processes that always run in dontAsk; ignored') }
    else oneOf(PERMISSION_MODES, raw.permissionMode) ? (out.permissionMode = raw.permissionMode) : warn(`${path}.permissionMode`, `one of ${PERMISSION_MODES.join(', ')}`)
  }
  if (raw.skills !== undefined) isStringArray(raw.skills) ? (out.skills = raw.skills) : warn(`${path}.skills`, 'must be a list of names')
  if (raw.extra !== undefined) typeof raw.extra === 'string' ? (out.extra = raw.extra) : warn(`${path}.extra`, 'must be a string')
  return out
}

function readGuard(i: number, raw: unknown, warn: Warn): Guard | undefined {
  const path = `guards.rules[${i}]`
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

function readGuards(raw: unknown, warn: Warn): Profile['guards'] | undefined {
  if (Array.isArray(raw)) {
    // the 0.1 form: a plain list, which acted in every session (D-61); 0.2 reads it as rules for foreman's threads (D-78)
    warn('guards', 'a list is the 0.1 form: read as { "scope": "threads", "rules": [...] }; they now act in foreman\'s threads only, set "scope": "everywhere" to keep them in every session')
    return { scope: 'threads', rules: raw.map((g, i) => readGuard(i, g, warn)).filter((g): g is Guard => g !== undefined) }
  }
  if (!isObject(raw)) { warn('guards', 'must be { "scope", "rules" }'); return undefined }
  for (const k of Object.keys(raw)) if (k !== 'scope' && k !== 'rules') warn(`guards.${k}`, 'unknown key, ignored')
  const out: Profile['guards'] = { scope: 'threads', rules: [] }
  if (raw.scope !== undefined) oneOf(GUARD_SCOPES, raw.scope) ? (out.scope = raw.scope) : warn('guards.scope', `one of ${GUARD_SCOPES.join(', ')}`)
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) warn('guards.rules', 'must be a list')
    else out.rules = raw.rules.map((g, i) => readGuard(i, g, warn)).filter((g): g is Guard => g !== undefined)
  }
  return out
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

/** Parses the text of .claude/foreman.json (undefined: no file) over the defaults; a version 1 file is read through the aliases (D-80). */
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
  for (const k of Object.keys(raw)) {
    if (RETIRED_TOP[k]) warn(k, RETIRED_TOP[k] as string)
    else if (k === 'claudeExe') { if (raw.claudeExe !== null) warn('claudeExe', MOVED_TO_SETTINGS) } else if (!TOP_KEYS.includes(k)) warn(k, 'unknown key, ignored')
  }

  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) warn('version', 'one of 1, 2; read as 2')
  // one mode (D-111): "auto" says what 0.2 does anyway; anything else is said and ignored
  if (raw.mode !== undefined && raw.mode !== 'auto') warn('mode', ONE_MODE)
  if (raw.isolation !== undefined) oneOf(ISOLATIONS, raw.isolation) ? (profile.isolation = raw.isolation) : warn('isolation', `one of ${ISOLATIONS.join(', ')}`)
  if (raw.runsDir !== undefined) {
    typeof raw.runsDir === 'string' && isRelativeInside(raw.runsDir)
      ? (profile.runsDir = raw.runsDir.replace(/[\\/]+$/, ''))
      : warn('runsDir', 'must be a relative path inside the repo')
  }
  if (raw.roles !== undefined) {
    if (!isObject(raw.roles)) warn('roles', 'must be an object')
    else for (const [name, v] of Object.entries(raw.roles)) {
      if ((RETIRED_ROLES as readonly string[]).includes(name)) { warn(`roles.${name}`, `retired in 0.2 (roles: ${ROLES.join(', ')}); ignored`); continue }
      if (!ROLES.includes(name as ForemanRole)) { warn(`roles.${name}`, `unknown role, one of ${ROLES.join(', ')}`); continue }
      profile.roles[name as ForemanRole] = readRole(name as ForemanRole, v, profile.roles[name as ForemanRole], warn)
    }
  }
  if (raw.gates !== undefined) {
    if (!isObject(raw.gates)) warn('gates', 'must be an object of lists of commands')
    else for (const [name, v] of Object.entries(raw.gates)) isStringArray(v) ? (profile.gates[name] = v) : warn(`gates.${name}`, 'must be a list of commands')
  }
  if (raw.guards !== undefined) {
    const g = readGuards(raw.guards, warn)
    if (g) profile.guards = g
  }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) warn('limits', 'must be an object')
    else {
      for (const k of Object.keys(raw.limits)) {
        if (k === 'serialBuilds') warn('limits.serialBuilds', 'retired in 0.2: one thread works at a time unless maxParallelThreads says otherwise; ignored')
        else if (!['maxParallelThreads', 'reviewRounds', 'maxReviewCycles'].includes(k)) warn(`limits.${k}`, 'unknown key, ignored')
      }
      const whole = (k: string, v: unknown, set: (n: number) => void) => {
        if (v === undefined) return
        Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10 ? set(v as number) : warn(`limits.${k}`, 'must be a whole number from 1 to 10')
      }
      whole('maxParallelThreads', raw.limits.maxParallelThreads, n => (profile.limits.maxParallelThreads = n))
      if (raw.limits.maxReviewCycles !== undefined) {
        warn('limits.maxReviewCycles', raw.limits.reviewRounds === undefined ? 'the 0.1 name of limits.reviewRounds: read as reviewRounds' : 'the 0.1 name of limits.reviewRounds, which is also set: ignored')
        if (raw.limits.reviewRounds === undefined) whole('maxReviewCycles', raw.limits.maxReviewCycles, n => (profile.limits.reviewRounds = n))
      }
      whole('reviewRounds', raw.limits.reviewRounds, n => (profile.limits.reviewRounds = n))
    }
  }
  if (raw.delivery !== undefined) {
    if (!isObject(raw.delivery)) warn('delivery', 'must be an object')
    else {
      for (const k of Object.keys(raw.delivery)) if (k !== 'mode' && k !== 'handoffToApp') warn(`delivery.${k}`, 'unknown key, ignored')
      if (raw.delivery.mode !== undefined) oneOf(DELIVERY_MODES, raw.delivery.mode) ? (profile.delivery.mode = raw.delivery.mode) : warn('delivery.mode', `one of ${DELIVERY_MODES.join(', ')}`)
      const h = raw.delivery.handoffToApp
      if (h !== undefined) typeof h === 'boolean' ? (profile.delivery.handoffToApp = h) : warn('delivery.handoffToApp', 'must be true or false')
    }
  }
  if (raw.notify !== undefined) {
    if (!isObject(raw.notify)) warn('notify', 'must be an object')
    else {
      for (const k of Object.keys(raw.notify)) if (!['toast', 'quiet', 'command'].includes(k)) warn(`notify.${k}`, 'unknown key, ignored')
      for (const k of ['toast', 'quiet'] as const) {
        const v = raw.notify[k]
        if (v !== undefined) typeof v === 'boolean' ? (profile.notify[k] = v) : warn(`notify.${k}`, 'must be true or false')
      }
      const c = raw.notify.command
      if (c !== undefined && c !== null) warn('notify.command', MOVED_TO_SETTINGS)
    }
  }
  return { profile, warnings, source: 'file' }
}

/** A role's settings. */
export function roleAt(profile: Profile, name: ForemanRole): RoleConfig {
  return profile.roles[name]
}

/** Every gate the profile declares, in order. */
export function profileGates(profile: Profile): string[] {
  return Object.values(profile.gates).flat()
}

/** The profile /foreman init writes: version 2 and the gates found in the repo; every other key keeps its default. */
export function initialProfile(gates: readonly string[]): Record<string, unknown> {
  return { version: 2, gates: gates.length ? { checks: [...gates] } : {} }
}
