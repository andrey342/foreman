// Reviews and critiques by fresh subagents (plan D2, §7): where the file
// goes, which number it takes, and what its first line and final JSON say.
// Pure: register.tsx spawns, waits through turn.complete and records.

import type { ForemanReview, ForemanReviewKind } from '../../types'

export const VERDICTS: Record<ForemanReviewKind, readonly string[]> = {
  review: ['OK', 'NO', 'BLOCKED'],
  critic: ['PASS', 'FAIL', 'BLOCKED'],
}

/** `review-A-r2.md`, `critic-A-r1.md`. */
export function reviewFileName(kind: ForemanReviewKind, part: string, n: number): string {
  return `${kind}-${part}-r${n}.md`
}

/** The next number for `kind` and `part`, from the names already in the run's folder. */
export function nextNumber(names: readonly string[], kind: ForemanReviewKind, part: string): number {
  const re = new RegExp(`^${kind}-${part.replace(/[.]/g, '\\.')}-r(\\d+)\\.md$`)
  const used = names.map(n => re.exec(n)?.[1]).filter((x): x is string => x !== undefined).map(Number)
  return used.length ? Math.max(...used) + 1 : 1
}

/**
 * The verdict on the file's first non-empty line: `Verdict: NO` or, for repos
 * that write Spanish, `Veredicto: NO`; markdown emphasis and `#` are ignored.
 */
export function readVerdict(text: string, kind: ForemanReviewKind): string | undefined {
  const first = text.split(/\r?\n/).find(l => l.trim() !== '')
  if (first === undefined) return undefined
  const clean = first.replace(/^[#>\s]+/, '').replace(/[*_`]/g, '').trim()
  const m = /^(?:verdict|veredicto)\s*:\s*([A-Za-z]+)\b/i.exec(clean)
  const v = m?.[1]?.toUpperCase()
  return v !== undefined && VERDICTS[kind].includes(v) ? v : undefined
}

/** Findings in the file: distinct `C-nn` ids that open a heading or a list item. */
export function countFindings(text: string): number {
  const ids = new Set<string>()
  for (const m of text.matchAll(/^(?:#{1,6}\s*|[-*]\s*|\|\s*)(C-\d{1,3})\b/gm)) if (m[1]) ids.add(m[1])
  return ids.size
}

/** The last JSON object of the subagent's answer that carries a `verdict`. */
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
export function settle(kind: ForemanReviewKind, fileText: string | undefined, answer: string): Settled {
  const json = finalJson(answer)
  if (fileText === undefined) return { verdict: 'none', findings: 0, noResult: true, reason: 'the review file was not written' }
  const verdict = readVerdict(fileText, kind)
  if (verdict === undefined) return { verdict: 'none', findings: countFindings(fileText), noResult: true, reason: `the first line carries no verdict (${VERDICTS[kind].join('/')})` }
  const findings = countFindings(fileText)
  const out: Settled = { verdict: verdict as ForemanReview['verdict'], findings: findings || (json?.findings ?? 0) }
  if (json?.verdict && json.verdict !== verdict) out.reason = `the final JSON says ${json.verdict}; the file's first line, ${verdict}, stands`
  return out
}

export function reviewSummary(r: ForemanReview): string {
  const what = r.kind === 'review' ? 'Review' : 'Critique'
  if (r.noResult) return `${what} ${r.part} r${r.n}: no verdict (${r.reason ?? 'unknown'}). ${r.file}`
  return `${what} ${r.part} r${r.n}: ${r.verdict}, ${r.findings} finding(s). ${r.file}${r.reason ? ` (${r.reason})` : ''}`
}
