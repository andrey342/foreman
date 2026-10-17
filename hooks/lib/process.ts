// The one-shot roles foreman starts as `claude -p` processes (D-84, D-68, D-73):
// the supervisor and the reviewer. Pure: the argv, and reading the JSON the
// process prints. Their containment is their flags: `--permission-mode
// dontAsk` always (under `auto` the allow list does not limit, Phase 0 probe),
// `--allowedTools` read-only plus each gate line, the brief on stdin (the
// variadic `--allowedTools` swallows a positional prompt), `--max-turns`, and
// `FOREMAN_THREAD` in `--settings` so the plugin's own guard acts inside.

/** The tools every process role may use: reading, and git commands that only look. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)'] as const

export type ProcessRole = 'supervisor' | 'reviewer'

export type ProcessSpec = {
  exe: string
  role: ProcessRole
  /** `foreman:<run>:<role>-<part>`: its thread-mode name, so a pane never takes it for an implementer (review O-2 of Phase 2). */
  name: string
  model: string
  effort: string
  maxTurns: number
  /** Gate lines the role may run, each allowed literally (the reviewer's, D-73). */
  gates?: readonly string[]
  /** Windows: each gate is allowed through PowerShell too (H-5). */
  windows?: boolean
}

export const MAX_TURNS: Record<ProcessRole, number> = { supervisor: 20, reviewer: 40 }

/** `claude -p … --allowedTools …`, with the brief to be written on stdin. */
export function processArgv(s: ProcessSpec): string[] {
  const gates = (s.gates ?? []).map(g => g.trim()).filter(g => g !== '')
  // on Windows a reviewer reaches for PowerShell as readily as for Bash: each gate is allowed in both (live round of Phase 5, H-5)
  const tools = [...READ_ONLY_TOOLS, ...gates.map(g => `Bash(${g})`), ...(s.windows ? gates.map(g => `PowerShell(${g})`) : [])]
  return [
    s.exe, '-p',
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--model', s.model,
    '--effort', s.effort,
    '--max-turns', String(s.maxTurns),
    '--settings', JSON.stringify({ env: { FOREMAN_THREAD: s.name } }),
    // last: it takes every word after it
    '--allowedTools', ...tools,
  ]
}

export type ProcessUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** What a process left: its answer, or why there is none. */
export type ProcessOutcome =
  | { ok: true; result: string; usage: ProcessUsage; costUsd?: number; turns?: number; durationMs?: number; denials: string[] }
  | { ok: false; why: string; usage?: ProcessUsage; costUsd?: number; denials: string[] }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Reads `claude -p --output-format json`'s answer. No JSON, an error subtype
 * (`error_max_turns` comes with an empty `result`), a non-zero exit or a
 * timeout is no answer: the caller treats it as "escalate", never as a decision.
 */
export function readProcess(r: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }): ProcessOutcome {
  if (r.timedOut) return { ok: false, why: 'it ran out of time', denials: [] }
  let j: Record<string, unknown> | undefined
  try {
    const text = r.stdout.trim()
    j = JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
  } catch {
    j = undefined
  }
  if (!j || typeof j !== 'object') return { ok: false, why: r.exitCode !== 0 ? `exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` : 'it printed no JSON', denials: [] }
  const u = (j.usage ?? {}) as Record<string, unknown>
  const usage: ProcessUsage = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) }
  const costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined
  const denials = Array.isArray(j.permission_denials)
    ? j.permission_denials.map(d => { const x = d as { tool_name?: unknown; tool_input?: unknown }; return `${String(x.tool_name ?? '?')} ${JSON.stringify(x.tool_input ?? {}).slice(0, 400)}` })
    : []
  const result = typeof j.result === 'string' ? j.result : ''
  const subtype = typeof j.subtype === 'string' ? j.subtype : ''
  const base = { usage, ...(costUsd !== undefined ? { costUsd } : {}), denials }
  if (r.exitCode !== 0 || j.is_error === true || subtype.startsWith('error') || result.trim() === '') {
    const why = subtype === 'error_max_turns' ? 'it used up its turns before it answered' : subtype.startsWith('error') ? subtype : r.exitCode !== 0 ? `exit ${r.exitCode}` : 'its answer was empty'
    return { ok: false, why, ...base }
  }
  return { ok: true, result, ...base, ...(typeof j.num_turns === 'number' ? { turns: j.num_turns } : {}), ...(typeof j.duration_ms === 'number' ? { durationMs: j.duration_ms } : {}) }
}

/**
 * The gates a run's refused calls tried to run (D-121): a shell call its
 * permissions refused whose command holds a gate. The review could not run
 * that gate, which says nothing of the work.
 */
export function gateDenials(denials: readonly string[], gates: readonly string[], answer = ''): string[] {
  const shell = denials.filter(d => /^(Bash|PowerShell) /.test(d))
  // a gate the review reports with its exit code ran, by another way than the one refused (live round of Phase 5, H-5)
  return gates.map(g => g.trim()).filter(g => g !== '' && shell.some(d => d.includes(JSON.stringify(g).slice(1, -1))) && !gateReported(answer, g))
}

/** Whether the review's text says how a gate ended: a line that names it and an exit code. */
export function gateReported(answer: string, gate: string): boolean {
  return answer.split(/\r?\n/).some(l => l.includes(gate) && /\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:=→]?\s*-?\d+/i.test(l))
}
