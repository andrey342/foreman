// Where foreman keeps a plan's files (D-70): `<git common dir>/foreman/<slug>/`
// by default (inside the repo's folder, invisible to `git status`), a repo's
// own `runsDir` when its profile names one, and `~/.claude/foreman/<slug>/`
// outside git. Pure: register.tsx asks git and the environment.

/** The files of one plan's folder. */
export const PLAN_FILES = {
  record: 'foreman.json',
  progress: 'progress.md',
  decisions: 'decisions.jsonl',
  report: 'report.md',
} as const

export const briefFile = (part: string) => `brief-${part}.md`
export const reviewFile = (part: string, n: number) => `review-${part}-r${n}.md`

/** The separator a path already uses: a backslash for a Windows path, `/` otherwise. */
export function sepOf(p: string): string {
  return /^[A-Za-z]:/.test(p) || p.includes('\\') ? '\\' : '/'
}

/** `root` and `parts` joined with `sep`, every `/` or `\` in them turned into `sep`, no doubled separators. */
export function joinWith(sep: string, root: string, ...parts: string[]): string {
  const norm = (s: string) => s.split(/[\\/]+/).filter(Boolean).join(sep)
  const head = root.replace(/[\\/]+$/, '').split(/[\\/]/).join(sep)
  const tail = parts.map(norm).filter(Boolean).join(sep)
  return tail ? `${head}${sep}${tail}` : head
}

export type StorageInput = {
  /** The session's checkout (where a repo's own `runsDir` is read). */
  work: string
  /** `git rev-parse --path-format=absolute --git-common-dir`, when the work is in a git repository. */
  gitCommonDir?: string
  /** The profile's `runsDir`, relative to the work root, when it sets one. */
  runsDir?: string
  /** The person's home folder, for a folder outside git. */
  home?: string
}

export type Storage = { kind: 'git' | 'runsDir' | 'home'; base: string }

/**
 * The folder that holds every plan's folder. `base` uses the separators of the
 * work root (git prints `/` even on Windows; D-70 normalises them).
 */
export function storageOf(s: StorageInput): Storage | undefined {
  const sep = sepOf(s.work)
  if (s.runsDir) return { kind: 'runsDir', base: joinWith(sep, s.work, s.runsDir) }
  if (s.gitCommonDir) return { kind: 'git', base: joinWith(sep, s.gitCommonDir, 'foreman') }
  if (s.home) return { kind: 'home', base: joinWith(sepOf(s.home), s.home, '.claude', 'foreman') }
  return undefined
}

/** One plan's folder. */
export function planDir(storage: Storage, slug: string): string {
  return joinWith(sepOf(storage.base), storage.base, slug)
}

/** A file of a plan's folder. */
export function planFile(dir: string, name: string): string {
  return joinWith(sepOf(dir), dir, name)
}

/** The plan folder of the ad hoc work (a launch or a review with no plan). */
export const ADHOC = 'adhoc'
