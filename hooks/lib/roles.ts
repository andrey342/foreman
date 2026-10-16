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
  /** Gates found in the repo, used when the profile declares none (D-73); the reviewer runs them. */
  detectedGates?: readonly string[]
}

/** The line every message to a thread ends with: the rules and the result block (review C-05). */
export const TELL_SUFFIX = '(Rules as before: no push, pull request or merge, foreman\'s delivery step does that. When you finish, end your turn with the foreman-result block.)'

/** The end of a message to a thread: where its part and its notes are, when it works on a plan, then the rules (TELL_SUFFIX). */
export function tellSuffix(o: { part?: string; plan?: string; brief?: string; progress?: string }): string {
  const where = [o.part && o.plan ? `you work on part ${o.part} of the plan \`${o.plan}\`` : '', o.brief ? `your brief is \`${o.brief}\`` : '', o.progress ? `foreman's notes are in \`${o.progress}\`` : ''].filter(Boolean)
  return where.length ? `(${where.join('; ')}.)\n${TELL_SUFFIX}` : TELL_SUFFIX
}

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

/**
 * The gates the reviewer runs, as its brief names them: exactly the commands
 * its `--allowedTools` lets it run (D-73), one per line.
 */
export function reviewerGatesText(commands: readonly string[]): string {
  return commands.length
    ? commands.map(c => `- \`${c}\``).join('\n')
    : '- None declared or found here: judge the diff and the criteria by reading; run no build and no test.'
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
    gates: role === 'reviewer' ? reviewerGatesText(gateCommands(profile, v.detectedGates)) : gatesText(profile, v.detectedGates),
    extra: rc.extra ? `## Notes for this repo\n\n${rc.extra}` : '',
  })
  const tail = common.map(c => c.trim()).filter(Boolean).join('\n\n')
  return `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n${tail ? `\n${tail}\n` : ''}`
}
