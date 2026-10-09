// Briefs per role (plan §7): a template from prompts/ filled from the profile
// and the command, plus the foreman-result contract for every thread.

import type { ForemanLevel, ForemanRole } from '../../types'
import type { Profile } from './profile'
import { roleAt } from './profile'

export type BriefVars = {
  task: string
  plan?: string
  part?: string
  level?: ForemanLevel
  runId?: string
  reviewFile?: string
  base?: string
  /** The skills to name, when the caller checked which exist (D8); the role's own otherwise. */
  skills?: readonly string[]
}

/** The line `/foreman tell` adds to every message: the rules and the result block (review C-05). */
export const TELL_SUFFIX = '(Rules as before: no push, pull request or merge unless your assignment says so in writing. When you finish, end your turn with the foreman-result block.)'

/** Replaces each `{{name}}`; an unset name becomes `-`, an empty one nothing; never the braces. */
export function fill(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name]
    return v === undefined ? '-' : v
  })
}

/** The template a role's brief starts from: its own file, or free.md. */
export function templateName(role: ForemanRole): string {
  return ['implementer', 'planner', 'qa', 'reviewer', 'critic', 'triage'].includes(role) ? `${role}.md` : 'free.md'
}

/** Splits the profile's skills into those the session lists and the rest (D8: omitted, with a warning). */
export function checkSkills(wanted: readonly string[], known: ReadonlySet<string> | undefined): { kept: string[]; missing: string[] } {
  if (!known) return { kept: [...wanted], missing: [] }
  const has = (name: string) => known.has(name) || [...known].some(k => k.endsWith(`:${name}`))
  return { kept: wanted.filter(has), missing: wanted.filter(w => !has(w)) }
}

export function gatesText(profile: Profile): string {
  const all = Object.entries(profile.gates).flatMap(([name, cmds]) => cmds.map(c => `\`${c}\` (${name})`))
  return all.length ? all.join(', ') : 'none declared; use the repo\'s own'
}

/** The whole brief: the role's template, filled, then the rules every thread gets and the result contract. */
export function composeBrief(template: string, common: readonly string[], profile: Profile, role: ForemanRole, v: BriefVars): string {
  const rc = roleAt(profile, role, v.level)
  const body = fill(template, {
    task: v.task,
    plan: v.plan,
    part: v.part,
    level: v.level,
    runId: v.runId,
    runsDir: profile.runsDir,
    reviewFile: v.reviewFile,
    base: v.base,
    skills: (v.skills ?? rc.skills).length ? (v.skills ?? rc.skills).join(', ') : 'none',
    gates: gatesText(profile),
    extra: rc.extra ? `## Notes for this repo\n\n${rc.extra}` : '',
  })
  const tail = common.map(c => c.trim()).filter(Boolean).join('\n\n')
  return `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${tail}\n`
}
