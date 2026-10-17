// The plan file (D-76): its parts, each part's acceptance criteria, and the
// pauses a person asked for between parts. Pure: register.tsx reads the file.
//
// Parts are headings like `## Part A`, `## 6. Parte A`, `### Fase 2b —`. With
// none, each `##` heading after the first heading that names the plan's steps
// (plan, phases, parts, steps…) is a part; with none of those either, the
// whole file is one part.

import { isSafeId } from './profile'

export type PlanPart = {
  /** What the part is called in names and files: `A`, `2b`, or `1`, `2`… when the plan has no part headings. */
  id: string
  /** The heading's text (or the file's first heading for a one-part plan). */
  title: string
  /** 0-based line of its heading (-1: the whole file). */
  line: number
  /** Its section: the heading and the lines under it, up to the next heading of the same or a higher level. */
  text: string
  /** The list under its acceptance heading, one entry per item; empty when the part names none. */
  criteria: string[]
  /** The plan asks for a person before this part starts (a pause heading or line before it). */
  pauseBefore: boolean
}

export type ParsedPlan = { title: string; parts: PlanPart[]; how: 'headings' | 'sections' | 'whole' }

const PART_RE = /^(#{1,6})\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:\*\*)?(Part|Parte|Phase|Fase|Step|Paso|Stage|Etapa|Milestone|Hito)\s+([A-Za-z0-9][\w.-]*)/i
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/
const STEPS_RE = /\b(?:plan|fases|phases|parts|partes|pasos|steps)\b/i
const PAUSE_WORD = String.raw`(?:pausa|pause|parada|stop here|decisi[oó]n humana|human decision)`
/**
 * A heading that names a pause: its text starts with the pause word (after a
 * number and emphasis: `## 7. Pausa obligatoria`), or one of its segments does,
 * after a dash, colon, parenthesis or middle dot (`### Fase 3 — pausa: …`).
 * The word inside a phrase does not count (`## Reglas de parada`, review O-1).
 */
const PAUSE_HEADING = new RegExp(String.raw`^#{1,6}\s+(?:.*?(?:[—–:(·|[]|\s-\s)\s*)?(?:\d+(?:\.\d+)*\.?\s+)?(?:\*\*|__)?\s*${PAUSE_WORD}\b`, 'i')
/** A line that starts with the pause word, bold or not (`Pausa:`, `**Pause** …`); a mention mid-sentence does not count. */
const PAUSE_LINE = new RegExp(`^\\s*(?:[-*>]\\s*)?(?:\\*\\*|__)?\\s*${PAUSE_WORD}\\b`, 'i')
const CRITERIA_WORD = String.raw`(?:aceptaci[oó]n|acceptance|criterios|criteria|done when|verificaci[oó]n|verification)`
/** The line that opens the criteria: a heading, a bold line, or a label line ending in a colon. */
const CRITERIA_RE = new RegExp(`^(?:#{1,6}\\s+.*${CRITERIA_WORD}|\\s*(?:\\*\\*|__).*${CRITERIA_WORD}|\\s*${CRITERIA_WORD}\\b.*:\\s*$)`, 'i')
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/

function headingLevel(line: string): number | undefined {
  const m = HEADING_RE.exec(line)
  return m?.[1] ? m[1].length : undefined
}

/** The part's id as file names take it: trailing dots and dashes dropped. */
function cleanId(raw: string): string {
  return raw.replace(/[.\-_]+$/, '')
}

/** The heading's words without `#`, numbering or emphasis. */
function headingText(line: string): string {
  return line.replace(/^#{1,6}\s*/, '').replace(/[*_`]/g, '').trim()
}

/** The criteria of a part: the list items under its acceptance heading or label. */
export function criteriaOf(sectionLines: readonly string[]): string[] {
  const start = sectionLines.findIndex((l, i) => i > 0 && CRITERIA_RE.test(l))
  if (start < 0) return []
  const out: string[] = []
  let current: string | undefined
  for (const line of sectionLines.slice(start + 1)) {
    if (HEADING_RE.test(line)) break
    const item = LIST_ITEM.exec(line)
    if (item?.[1]) {
      if (current !== undefined) out.push(current)
      current = item[1]
    } else if (line.trim() === '') {
      // a blank line ends the item; the list may go on after it (a loose list)
      if (current !== undefined) out.push(current)
      current = undefined
    } else if (current !== undefined && /^\s{2,}\S/.test(line)) {
      current += ` ${line.trim()}`
    } else if (out.length > 0 || current !== undefined) {
      break
    }
  }
  if (current !== undefined) out.push(current)
  return out
}

/** The lines from `start` up to the next heading of level `level` or higher (exclusive), or `stop`. */
function sectionEnd(lines: readonly string[], start: number, level: number, stop: number): number {
  for (let i = start + 1; i < stop; i++) {
    const lv = headingLevel(lines[i] ?? '')
    if (lv !== undefined && lv <= level) return i
  }
  return stop
}

/** Whether lines [from, to) hold a pause: a pause heading, or a line that starts with the pause word. */
function holdsPause(lines: readonly string[], from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < to; i++) {
    const l = lines[i] ?? ''
    if (PAUSE_HEADING.test(l) || (!HEADING_RE.test(l) && PAUSE_LINE.test(l))) return true
  }
  return false
}

type Start = { id: string; title: string; line: number; level: number }

/**
 * The part headings. Two kinds of heading that name a phase or a part are not
 * parts (Phase 2 review, P1): the plan's title, its first heading when that is
 * the only level-1 one (`# Phase 2 acceptance: …`), and a container, a heading
 * whose section holds part headings of a deeper level (`## Fase 2 — …` over
 * `### Parte A`, `### Parte B`). Ids are made unique after that, so a title
 * never takes the id of a part below it.
 */
function partHeadings(lines: readonly string[]): Start[] {
  const all: Start[] = []
  lines.forEach((line, i) => {
    const m = PART_RE.exec(line)
    if (!m?.[1] || !m[3]) return
    const id = cleanId(m[3])
    if (isSafeId(id)) all.push({ id, title: headingText(line), line: i, level: m[1].length })
  })
  const first = lines.findIndex(l => HEADING_RE.test(l))
  const levelOnes = lines.filter(l => headingLevel(l) === 1).length
  const isTitle = (s: Start) => s.line === first && s.level === 1 && levelOnes === 1
  const isContainer = (s: Start) => {
    const end = sectionEnd(lines, s.line, s.level, lines.length)
    return all.some(o => o.line > s.line && o.line < end && o.level > s.level)
  }
  const out: Start[] = []
  for (const s of all) {
    if (isTitle(s) || isContainer(s) || out.some(p => p.id.toLowerCase() === s.id.toLowerCase())) continue
    out.push(s)
  }
  return out
}

function stepSections(lines: readonly string[]): Start[] {
  const anchor = lines.findIndex(l => HEADING_RE.test(l) && STEPS_RE.test(headingText(l)))
  if (anchor < 0) return []
  const out: Start[] = []
  for (let i = anchor + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i] ?? '')) out.push({ id: String(out.length + 1), title: headingText(lines[i] ?? ''), line: i, level: 2 })
  }
  return out
}

/** Reads a plan's parts (D-76). Never throws: a plan with nothing recognisable is one part. */
export function parsePlan(text: string, fileName = 'plan'): ParsedPlan {
  const lines = text.split(/\r?\n/)
  const firstHeading = lines.find(l => HEADING_RE.test(l))
  const title = firstHeading ? headingText(firstHeading) : fileName
  let how: ParsedPlan['how'] = 'headings'
  let starts = partHeadings(lines)
  if (starts.length === 0) {
    how = 'sections'
    starts = stepSections(lines)
  }
  if (starts.length === 0) {
    return { title, how: 'whole', parts: [{ id: '1', title, line: -1, text, criteria: criteriaOf(['', ...lines]), pauseBefore: false }] }
  }
  const parts: PlanPart[] = starts.map((s, i) => {
    const next = starts[i + 1]
    const end = sectionEnd(lines, s.line, s.level, next ? next.line : lines.length)
    const section = lines.slice(s.line, end)
    const prev = starts[i - 1]
    // a pause between the previous part's heading and this one's, or in this part's own heading
    const pauseBefore = prev !== undefined && (holdsPause(lines, prev.line + 1, s.line) || PAUSE_HEADING.test(lines[s.line] ?? ''))
    return { id: s.id, title: s.title, line: s.line, text: section.join('\n'), criteria: criteriaOf(section), pauseBefore }
  })
  return { title, how, parts }
}

/** The plan's parts (D-76), as `parsePlan` reads them. */
export function planParts(text: string): PlanPart[] {
  return parsePlan(text).parts
}

/** The part after `id`, unless the plan asks for a pause before it (or there is none). */
export function nextPart(text: string, id: string): { part?: PlanPart; pause?: PlanPart } {
  const parts = planParts(text)
  const i = parts.findIndex(p => p.id === id)
  const next = i >= 0 ? parts[i + 1] : undefined
  if (!next) return {}
  return next.pauseBefore ? { pause: next } : { part: next }
}

/** A plan's run id: its file name, lower-case, letters and digits joined by `-`, at most 40 characters. */
export function planSlug(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'plan'
}

/** The slug, or the slug with the first free `-2`, `-3`… suffix when it is taken (A-16). */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

/** One line per part, for the confirmation `go` asks and its answer. */
export function planPreview(plan: ParsedPlan): string[] {
  return plan.parts.map(p => {
    const crit = p.criteria.length ? `${p.criteria.length} criteria` : 'no acceptance criteria found'
    return `${p.id} · ${p.title.slice(0, 80)} (${crit})${p.pauseBefore ? ' · the plan pauses before it' : ''}`
  })
}

/** `--parts A,B`: the named parts, in plan order; unknown names are reported. */
export function pickParts(plan: ParsedPlan, list: string): { parts: PlanPart[] } | { error: string } {
  const wanted = list.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  const unknown = wanted.filter(w => !plan.parts.some(p => p.id.toLowerCase() === w.toLowerCase()))
  if (unknown.length) return { error: `--parts names ${unknown.join(', ')}, which the plan does not have (its parts: ${plan.parts.map(p => p.id).join(', ')})` }
  const set = new Set(wanted.map(w => w.toLowerCase()))
  return { parts: plan.parts.filter(p => set.has(p.id.toLowerCase())) }
}

/** A part's title without the "Part A —" its heading starts with: the line already shows the id (live round of Phase 3b, V-7; the report too, V-12). */
export function partTitle(part: { id: string; title: string }): string {
  const id = part.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:\\*\\*)?(?:part|parte|phase|fase|step|paso|stage|etapa|milestone|hito)\\s+${id}(?:\\*\\*)?\\s*(?:[—–:]|\\s-)\\s*(\\S.*)$`, 'i').exec(part.title.trim())
  return m?.[1]?.trim() || part.title
}
