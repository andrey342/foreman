// The tools the chat's model calls (M2, D-75): `mcp__foreman__<name>`, so the
// person can say "foreman, how is it going?" or "foreman, run docs/plan.md"
// instead of typing a command. Registered with `isDeferred:
// false`: left out, a plugin tool waits behind ToolSearch (F0-8, D-88). Pure:
// the specs, and the command line each call stands for.

export type ToolName = 'status' | 'go' | 'reply' | 'open'

export type ToolDef = { name: ToolName; description: string; inputSchema: Record<string, unknown>; isDeferred: false }

const str = (description: string) => ({ type: 'string', description })

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'status',
    description: "foreman's state in this repo: the plan it runs, each part's phase and review rounds, the threads, what waits for the person and the next step it would take. A report only: it changes nothing, and after it you tell the user what it says; do not call foreman's other tools unless the user then asks for that action. Call it when the user asks foreman how things are going (\"foreman, how is it going?\", \"foreman, ¿cómo va?\").",
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
  {
    name: 'go',
    description: "Runs a plan file with foreman: its parts in order, each implemented by a background thread, reviewed and applied until OK. foreman shows the person the parts it found and asks them to confirm before anything starts; never call it unless the user asked to run that plan. The parts chain by themselves; a pause written in the plan stops before the next part.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: str('The plan file, relative to the repository root (e.g. docs/plan.md).'),
        parts: str('Only these parts, comma-separated ids as the plan names them (e.g. A,B). Leave out for all.'),
        model: str('The implementer model (opus, sonnet, haiku, fable). Leave out for the profile\'s.'),
      },
      required: ['plan'],
    },
    isDeferred: false,
  },
  {
    name: 'reply',
    description: "Sends the user's answer to a foreman thread that waits for them (a question, a blocker) and resumes it. Pass the user's words as they gave them; do not answer for them.",
    inputSchema: {
      type: 'object',
      properties: {
        text: str("The user's answer, as they gave it."),
        thread: str('The thread (its id, name, or number in foreman status). Leave out when one thread waits.'),
      },
      required: ['text'],
    },
    isDeferred: false,
  },
  {
    name: 'open',
    description: "Puts a foreman thread in the desktop app's sidebar, so the user can answer its dialog or its question there. It moves the user to another chat: call it only when the user asks to open the thread (\"open it\", \"ábrelo\"), never on your own after a status report.",
    inputSchema: { type: 'object', properties: { thread: str('The thread (its id, name, or number in foreman status). Leave out for the one that waits.') } },
    isDeferred: false,
  },
]

/** The full name the model calls a tool by. */
export const toolName = (name: ToolName) => `mcp__foreman__${name}`

/** Quotes a value for splitWords (args.ts): double quotes, an inner one escaped (a backslash stays as it is). */
const q = (v: string) => `"${v.replace(/"/g, '\\"')}"`

/** The `go` call as the command line goCommand reads (a `mode` the model still passes reaches it, which says it is ignored). No value may pass for a flag; the tool asks the person anyway. */
export function goArgs(input: Record<string, unknown>): string | { error: string } {
  const plan = textOf(input, 'plan')
  if (!plan) return { error: 'Name the plan file (plan).' }
  const parts = [`go ${q(plan)}`]
  for (const k of ['mode', 'parts', 'model'] as const) {
    const v = textOf(input, k)
    if (v !== undefined) parts.push(`--${k} ${q(v)}`)
  }
  for (const k of ['plan', 'mode', 'parts', 'model']) if (textOf(input, k)?.startsWith('-')) return { error: `${k} cannot start with "-".` }
  return parts.join(' ')
}

/** A string input, trimmed; undefined when absent or blank. */
export function textOf(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}
