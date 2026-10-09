// Splits a command's argument string into words (double or single quotes
// group) and reads `--flag value` / `--flag` pairs out of them.

export function splitWords(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  let has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && text[i + 1] === quote) { cur += quote; i++ } else cur += c
    } else if (c === '"' || c === "'") { quote = c; has = true } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else { cur += c; has = true }
  }
  if (has || cur) out.push(cur)
  return out
}

export type Parsed = { positional: string[]; flags: Record<string, string | true> }

/** `boolFlags` take no value; every other `--name` takes the next word. */
export function parseArgs(text: string, boolFlags: readonly string[] = []): Parsed {
  const words = splitWords(text)
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (w.startsWith('--') && w.length > 2) {
      const name = w.slice(2)
      const eq = name.indexOf('=')
      if (eq > 0) flags[name.slice(0, eq)] = name.slice(eq + 1)
      else if (boolFlags.includes(name) || i + 1 >= words.length) flags[name] = true
      else flags[name] = words[++i] as string
    } else positional.push(w)
  }
  return { positional, flags }
}
