// Reviews by a fresh reviewer (plan D2, §7): which number a review takes, and
// what its first line and its findings say. Pure: register.tsx starts the
// reviewer, waits for it and records. The finding format (`### C-01 · P1 ·
// file:line`) is a recommendation; the count does not depend on it (A-10).

import type { ForemanReview } from '../../types'

export const VERDICTS = ['OK', 'NO', 'BLOCKED'] as const

/** The next number for `part`, from the names already in the plan's folder (`review-A-r2.md`). */
export function nextNumber(names: readonly string[], part: string): number {
  const re = new RegExp(`^review-${part.replace(/[.]/g, '\\.')}-r(\\d+)\\.md$`)
  const used = names.map(n => re.exec(n)?.[1]).filter((x): x is string => x !== undefined).map(Number)
  return used.length ? Math.max(...used) + 1 : 1
}

/**
 * The verdict on the file's first non-empty line: `Verdict: NO` or, for repos
 * that write Spanish, `Veredicto: NO`; markdown emphasis and `#` are ignored.
 */
export function readVerdict(text: string): ForemanReview['verdict'] | undefined {
  const first = text.split(/\r?\n/).find(l => l.trim() !== '')
  if (first === undefined) return undefined
  const clean = first.replace(/^[#>\s]+/, '').replace(/[*_`]/g, '').trim()
  const m = /^(?:verdict|veredicto)\s*:\s*([A-Za-z]+)\b/i.exec(clean)
  const v = m?.[1]?.toUpperCase()
  return v !== undefined && (VERDICTS as readonly string[]).includes(v) ? (v as ForemanReview['verdict']) : undefined
}

/** Headings that are not findings: what was checked, notes, a summary. */
const NOT_A_FINDING = /^(?:what (?:i|was) checked|checked|checks|fine|ok|notes?|summary|resumen|comprobado|lo comprobado|verificado|gates?|no findings|sin hallazgos|scope|alcance|context|contexto|verdict|veredicto)\b/i

/**
 * Findings in the file (A-10), the largest of three counts: distinct `C-nn`
 * ids that open a heading or a list item; headings after the verdict that are
 * not a "checked" or "notes" section; and `Finding N` / `Hallazgo N` lines.
 */
export function countFindings(text: string): number {
  const ids = new Set<string>()
  for (const m of text.matchAll(/^(?:#{1,6}\s*|[-*]\s*|\|\s*)(C-\d{1,3})\b/gm)) if (m[1]) ids.add(m[1])
  const lines = text.split(/\r?\n/)
  const firstAt = lines.findIndex(l => l.trim() !== '')
  let headings = 0
  for (const line of lines.slice(firstAt + 1)) {
    const h = /^#{2,6}\s+(.*\S)/.exec(line)
    if (!h?.[1]) continue
    const words = h[1].replace(/[*_`]/g, '').replace(/^[\d.\s)·-]+/, '').trim()
    if (!NOT_A_FINDING.test(words)) headings++
  }
  const named = [...text.matchAll(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?(?:finding|hallazgo)\s*#?\s*\d+\b/gim)].length
  return Math.max(ids.size, headings, named)
}

/** The last JSON object of the reviewer's answer that carries a `verdict`. */
export function finalJson(answer: string): { verdict?: string; findings?: number; file?: string } | undefined {
  const candidates = answer.match(/\{[^{}]*"verdict"[^{}]*\}/g)
  for (const c of [...(candidates ?? [])].reverse()) {
    try {
      const v = JSON.parse(c) as Record<string, unknown>
      return {
        ...(typeof v.verdict === 'string' ? { verdict: v.verdict.toUpperCase() } : {}),
        ...(typeof v.findings === 'number' ? { findings: v.findings } : {}),
        ...(typeof v.file === 'string' ? { file: v.file } : {}),
      }
    } catch { /* not JSON after all */ }
  }
  return undefined
}

export type Settled = Pick<ForemanReview, 'verdict' | 'findings' | 'noResult' | 'reason'>

/**
 * What a finished review comes to. The file decides, never the answer alone:
 * a missing file or a first line without a verdict is `noResult` (verdict
 * `none`), never an OK. A final JSON that disagrees with the file is noted.
 */
export function settle(fileText: string | undefined, answer: string): Settled {
  const json = finalJson(answer)
  if (fileText === undefined) return { verdict: 'none', findings: 0, noResult: true, reason: 'the review file was not written' }
  const verdict = readVerdict(fileText)
  if (verdict === undefined) return { verdict: 'none', findings: countFindings(fileText), noResult: true, reason: `the first line carries no verdict (${VERDICTS.join('/')})` }
  const findings = countFindings(fileText)
  const out: Settled = { verdict, findings: findings || (json?.findings ?? 0) }
  if (json?.verdict && json.verdict !== verdict) out.reason = `the final JSON says ${json.verdict}; the file's first line, ${verdict}, stands`
  return out
}

export function reviewSummary(r: ForemanReview): string {
  if (r.noResult) return `Review ${r.part} r${r.n}: no verdict (${r.reason ?? 'unknown'}). ${r.file}`
  return `Review ${r.part} r${r.n}: ${r.verdict}, ${r.findings} finding(s). ${r.file}${r.reason ? ` (${r.reason})` : ''}`
}
