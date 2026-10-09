// What a reviewer or critic subagent that foreman started may do (plan §8,
// review C-17). Pure: register.tsx resolves paths and applies the verdict in
// a `tool.call` hook whose `.catch` refuses.
//
// - Edit, MultiEdit and NotebookEdit: never.
// - Write: only to a file under the run's folder (checked on the real path).
// - Bash and PowerShell: only commands made of read-only programs, with no
//   redirection, substitution, script block or environment assignment.
// - Any other tool outside the role's own `tools` list: refused.

import { splitWords } from './args'

export const NEVER = ['Edit', 'MultiEdit', 'NotebookEdit']
export const SHELLS = ['Bash', 'PowerShell']

/** git subcommands that only read. */
const GIT_READ = ['diff', 'log', 'show', 'status', 'rev-parse', 'ls-files', 'blame', 'merge-base', 'describe', 'cat-file', 'grep', 'shortlog', 'rev-list', 'ls-tree', 'name-rev', 'for-each-ref', 'whatchanged', 'version']
/** git options that write a file or run another program. */
const GIT_BAD_ARG = /^(?:--output|--ext-diff|-O|--open-files-in-pager|--exec|--upload-pack|--receive-pack)/

/** Programs that only read (their writing options are refused below). */
const READ_PROGRAMS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'find', 'sort', 'uniq', 'cut', 'diff', 'file', 'stat',
  'pwd', 'echo', 'which', 'where', 'tree', 'du', 'basename', 'dirname', 'realpath', 'jq', 'less', 'more', 'nl', 'comm', 'true',
  // PowerShell cmdlets and aliases (compared in lower case)
  'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'get-item', 'gi', 'test-path', 'resolve-path', 'measure-object',
  'select-object', 'sort-object', 'format-table', 'format-list', 'get-location', 'gl', 'get-filehash', 'write-output', 'out-string', 'get-itemproperty',
])
/** Options of those programs that write, execute or preprocess. */
const BAD_ARG: Record<string, RegExp> = {
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(?:=|$)/,
  sort: /^(?:-o|--output)/,
  tail: /^(?:-f|--follow)/,
}

/** Characters that redirect, substitute, background or open a script block. */
const BAD_SYNTAX: { re: RegExp; why: string }[] = [
  { re: /[<>]/, why: 'redirection' },
  { re: /\$\(|`/, why: 'command substitution' },
  { re: /[{}]/, why: 'a script block or brace expansion' },
  { re: /(^|[^&])&(?!&)/, why: 'a background or call operator' },
]

/** Splits a command line at `&&`, `||`, `|`, `;` and newlines outside quotes. */
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      cur += c
      if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '|' || c === ';' || c === '\n' || (c === '&' && command[i + 1] === '&')) {
      if (c === '&' || (c === '|' && command[i + 1] === '|')) i++
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Redirections that only silence or merge stderr: they write nowhere a reviewer could harm. */
const HARMLESS_REDIRECT = /\s2>\s*(?:\/dev\/null|nul|\$null|&1)(?=\s|$)/gi

/** Why a shell command is refused for a reviewer, or undefined when it only reads. */
export function shellVerdict(command: string): string | undefined {
  command = command.replace(HARMLESS_REDIRECT, ' ')
  for (const b of BAD_SYNTAX) if (b.re.test(command)) return `${b.why} is not allowed; reviewers run read-only commands`
  for (const seg of segments(command)) {
    const words = splitWords(seg)
    const first = words[0]
    if (first === undefined) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return `environment assignments (${first.split('=')[0]}=…) are not allowed`
    const prog = (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/i, '').toLowerCase()
    const args = words.slice(1)
    if (prog === 'git') {
      const v = gitVerdict(args)
      if (v) return v
      continue
    }
    if (!READ_PROGRAMS.has(prog)) return `\`${prog}\` is not on the reviewer's read-only list`
    const bad = BAD_ARG[prog]
    const hit = bad ? args.find(a => bad.test(a)) : undefined
    if (hit) return `\`${prog} ${hit}\` writes or runs something`
  }
  return undefined
}

function gitVerdict(args: string[]): string | undefined {
  let i = 0
  // global options before the subcommand: -C <dir> and --no-pager only (-c could set a pager or a hook)
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const a = args[i] as string
    if (a === '-C') { i += 2; continue }
    if (a === '--no-pager' || a === '--no-optional-locks') { i += 1; continue }
    return `\`git ${a}\` is not allowed before the subcommand`
  }
  const sub = args[i]
  if (sub === undefined) return '`git` needs a read-only subcommand'
  if (!GIT_READ.includes(sub)) return `\`git ${sub}\` is not a read-only git command`
  const hit = args.slice(i + 1).find(a => GIT_BAD_ARG.test(a))
  if (hit) return `\`git ${sub} ${hit}\` writes or runs something`
  return undefined
}

/**
 * Where a Write may land, by spelling alone, before the file system is asked
 * (the d.ts's `placed` rule): no drive-relative path, no network or device
 * path, a real file name. Returns the folder to resolve and the name, or why not.
 */
export function placeable(path: string): { folder: string; name: string } | { why: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(cut + 1)
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return { why: 'a drive-relative path' }
  if (/^[\\/][\\/]/.test(path)) return { why: 'a network or device path' }
  if (/^[A-Za-z]:/.test(name) || name === '' || name === '.' || name === '..') return { why: 'not a file name' }
  return { folder: cut < 0 ? '.' : path.slice(0, cut + 1), name }
}

export type GuardCall = { tool: string; file_path?: unknown; command?: unknown }

/** The first decision, before any path is resolved: deny, allow, or `write` (resolve and check), `shell` already judged. */
export function judge(call: GuardCall, allowedTools: readonly string[]): { deny: string } | { allow: true } | { write: string } {
  const tool = call.tool
  if (NEVER.includes(tool)) return { deny: `${tool} is not allowed for a foreman reviewer: it reads and writes only its review file` }
  if (!allowedTools.includes(tool)) return { deny: `${tool} is not among this reviewer's tools (${allowedTools.join(', ')})` }
  if (tool === 'Write') {
    if (typeof call.file_path !== 'string') return { deny: 'Write without a file path' }
    return { write: call.file_path }
  }
  if (SHELLS.includes(tool)) {
    if (typeof call.command !== 'string') return { deny: `${tool} without a command` }
    const why = shellVerdict(call.command)
    return why ? { deny: why } : { allow: true }
  }
  return { allow: true }
}
