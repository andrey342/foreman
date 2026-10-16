// The repo's own guards (plan §8, D-78), declared in .claude/foreman.json.
// Pure: register.tsx applies the verdict in its `tool.call` hook, whose
// `.catch` refuses while the guards act. 0.1's reviewer guard is gone: the
// reviewer is a `claude -p` process its flags hold (`--permission-mode
// dontAsk` and a read-only `--allowedTools`, D-73).

import { splitWords } from './args'
import type { Guard } from './profile'

export const SHELLS = ['Bash', 'PowerShell']

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
