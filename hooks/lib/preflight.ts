// The checks `go` makes before it writes or launches anything (M3): one
// message that names everything missing, instead of a part that breaks half
// way ("Workspace not trusted" after the brief is written). Pure: register.tsx
// gathers the facts.

/** What stops `go` here (problems), and what it says without stopping (notes). */
export type Preflight = { problems: string[]; notes: string[] }

/**
 * Claude Code's trust of a folder, read from its global config's `projects`:
 * the folder, or a folder above it, with `hasTrustDialogAccepted`. A
 * background thread cannot show the trust prompt, so an untrusted folder
 * fails it at launch. `unknown` when the config cannot be read.
 */
export function trustOf(configText: string | undefined, work: string): 'trusted' | 'untrusted' | 'unknown' {
  if (configText === undefined) return 'unknown'
  let projects: unknown
  try {
    projects = (JSON.parse(configText) as { projects?: unknown }).projects
  } catch {
    return 'unknown'
  }
  if (typeof projects !== 'object' || projects === null) return 'unknown'
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const accepted = new Set(
    Object.entries(projects as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'object' && v !== null && (v as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true)
      .map(([k]) => norm(k)),
  )
  let p = norm(work)
  while (p !== '') {
    if (accepted.has(p)) return 'trusted'
    const i = p.lastIndexOf('/')
    if (i <= 0) break
    p = p.slice(0, i)
  }
  return 'untrusted'
}

/** The one answer `go` gives when something is missing; undefined when nothing is. */
export function preflightMessage(p: Preflight, plan: string): string | undefined {
  if (p.problems.length === 0) return undefined
  return [`Not started: /foreman go ${plan} needs`, ...p.problems.map(x => `- ${x}`), ...(p.notes.length ? ['Also:', ...p.notes.map(x => `- ${x}`)] : [])].join('\n')
}
