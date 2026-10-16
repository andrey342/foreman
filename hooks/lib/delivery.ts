// The delivery of a finished plan (D-72), done by code, never by a model:
// which mode it gets once the facts are in (the profile's, lowered when the
// repo, `gh` or the isolation cannot carry it), and the exact argv of each
// step. Nothing here forces, deletes, mirrors or merges on a remote. Pure:
// register.tsx runs the steps and records them.

import type { Isolation } from './isolation'

export type DeliveryMode = 'pr' | 'merge' | 'branch' | 'none'

export type DeliveryFacts = {
  /** The profile's `delivery.mode`. */
  mode: DeliveryMode
  isolation: Isolation
  /** The plan's branch; none with isolation `none`. */
  branch?: string
  /** The branch the plan started from, for a pull request's base and a merge's target. */
  base?: string
  /** The repo has an `origin` remote. */
  remote: boolean
  /** `gh auth status` answered 0; undefined when it was not asked (not a `pr`). */
  gh?: boolean
  /** Why the repo's rules want a person before anything is published, when they do (detect.ts). */
  humanGate?: string
}

/** The mode the plan is delivered with, and why it is not the profile's when it is not. */
export function deliveryMode(f: DeliveryFacts): { mode: DeliveryMode; note?: string } {
  if (f.mode === 'none') return { mode: 'none' }
  if (f.isolation === 'none' || !f.branch) return { mode: 'none', ...(f.mode !== 'branch' ? { note: `delivery "${f.mode}" needs the plan's own branch, and isolation "none" makes none: the commits stay where they are` } : {}) }
  if (f.mode === 'branch') return { mode: 'branch' }
  if (f.humanGate) return { mode: 'branch', note: `the repo's rules ask a person before publishing (${f.humanGate}): the branch is left for them` }
  if (f.mode === 'pr') {
    if (!f.remote) return { mode: 'branch', note: 'delivery "pr" needs an origin remote, and this repo has none: the branch is left as it is' }
    if (f.gh === false) return { mode: 'branch', note: '`gh` is missing or not signed in (`gh auth status`): the branch is left as it is, and no pull request is opened' }
    if (!f.base) return { mode: 'branch', note: 'the plan started on no branch (a detached HEAD): there is no base for a pull request' }
    return { mode: 'pr' }
  }
  if (!f.base) return { mode: 'branch', note: 'the plan started on no branch (a detached HEAD): there is nothing to merge into' }
  return { mode: 'merge' }
}

/** One step of a delivery: its argv, and where it runs (the person's checkout, the main tree). */
export type DeliveryStep = { argv: string[] }

/** `gh auth status`: the preflight of a `pr` delivery (M3). */
export const GH_PREFLIGHT = ['gh', 'auth', 'status'] as const

/** The steps of a delivery, exactly as D-72 writes them. A `merge` runs in the person's checkout, on the plan's base branch. */
export function deliverySteps(mode: DeliveryMode, o: { branch?: string; base?: string; title: string; report: string }): DeliveryStep[] {
  if (!o.branch || !o.base) return []
  // a title that starts with "-" would read as a flag to gh
  const title = o.title.trim().replace(/^-+/, '').slice(0, 200) || o.branch
  switch (mode) {
    case 'pr': return [
      { argv: ['git', 'push', '-u', 'origin', o.branch] },
      { argv: ['gh', 'pr', 'create', '--base', o.base, '--head', o.branch, '--title', title, '--body-file', o.report] },
    ]
    case 'merge': return [{ argv: ['git', 'merge', '--no-ff', o.branch] }]
    default: return []
  }
}

/** Flags no delivery ever builds (D-72). */
export const NEVER_FLAGS = ['--force', '-f', '--force-with-lease', '--delete', '-d', '-D', '--mirror'] as const

/** The pull request's URL in `gh pr create`'s output. */
export function prUrl(out: string): string | undefined {
  return /https?:\/\/\S+\/pull\/\d+/.exec(out)?.[0]
}

/** A finished plan in words, by its delivery: the pane's status line and the chat's notice. */
export function deliveredWords(d: { mode: DeliveryMode; state: 'pending' | 'delivered' | 'failed'; url?: string; reason?: string }, branch?: string): string {
  if (d.state === 'pending') return 'delivering'
  if (d.state === 'failed') return `not delivered: ${d.reason ?? 'the delivery failed'}`
  switch (d.mode) {
    case 'pr': return `pull request ${d.url ?? 'opened'}`
    case 'merge': return `merged ${branch ? `\`${branch}\` ` : ''}into its base`
    case 'branch': return branch ? `on branch \`${branch}\`` : 'its commits are where they were made'
    default: return 'its commits are where they were made'
  }
}
