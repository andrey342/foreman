// What a reviewer or critic subagent that foreman started may do (plan §8,
// review C-17 and C3-01..05). Pure: register.tsx resolves paths and applies
// the verdict in a `tool.call` hook whose `.catch` refuses.
//
// - Edit, MultiEdit and NotebookEdit: never.
// - Write: only to a file under the run's folder (checked on the real path).
// - Bash (and PowerShell, when a profile adds it): only command lines whose
//   every segment starts with a bare program name from a short read-only
//   list, with no redirection, substitution, subshell, script block,
//   expression or environment assignment outside single quotes.
// - Any other tool outside the role's own `tools` list: refused.

import { splitWords } from './args'

export const NEVER = ['Edit', 'MultiEdit', 'NotebookEdit']
export const SHELLS = ['Bash', 'PowerShell']
export type Shell = 'Bash' | 'PowerShell'

/** git subcommands that only read. */
const GIT_READ = ['diff', 'log', 'show', 'status', 'rev-parse', 'ls-files', 'blame', 'merge-base', 'describe', 'cat-file', 'grep', 'shortlog', 'rev-list', 'ls-tree', 'name-rev', 'for-each-ref', 'whatchanged', 'version']
/** git options that write a file or run another program. */
const GIT_BAD_ARG = /^(?:--output|--ext-diff|-O|--open-files-in-pager|--exec|--upload-pack|--receive-pack)/

/**
 * The programs a reviewer may start, by their bare name (no path, no `.exe`
 * stripped: `sort.exe` is not `sort`), compared in lower case. Kept short on
 * purpose (review C3-02): every name here was checked for options that write
 * or run another program, and those options are refused below.
 */
const READ_PROGRAMS = new Set([
  'git', 'rg', 'grep', 'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'find', 'stat', 'diff',
  // PowerShell cmdlets and their aliases, for a profile that gives a reviewer PowerShell
  'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'test-path', 'resolve-path', 'get-location',
])
/** Options of those programs that write, execute, follow or preprocess. */
const BAD_ARG: Record<string, RegExp> = {
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^(?:--pre|--hostname-bin|--search-zip|-[A-Za-z]*z[A-Za-z]*$)/,
  tail: /^(?:--follow|-[A-Za-z0-9]*[fF])/,
}

/** Redirections that only silence or merge stderr: they write nowhere a reviewer could harm. */
const HARMLESS_REDIRECT = /\s2>\s*(?:\/dev\/null|nul|\$null|&1)(?=\s|$)/gi

/**
 * The first character, outside single quotes, that could write, run or
 * evaluate something, and why (review C3-01, C3-05). Single quotes are
 * literal in both shells; inside double quotes only `$` and the backtick
 * expand; outside quotes redirection, subshells, blocks and a lone `&` are
 * refused, and in PowerShell also `( ) [ ] @` (expressions, type literals,
 * splatting) and `$` (variables and `$(...)`).
 */
export function syntaxVerdict(command: string, shell: Shell): string | undefined {
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote === "'") {
      if (c === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '$' || c === '`') return `\`${c}\` expands inside double quotes; use single quotes`
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '<' || c === '>') return 'redirection is not allowed; reviewers run read-only commands'
    if (c === '`') return 'a backtick (substitution or escape) is not allowed'
    if (c === '$') return '`$` (a variable or a substitution) is not allowed outside single quotes'
    if (c === '(' || c === ')') return 'a subshell or an expression in parentheses is not allowed'
    if (c === '{' || c === '}') return 'a script block or brace expansion is not allowed'
    if (c === '&' && command[i + 1] !== '&' && command[i - 1] !== '&') return 'a background or call operator (`&`) is not allowed'
    if (shell === 'PowerShell' && (c === '[' || c === ']' || c === '@')) return `\`${c}\` (a type literal, an index or splatting) is not allowed in PowerShell`
  }
  return quote ? 'an unclosed quote' : undefined
}

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

/** Why a shell command is refused for a reviewer, or undefined when it only reads. */
export function shellVerdict(command: string, shell: Shell = 'Bash'): string | undefined {
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  const syntax = syntaxVerdict(line, shell)
  if (syntax) return syntax
  for (const seg of segments(line)) {
    const words = splitWords(seg)
    const first = words[0]
    if (first === undefined) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return `environment assignments (${first.split('=')[0]}=…) are not allowed`
    if (/[\\/]/.test(first)) return `\`${first}\`: a program given by its path is not allowed; name it bare`
    const prog = first.toLowerCase()
    const args = words.slice(1)
    if (!READ_PROGRAMS.has(prog)) return `\`${first}\` is not on the reviewer's read-only list`
    if (prog === 'git') {
      const v = gitVerdict(args)
      if (v) return v
      continue
    }
    const bad = BAD_ARG[prog]
    const hit = bad ? args.find(a => bad.test(a)) : undefined
    if (hit) return `\`${prog} ${hit}\` writes, follows or runs something`
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
    const why = shellVerdict(call.command, tool as Shell)
    return why ? { deny: why } : { allow: true }
  }
  return { allow: true }
}
