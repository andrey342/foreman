// Briefs per role (plan §7): a template from prompts/ filled from the plan,
// the profile and the command, plus the rules and the foreman-result contract
// every thread gets. The brief goes in a file; the thread's prompt points to it (D-69).

import type { ForemanRole } from '../../types'
import type { Profile } from './profile'
import { profileGates, roleAt } from './profile'

export type BriefVars = {
  task: string
  plan?: string
  part?: string
  partTitle?: string
  /** The part's section of the plan, as written. */
  partText?: string
  /** The part's acceptance criteria, one per entry (D-76); empty: the part's text decides. */
  criteria?: readonly string[]
  /** progress.md of the run (D-70): what foreman knows of the parts so far. */
  progress?: string
  reviewFile?: string
  base?: string
  /** The previous review of the same part, which this one checks was answered. */
  previous?: string
  /** The skills to name, when the caller checked which exist (D8); the role's own otherwise. */
  skills?: readonly string[]
  /** Gates found in the repo, used when the profile declares none (D-73). */
  detectedGates?: readonly string[]
}

/** The line every message to a thread ends with: the rules and the result block (review C-05). */
export const TELL_SUFFIX = '(Rules as before: no push, pull request or merge, foreman\'s delivery step does that. When you finish, end your turn with the foreman-result block.)'

/** The one-line prompt a thread starts or is resumed with: its brief is a file (D-69). */
export const readBrief = (path: string) => `Read and follow the brief in \`${path}\`. It is your assignment; the file is yours to read, not to edit.`

/** Replaces each `{{name}}`; an unset name becomes `-`, an empty one nothing; never the braces. */
export function fill(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name]
    return v === undefined ? '-' : v
  })
}

/** The template a role's brief starts from. */
export function templateName(role: ForemanRole): string {
  return `${role}.md`
}

/** Splits the profile's skills into those the session lists and the rest (D8: omitted, with a warning). */
export function checkSkills(wanted: readonly string[], known: ReadonlySet<string> | undefined): { kept: string[]; missing: string[] } {
  if (!known) return { kept: [...wanted], missing: [] }
  const has = (name: string) => known.has(name) || [...known].some(k => k.endsWith(`:${name}`))
  return { kept: wanted.filter(has), missing: wanted.filter(w => !has(w)) }
}

/** The gates a brief names: the profile's, else the ones found in the repo, else the repo's own. */
export function gatesText(profile: Profile, detected: readonly string[] = []): string {
  const declared = Object.entries(profile.gates).flatMap(([name, cmds]) => cmds.map(c => `\`${c}\` (${name})`))
  if (declared.length) return declared.join(', ')
  if (detected.length) return `${detected.map(c => `\`${c}\``).join(', ')} (found in the repo)`
  return 'none declared or found; use the repo\'s own checks'
}

/** The gates as commands (profile, else detected). */
export function gateCommands(profile: Profile, detected: readonly string[] = []): string[] {
  const declared = profileGates(profile)
  return declared.length ? declared : [...detected]
}

const criteriaText = (c: readonly string[] | undefined) =>
  c && c.length ? c.map(x => `- ${x}`).join('\n') : '- The plan names no acceptance criteria for this part: its text above is what the work is checked against.'

/** The whole brief: the role's template, filled, then the rules every thread gets and the result contract. */
export function composeBrief(template: string, common: readonly string[], profile: Profile, role: ForemanRole, v: BriefVars): string {
  const rc = roleAt(profile, role)
  const skills = v.skills ?? rc.skills
  const body = fill(template, {
    task: v.task,
    plan: v.plan,
    part: v.part,
    partTitle: v.partTitle,
    partText: v.partText !== undefined ? v.partText.trim() : undefined,
    criteria: criteriaText(v.criteria),
    progress: v.progress,
    reviewFile: v.reviewFile,
    base: v.base,
    previous: v.previous ?? 'none: this is the first review of the part',
    skills: skills.length ? skills.join(', ') : 'none',
    gates: gatesText(profile, v.detectedGates),
    extra: rc.extra ? `## Notes for this repo\n\n${rc.extra}` : '',
  })
  const tail = common.map(c => c.trim()).filter(Boolean).join('\n\n')
  return `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n${tail ? `\n${tail}\n` : ''}`
}

/** The subagent roles foreman registers as `foreman:<role>` (the reviewer, until Phase 4 makes it a process, D-84). */
export const SUBAGENT_ROLES = ['reviewer'] as const
export type SubagentRole = (typeof SUBAGENT_ROLES)[number]

const AGENT_DESCRIPTION: Record<SubagentRole, string> = {
  reviewer: 'foreman reviewer: a fresh, read-only code review of a plan part, written to one review file',
}

/** The tools a reviewer subagent gets: foreman's, not the profile's (D-78); its guard limits writes to its own file. */
export const REVIEWER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write'] as const

/** The agent type as foreman registers it: the role's system prompt from prompts/agents/, model and effort from the profile. */
export function agentSpec(role: SubagentRole, systemPrompt: string, profile: Profile, withSkills: boolean) {
  const rc = roleAt(profile, role)
  return {
    name: role,
    description: AGENT_DESCRIPTION[role],
    prompt: systemPrompt.trim(),
    tools: [...REVIEWER_TOOLS],
    model: rc.model,
    effort: rc.effort,
    // the role's mode (auto by default, as threads): the guard bounds what it may do, the mode spares
    // the person a dialog for each read-only command; a -p parent has nobody to answer one (D-35)
    permissionMode: rc.permissionMode,
    ...(withSkills && rc.skills.length ? { skills: [...rc.skills] } : {}),
  }
}
