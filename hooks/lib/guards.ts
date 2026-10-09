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
import type { Guard } from './profile'

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

// ---------------------------------------------------------------- the profile's guards (plan §8, Phase 5)
//
// Declared in .claude/foreman.json under `guards`, applied to every tool call
// of every session that loads foreman (the main chat, its subagents and
// foreman's own threads, D-51):
//   { "when": { "tool": "Edit|Write", "pathGlob": "**/*.cs" }, "requireToolCalledBefore": "mcp__gitnexus__impact", "mode": "warn" }
//   { "when": { "tool": "Bash", "commandRegex": "git\\s+add\\s+-A" }, "mode": "deny", "reason": "explicit paths" }
// A guard matches when every condition it names holds. With
// `requireToolCalledBefore` it holds the call only until that tool was called
// in the session; without, it applies to every matching call. `warn` lets the
// call run and tells the model and the person; `deny` refuses it.


/** A path glob as a regular expression: `**` any depth, `*` one segment's characters, `?` one; case-insensitive (Windows paths). */
export function globRe(glob: string): RegExp {
  let re = ''
  const g = glob.replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*' && g[i + 1] === '*') {
      // `**/` matches zero or more whole segments
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/** The path as the guard reads it: forward slashes, relative to the work root when it lies under it. */
export function relPath(path: string, work: string): string {
  const p = path.replace(/\\/g, '/')
  const w = work.replace(/\\/g, '/').replace(/\/+$/, '')
  if (p.toLowerCase().startsWith(w.toLowerCase() + '/')) return p.slice(w.length + 1)
  return p.replace(/^\.\//, '')
}

/** What a guard looks at in a call: the tool's name, the path it touches, the command it runs. */
export type GuardedCall = { tool: string; path?: string; command?: string }

/** The path and command a built-in tool's input carries, by its usual field names. */
export function callOf(tool: string, input: Record<string, unknown>): GuardedCall {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  const command = str('command')
  return { tool, ...(path !== undefined ? { path } : {}), ...(command !== undefined ? { command } : {}) }
}

const named = (pattern: string, name: string) => new RegExp(`^(?:${pattern})$`).test(name)

export function guardMatches(g: Guard, call: GuardedCall, work: string): boolean {
  if (shellWriteMatches(g, call, work)) return true
  const w = g.when
  if (w.tool === undefined && w.pathGlob === undefined && w.commandRegex === undefined) return false
  if (w.tool !== undefined && !named(w.tool, call.tool)) return false
  if (w.pathGlob !== undefined && (call.path === undefined || !globRe(w.pathGlob).test(relPath(call.path, work)))) return false
  if (w.commandRegex !== undefined && (call.command === undefined || !new RegExp(w.commandRegex).test(call.command))) return false
  return true
}

/** The profile's verdict on one call, given the tools the session called so far. */
export function evaluateGuards(guards: readonly Guard[], call: GuardedCall, called: ReadonlySet<string>, work: string): { deny?: string; warns: string[] } {
  const warns: string[] = []
  for (const g of guards) {
    if (!guardMatches(g, call, work)) continue
    const what = `${call.tool}${call.path ? ` on ${relPath(call.path, work)}` : ''}${call.command ? ` (${call.command.slice(0, 80)})` : ''}`
    let message: string
    if (g.requireToolCalledBefore !== undefined) {
      const req = g.requireToolCalledBefore
      if ([...called].some(t => named(req, t))) continue
      message = `${g.reason ? `${g.reason}: ` : ''}call ${req} before ${what}`
    } else {
      message = `${g.reason ?? 'refused by a guard of this repo\'s profile'}: ${what}`
    }
    if (g.mode === 'deny') return { deny: message, warns }
    warns.push(message)
  }
  return { warns }
}

/** The file tools a pathGlob guard is written for: such a guard also looks at shell commands that write. */
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Programs and cmdlets that write, move or delete the files they name. */
const SHELL_WRITERS = /^(?:tee|cp|mv|rm|touch|truncate|dd|install|ln|set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|sc|ac|ni|ri|mi|cpi|del|erase)$/i

/**
 * The paths a shell command may write, by its spelling (best effort, D-52):
 * the targets of `>`/`>>`, every argument of a program that writes, moves or
 * deletes files, and the files of `sed -i`/`perl -i`. Undefined when the
 * command shows no sign of writing.
 */
export function shellWrites(command: string): string[] | undefined {
  const out: string[] = []
  let writes = false
  for (const m of command.matchAll(/(?<![0-9&])>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    writes = true
    if (m[1]) out.push(m[1].replace(/^["']|["']$/g, ''))
  }
  for (const seg of segments(command)) {
    const words = splitWords(seg)
    const prog = (words[0] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
    const inPlace = (prog === 'sed' || prog === 'perl') && words.slice(1).some(a => /^-[a-zA-Z]*i/.test(a))
    if (SHELL_WRITERS.test(prog) || inPlace) {
      writes = true
      out.push(...words.slice(1).filter(a => !a.startsWith('-')))
    }
  }
  return writes ? out.filter(p => p !== '' && p !== '/dev/null' && p.toLowerCase() !== 'nul') : undefined
}

/** A guard on the file tools with a pathGlob holds for a shell call that writes a matching path too. */
function shellWriteMatches(g: Guard, call: GuardedCall, work: string): boolean {
  const w = g.when
  if (w.pathGlob === undefined || w.commandRegex !== undefined || call.command === undefined) return false
  if (!SHELLS.includes(call.tool)) return false
  if (w.tool !== undefined && !FILE_TOOLS.some(t => named(w.tool as string, t))) return false
  const targets = shellWrites(call.command)
  if (!targets) return false
  const re = globRe(w.pathGlob)
  return targets.some(p => re.test(relPath(p, work)))
}
