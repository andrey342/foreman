// `/foreman setup` (D-74): what foreman finds in a repo, the questions it asks
// about it (at most three: the delivery, the isolation when there are
// submodules, whether to write), and the profile it writes, holding only the
// keys that differ from the defaults. Pure: register.tsx asks and writes.

import type { Detected } from './detect'
import { branchFor } from './isolation'
import type { Isolation } from './isolation'
import type { DeliveryMode } from './delivery'
import { defaultProfile } from './profile'
import type { Profile } from './profile'

/** What a setup settles: the delivery and the isolation a plan gets. */
export type SetupChoices = { delivery: DeliveryMode; isolation: Isolation }

/** One question of the dialog: its text, and the value each answer stands for. */
export type SetupQuestion<V> = { text: string; answers: readonly { label: string; value: V }[] }

/** The delivery question, when the repo's rules ask for pull requests and the profile still leaves the branch. */
export function deliveryQuestion(d: Detected, p: Profile): SetupQuestion<DeliveryMode> | undefined {
  if (d.delivery.mode !== 'pr' || d.humanGate || p.delivery.mode !== 'branch') return undefined
  return {
    text: `This repo's rules ask for pull requests (${d.delivery.why}). How should foreman deliver a finished plan?`,
    answers: [
      { label: 'Open a pull request', value: 'pr' },
      { label: 'Leave the branch', value: 'branch' },
      { label: 'Merge it here', value: 'merge' },
    ],
  }
}

/** The isolation question, when submodules or compose services make a worktree a poor fit and the profile still asks for one. */
export function isolationQuestion(d: Detected, p: Profile): SetupQuestion<Isolation> | undefined {
  if ((!d.submodules && !d.services) || p.isolation !== 'worktree') return undefined
  const what = d.submodules ? 'submodules' : 'compose files whose services may be tied to this checkout\'s path'
  return {
    text: `This repo has ${what}, which a fresh worktree would lack. Where should a plan work?`,
    answers: [
      { label: 'On its own branch here', value: 'branch' },
      { label: 'In its own worktree', value: 'worktree' },
      { label: 'In this checkout as it is', value: 'none' },
    ],
  }
}

/** The choices before any answer: the profile's, with what the repo's rules and layout make safe. */
export function proposedChoices(d: Detected, p: Profile): SetupChoices {
  const delivery: DeliveryMode = p.delivery.mode !== 'branch' ? p.delivery.mode : d.delivery.mode === 'pr' && !d.humanGate ? 'pr' : 'branch'
  const isolation: Isolation = p.isolation === 'worktree' && (d.submodules || d.services) ? 'branch' : p.isolation
  return { delivery, isolation }
}

/**
 * The profile to write: the file's own keys as they are, the choices over
 * them, and nothing a choice leaves at foreman's default. Undefined when
 * nothing would differ from the defaults: no profile is needed.
 */
export function setupProfile(existing: Record<string, unknown> | undefined, c: SetupChoices): Record<string, unknown> | undefined {
  const d = defaultProfile()
  const out: Record<string, unknown> = { ...(existing ?? {}) }
  delete out.mode
  const delivery = { ...((out.delivery as Record<string, unknown> | undefined) ?? {}) }
  if (c.delivery !== d.delivery.mode) delivery.mode = c.delivery
  else delete delivery.mode
  if (Object.keys(delivery).length) out.delivery = delivery
  else delete out.delivery
  if (c.isolation !== d.isolation) out.isolation = c.isolation
  else delete out.isolation
  const keys = Object.keys(out).filter(k => k !== 'version')
  if (keys.length === 0) return undefined
  return { version: 2, ...out }
}

type Json = Record<string, unknown>
const isPlain = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The leaves of a profile by dotted path, without what changes nothing: `version`, and a `mode` of "auto" (review S-2). */
function leaves(o: Json | undefined, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [k, v] of Object.entries(o ?? {})) {
    if (prefix === '' && (k === 'version' || (k === 'mode' && v === 'auto'))) continue
    if (isPlain(v)) for (const [p, x] of leaves(v, `${prefix}${k}.`)) out.set(p, x)
    else out.set(`${prefix}${k}`, v)
  }
  return out
}

/** The value at a dotted path of the defaults, if it is one. */
function defaultAt(path: string): unknown {
  let v: unknown = defaultProfile()
  for (const k of path.split('.')) v = isPlain(v) ? v[k] : undefined
  return v
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const shown = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? 'nothing').slice(0, 60)

/**
 * What writing `next` over the file's `existing` content changes, a line each
 * ("delivery.mode: pr, was branch"), compared by content: key order,
 * `version` and a `mode` of "auto" are no change (review S-1, S-2). Empty:
 * nothing to write.
 */
export function profileChanges(existing: Json | undefined, next: Json | undefined): string[] {
  const before = leaves(existing)
  const after = leaves(next)
  const lines: string[] = []
  for (const [path, v] of after) {
    if (before.has(path) && same(before.get(path), v)) continue
    const was = before.has(path) ? before.get(path) : defaultAt(path)
    lines.push(`${path}: ${shown(v)}${was !== undefined && !isPlain(was) ? `, was ${shown(was)}` : ''}`)
  }
  for (const [path, v] of before) {
    if (after.has(path)) continue
    const d = defaultAt(path)
    lines.push(d !== undefined && !isPlain(d) ? `${path}: ${shown(d)} (the default), was ${shown(v)}` : `${path}: removed, was ${shown(v)}`)
  }
  return lines
}

/** What setup found, a line each, for `--show` and its answer. */
export function setupLines(d: Detected, p: Profile, slug = 'plan-slug'): string[] {
  const branch = p.isolation === 'none' ? 'none (isolation "none")' : `\`${branchFor(d.prefixes, 'a plan', slug)}\`${d.prefixes.length ? ` (the rules name ${d.prefixes.map(x => `\`${x}\``).join(', ')})` : ' (the rules name no prefix: foreman/)'}`
  return [
    `Stack: ${d.stacks.length ? d.stacks.join(', ') : 'none found'}.`,
    `Gates: ${d.gates.length ? d.gates.map(g => `\`${g}\``).join(', ') : 'none found: each review judges the diff and the plan\'s criteria'}.`,
    `Install in a fresh worktree: ${d.install ? `\`${d.install}\`` : 'nothing'}.`,
    `The repo's own rules: ${d.rules.length ? d.rules.join(', ') : 'none'}.`,
    `Submodules or compose services: ${d.submodules || d.services ? [d.submodules ? 'submodules' : '', d.services ? 'compose files' : ''].filter(Boolean).join(' and ') : 'none'}.`,
    `Where a plan works: ${p.isolation === 'worktree' ? 'its own worktree, under .claude/worktrees/' : p.isolation === 'branch' ? 'its own branch, in this checkout' : 'this checkout, on its current branch'}; branch ${branch}.`,
    `Delivery: ${p.delivery.mode}${d.delivery.mode !== p.delivery.mode ? ` (the rules suggest ${d.delivery.mode}: ${d.delivery.why})` : ''}${d.humanGate ? `; the rules ask a person before publishing (${d.humanGate})` : ''}.`,
  ]
}

/** `docs/plans/TEMPLATE.md`: the parts, the criteria and a pause, as foreman reads them (D-76). */
export const PLAN_TEMPLATE = `# <What this plan does>

One or two lines on the goal. foreman runs the parts below in order, each in its own background thread, reviewed until OK.

## Part A — <first piece of work>

What to do, in plain words: the files, the behaviour, what is already decided (a thread asks when something is open, and foreman's supervisor answers from what is written here).

**Acceptance**
- A check a reviewer can run or read (a test passes, a command prints something).
- Another one.

## Part B — <next piece>

What to do.

**Acceptance**
- …

## Pause before part C

Write a heading or a line that starts with "Pause" where a person must look before foreman goes on: the plan waits there, and the pane shows Continue.

## Part C — <last piece>

What to do.

**Acceptance**
- …
`
