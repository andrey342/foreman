// Where a plan works (D-71): in its own worktree and branch by default, on a
// branch in the person's checkout, or in the checkout as it is. Pure: the
// paths, the branch name the repo's rules ask for, the line the person's
// `.git/info/exclude` gets, and the git argv; register.tsx runs them.

import { normPath } from './agents'
import { joinWith, sepOf } from './storage'

export type Isolation = 'worktree' | 'branch' | 'none'

/** foreman's worktrees, under the repo's main tree. */
const WORKTREES = ['.claude', 'worktrees'] as const

/** A plan's worktree: `<repo>/.claude/worktrees/foreman-<slug>`. */
export function worktreePath(repo: string, slug: string): string {
  return joinWith(sepOf(repo), repo, ...WORKTREES, `foreman-${slug}`)
}

/** Whether a folder is one of foreman's plan worktrees of this repo (or inside one). */
export function inPlanWorktree(path: string, repo: string): boolean {
  return normPath(path).startsWith(`${normPath(repo)}/.claude/worktrees/foreman-`)
}

/** The line the person's `.git/info/exclude` gets, so their `git status` never lists foreman's worktrees. */
export const EXCLUDE_LINE = '/.claude/worktrees/'

/** The exclude file with foreman's line added; undefined when it is there already. */
export function withExclude(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\r?\n/)
  if (lines.some(l => l.trim() === EXCLUDE_LINE || l.trim() === '.claude/worktrees/' || l.trim() === '/.claude/worktrees')) return undefined
  const body = (text ?? '').replace(/\s+$/, '')
  return `${body ? `${body}\n` : ''}# foreman's plan worktrees (D-71)\n${EXCLUDE_LINE}\n`
}

/** Branch prefixes a repo's rules commonly name; others are paths more often than branches (`test/`, `src/`). */
const PREFIX_WORDS = ['feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'docs', 'refactor', 'perf', 'task', 'topic']
const PREFIX_RE = new RegExp(String.raw`(?:^|[^\w/])(${PREFIX_WORDS.join('|')})/`, 'gi')

/** The branch prefixes the repo's rules name, on the lines that speak of branches, in the order they appear. */
export function branchPrefixes(texts: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md']) {
    for (const line of (texts[name] ?? '').split(/\r?\n/)) {
      if (!/\b(?:branch(?:es)?|ramas?)\b/i.test(line)) continue
      for (const m of line.matchAll(PREFIX_RE)) {
        const p = `${(m[1] as string).toLowerCase()}/`
        if (!out.includes(p)) out.push(p)
      }
    }
  }
  return out
}

/** The prefix when the rules name none (D-71). */
export const DEFAULT_PREFIX = 'foreman/'

/**
 * The plan's branch: the prefix the rules ask for (the fixing one for a plan
 * whose title fixes, the feature one for one that adds, else the first they
 * name), `foreman/` when they name none; then the plan's slug.
 */
export function branchFor(prefixes: readonly string[], title: string, slug: string): string {
  const pick = (re: RegExp, words: string[]) => (re.test(title) ? prefixes.find(p => words.includes(p.slice(0, -1))) : undefined)
  // whole words: "fixture", "address" and "news" are not "fix", "add" and "new" (O-3 of the Phase 4 review)
  const prefix = pick(/\b(?:fix|fixes|fixed|bug|bugs|repair|repairs|correct|corrects)\b/i, ['fix', 'bugfix', 'hotfix'])
    ?? pick(/\b(?:add|adds|added|new|feature|features|implement|implements|support|supports)\b/i, ['feat', 'feature'])
    ?? prefixes[0]
    ?? DEFAULT_PREFIX
  return `${prefix}${slug}`
}

/** A branch name not taken yet: `name`, else `name-2`, `name-3`… */
export function freeBranch(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  for (let i = 2; i < 100; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`
  return `${name}-${Date.now()}`
}

/**
 * The isolation a plan runs with: the profile's, except a worktree in a repo
 * with submodules or compose services, which runs on a branch in the checkout
 * instead (a fresh worktree lacks the submodules' checkouts, and services may
 * be tied to the checkout's path); `go`'s dialog says so.
 */
export function isolationFor(profile: Isolation, d: { submodules: boolean; services: boolean }): { isolation: Isolation; why?: string } {
  if (profile !== 'worktree' || (!d.submodules && !d.services)) return { isolation: profile }
  const what = d.submodules ? 'submodules' : 'compose files whose services may be tied to this checkout\'s path'
  return { isolation: 'branch', why: `this repo has ${what}, which a fresh worktree would lack: the plan runs on its own branch in this checkout instead` }
}

/** The git commands, as argv: exact, and none of them forces, deletes or mirrors. */
export const gitArgv = {
  worktreeAdd: (path: string, branch: string, base: string) => ['git', 'worktree', 'add', '-b', branch, path, base],
  /** No `--force`: a worktree with changes not committed stays, and the person is told. */
  worktreeRemove: (path: string) => ['git', 'worktree', 'remove', path],
  switchCreate: (branch: string) => ['git', 'switch', '-c', branch],
  switchTo: (branch: string) => ['git', 'switch', branch],
  branchExists: (branch: string) => ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
  currentBranch: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
  defaultRemoteBranch: ['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'],
  /** Changes to tracked files; untracked files do not stop a branch switch or a merge. */
  dirty: ['git', 'status', '--porcelain', '--untracked-files=no'],
  /** A merge left half done (MERGE_HEAD), and the way back to the checkout as it was (H-1 of the Phase 4 review). */
  mergeHead: ['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
  mergeAbort: ['git', 'merge', '--abort'],
} as const
