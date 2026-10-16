// The foreman pane (v3, D-113): the one thing that matters in view, the rest
// folded. The plan's title with Pause/Continue and Stop; one status line in
// words; one line per part (✓ done, ● at work, ○ to come); "Needs you" only
// when something does, one at a time (a question with its field and Send, a
// thread's permission dialog with "Open its chat", the plan's own pause with
// Continue); a review that said NO, with Show; the supervisor's last decision,
// with Why; and Details, folded: thread ids, models, tokens, files, notices,
// the last button, the repo and Refresh. Every element keeps its key while the
// pane redraws, and register.tsx answers presses and the reply field by key
// (`ui.press`, `ui.input`). Pure: it gets the surface's element table and the
// values to draw.

import type { ElementTable } from 'claude-code'
import type { ForemanCycle, ForemanDecisionNote, ForemanNotice, ForemanPaneUi, ForemanPlanRun, ForemanThread, ForemanView } from '../../types'
import { isPlanActive, partCycleId } from '../lib/run'
import { STATE_LABEL, tokens } from '../lib/threads'

export type PaneData = {
  view: ForemanView
  threads: readonly ForemanThread[]
  cycles?: readonly ForemanCycle[]
  plans?: readonly ForemanPlanRun[]
  warnings: readonly string[]
  notices?: readonly ForemanNotice[]
  /** What the person unfolded or did here: the review or report shown, Details, Why, the last Send. */
  ui?: ForemanPaneUi
  /** When the pane is drawn (ms): "Sent ✓" shows for a few seconds after a Send. */
  now?: number
}

/** The closures behind the elements: a fallback, as register.tsx answers every press and Send by key. */
export type PaneActions = {
  press: (key: string) => void
  reply: (key: string, text: string) => void
}

/** The pane's button keys: `<action>:<id>`, read back by register.tsx's `ui.press` hook. */
export const PANE_KEYS = ['refresh', 'toggle', 'continue', 'stop', 'open', 'review', 'report', 'why', 'details'] as const
export type PaneKey = (typeof PANE_KEYS)[number]

export function parseKey(element: string): { action: PaneKey; id: string } | undefined {
  const i = element.indexOf(':')
  const action = (i < 0 ? element : element.slice(0, i)) as PaneKey
  return PANE_KEYS.includes(action) ? { action, id: i < 0 ? '' : element.slice(i + 1) } : undefined
}

/** The reply field's key: the thread and a count of Sends, so the field is drawn anew, empty, after each one. */
export const replyKey = (threadId: string, n: number) => `reply:${threadId}:${n}`

/** The thread a reply field's key names. */
export function replyThread(element: string): string | undefined {
  return /^reply:(.+):\d+$/.exec(element)?.[1]
}

/** How long "Sent ✓" stays after a Send. */
export const SENT_MS = 8_000

const FULL = 1000
const full = (s: string) => (s.length > FULL ? `${s.slice(0, FULL - 1)}…` : s)
const one = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The plans the pane shows: the active ones, else the last one that ended in the last day. */
export function shownPlans(plans: readonly ForemanPlanRun[], now: number): ForemanPlanRun[] {
  const active = plans.filter(isPlanActive)
  if (active.length) return active
  const last = [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return last && now - Date.parse(last.updatedAt) < 86_400_000 ? [last] : []
}

const cycleAt = (run: ForemanPlanRun, index: number, cycles: readonly ForemanCycle[]) => {
  const part = run.parts[index]
  return part ? cycles.find(x => x.id === partCycleId(run.id, part.id)) : undefined
}

/** The plan waits before its next part (its own pause, or the person's) and the current part is ready: Continue starts it. */
export function atPause(run: ForemanPlanRun, cycles: readonly ForemanCycle[]): boolean {
  return run.status === 'paused' && cycleAt(run, run.current, cycles)?.phase === 'ready' && run.parts[run.current + 1] !== undefined
}

/** Something that waits for the person, as the pane offers it. */
export type NeedsYou =
  | { kind: 'question'; who: string; thread: ForemanThread; text: string }
  | { kind: 'message'; who: string; thread: ForemanThread; text: string }
  | { kind: 'dialog'; who: string; thread: ForemanThread }
  | { kind: 'in-app'; who: string; thread: ForemanThread }
  | { kind: 'pause'; run: ForemanPlanRun; next: string }

/** A thread that waits, as the person reads it; undefined when it does not wait for them. */
function threadNeed(who: string, t: ForemanThread, c: ForemanCycle | undefined): NeedsYou | undefined {
  // closed, or at work again (the person's Send resumed it): nothing waits for them
  if (t.closed || t.state === 'working') return undefined
  const partWaits = c?.phase === 'waiting'
  if (t.openedAt && (t.state === 'waiting' || t.state === 'blocked' || partWaits)) return { kind: 'in-app', who, thread: t }
  if (t.state === 'blocked') return { kind: 'dialog', who, thread: t }
  if (t.state === 'waiting' && t.lastResult?.status === 'question') return { kind: 'question', who, thread: t, text: t.lastResult.question ?? t.waitingFor ?? t.lastResult.summary }
  if (partWaits || t.state === 'waiting' || t.state === 'failed') {
    const why = partWaits && c?.reason ? c.reason : t.waitingFor ?? t.lastResult?.question ?? t.lastResult?.summary ?? 'it waits for you'
    return { kind: 'message', who, thread: t, text: why }
  }
  return undefined
}

/** Everything that waits for the person: each shown plan's current part or its pause, then foreman's threads outside a plan. */
export function needsYou(data: PaneData, plans: readonly ForemanPlanRun[]): NeedsYou[] {
  const cycles = data.cycles ?? []
  const out: NeedsYou[] = []
  const inPlans = new Set(cycles.map(c => c.implThread))
  for (const run of plans) {
    if (!isPlanActive(run)) continue
    if (atPause(run, cycles)) {
      out.push({ kind: 'pause', run, next: run.parts[run.current + 1]?.id ?? '' })
      continue
    }
    const c = cycleAt(run, run.current, cycles)
    const t = c ? data.threads.find(x => x.id === c.implThread) : undefined
    if (c?.phase === 'waiting' && t) {
      const need = threadNeed(`Part ${c.part}`, t, c)
      if (need) out.push(need)
    }
  }
  for (const t of data.threads) {
    if (inPlans.has(t.id)) continue
    const need = threadNeed(t.name, t, undefined)
    if (need) out.push(need)
  }
  return out
}

/** What waits for the person, one line each (foreman_status says it in words). */
export function waitingLines(data: PaneData): string[] {
  return needsYou(data, data.plans ?? []).map(n => {
    switch (n.kind) {
      case 'pause': return `${n.run.id}: the plan asks you to check before part ${n.next} (Continue goes on)`
      case 'question': return `${n.who} asks: ${one(n.text, 160)}`
      case 'dialog': return `${n.who} is waiting for a permission in its own chat (Open its chat)`
      case 'in-app': return `${n.who} is open in its own chat: answer it there`
      default: return `${n.who} needs you: ${one(n.text, 160)}`
    }
  })
}

/** The plan's state in a few words: the status line under its title. */
export function statusWords(run: ForemanPlanRun, cycles: readonly ForemanCycle[], threads: readonly ForemanThread[]): string {
  const n = run.parts.length
  switch (run.status) {
    case 'done': return `Done ✓ · ${n} part${n === 1 ? '' : 's'}`
    case 'stopped': return run.reason === undefined || run.reason === 'stopped by the person' ? 'Stopped' : `Failed: ${one(run.reason, 80)}`
    case 'paused': return atPause(run, cycles) ? 'Needs you' : 'Paused'
    default: break
  }
  const base = `Working on part ${run.current + 1} of ${n}`
  const c = cycleAt(run, run.current, cycles)
  if (!c) return base
  const t = threads.find(x => x.id === c.implThread)
  switch (c.phase) {
    case 'waiting': return 'Needs you'
    case 'closed': return 'Stopped'
    case 'reviewing': return `${base} · Reviewing (round ${Math.max(1, c.rounds.length - (c.roundBase ?? 0))} of ${c.maxCycles})`
    case 'applying': return `${base} · Fixing the review's findings`
    case 'supervising': return `${base} · foreman is checking the plan`
    case 'limit': return `${base} · Usage limit${t?.retryAt ? `: goes on at ${t.retryAt.slice(11, 16)} UTC` : ''}`
    default: return t?.openedAt ? `${base} · open in its own chat` : base
  }
}

/** One part's mark: ✓ ready, ● the one at work, ○ the rest. */
export function partMark(run: ForemanPlanRun, index: number, cycles: readonly ForemanCycle[]): string {
  if (cycleAt(run, index, cycles)?.phase === 'ready') return '✓'
  return index === run.current && run.status !== 'done' ? '●' : '○'
}

/** The review the person may want to read: the current part's last round when it said NO, was blocked or gave no verdict. */
export function reviewToShow(run: ForemanPlanRun, cycles: readonly ForemanCycle[]): { c: ForemanCycle; n: number; file: string; words: string } | undefined {
  const c = cycleAt(run, run.current, cycles)
  const last = c?.rounds.at(-1)
  if (!c || !last || c.phase === 'ready' || c.phase === 'reviewing' || last.verdict === 'OK') return undefined
  const words = last.verdict === 'NO' ? `${last.findings} finding${last.findings === 1 ? '' : 's'}` : last.verdict === 'BLOCKED' ? 'the reviewer was blocked' : 'no verdict'
  return { c, n: last.n, file: last.file, words }
}

/** The supervisor's last decision on any part of the plan, with the part it was on. */
export function lastDecision(run: ForemanPlanRun, cycles: readonly ForemanCycle[]): { d: ForemanDecisionNote; part: string } | undefined {
  let best: { d: ForemanDecisionNote; part: string } | undefined
  for (const c of cycles) {
    if (c.runId !== run.id) continue
    const d = c.decisions?.at(-1)
    if (d && (!best || d.at > best.d.at)) best = { d, part: c.part }
  }
  return best
}

/** A decision in words: "answered part A from the plan". */
export function decisionWords(d: ForemanDecisionNote, part: string): string {
  switch (d.decision) {
    case 'answer': return `answered part ${part} from the plan`
    case 'replan': return `replanned part ${part}`
    case 're-review': return `asked for another review of part ${part}`
    case 'next-part': return `started the part after ${part}`
    default: return `passed part ${part} to you`
  }
}

/** The last button's answer, short: its first sentence, no app session ids. */
export function lastActionText(text: string): string {
  const t = text.replace(/\s*\(local_[0-9a-f-]+\)/g, '')
  const cut = t.indexOf(': ', t.indexOf(': ') + 2)
  return (cut > 0 && cut < 120 ? t.slice(0, cut) : t).slice(0, 120)
}

export const EMPTY_TEXT = 'No plan is running here. Ask in the chat: “foreman, run docs/plans/<file>.md”.'

export function paneTree(els: ElementTable, data: PaneData, actions: PaneActions) {
  const { Box, Text, Button, Markdown } = els
  // the mobile surface draws no text field yet: a question is answered from the chat there
  const Input = 'Input' in els ? els.Input : undefined
  const v = data.view
  const ui = data.ui ?? {}
  const now = data.now ?? (v.refreshedAt || Date.now())
  const cycles = data.cycles ?? []
  const plans = shownPlans(data.plans ?? [], now)
  const needs = needsYou(data, plans)
  const need = needs[0]
  const sent = ui.sent !== undefined && now - Date.parse(ui.sent.at) < SENT_MS
  const btn = (key: string, label: string, dim = false) => <Button key={key} label={label} {...(dim ? { dimColor: true } : {})} onPress={() => actions.press(key)} />
  const field = (t: ForemanThread, placeholder: string) => {
    const key = replyKey(t.id, ui.replies ?? 0)
    return Input !== undefined
      ? <Input key={key} placeholder={placeholder} submitLabel="Send" onSubmit={text => actions.reply(key, text)} />
      : <Text dimColor>{'Answer it from the chat: “foreman, reply: <your answer>”.'}</Text>
  }

  const needsBox = need === undefined ? undefined : (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{needs.length > 1 ? `Needs you · and ${needs.length - 1} more` : 'Needs you'}</Text>
      {need.kind === 'question' && <Text>{full(`${need.who} asks: ${need.text}`)}</Text>}
      {need.kind === 'question' && field(need.thread, 'your answer…')}
      {need.kind === 'message' && <Text>{full(`${need.who} needs you: ${need.text}`)}</Text>}
      {need.kind === 'message' && field(need.thread, 'a message to the thread…')}
      {need.kind === 'dialog' && <Text>{`${need.who} is waiting for a permission in its own chat.`}</Text>}
      {need.kind === 'dialog' && btn(`open:${need.thread.id}`, 'Open its chat')}
      {need.kind === 'in-app' && <Text>{`${need.who} is open in its own chat: answer it there. foreman goes on when its turn ends.`}</Text>}
      {need.kind === 'pause' && <Text>{`The plan asks you to check before part ${need.next}.`}</Text>}
      {need.kind === 'pause' && btn(`continue:${need.run.id}`, 'Continue')}
    </Box>
  )

  const details = (
    <Box flexDirection="column">
      {btn('details', ui.details ? '▾ Details' : '▸ Details', true)}
      {ui.details === true && (
        <Box flexDirection="column" paddingLeft={2}>
          {plans.map(run => <Text dimColor>{`plan ${run.id} · ${run.plan} · files ${run.dir}`}</Text>)}
          {plans.flatMap(run => cycles.filter(c => c.runId === run.id)).map(c => {
            const t = data.threads.find(x => x.id === c.implThread)
            return <Text dimColor>{`part ${c.part} · ${c.phase} · thread ${c.implThread}${t ? ` · ${STATE_LABEL[t.state]} · ${t.model}/${t.effort} · ${tokens(t)}` : ''}${c.rounds.length ? ` · reviews ${c.rounds.map(r => `r${r.n} ${r.verdict}`).join(', ')}` : ''}`}</Text>
          })}
          {data.threads.filter(t => !t.closed && !cycles.some(c => c.implThread === t.id)).map(t => <Text dimColor>{`thread ${t.name} (${t.id}) · ${STATE_LABEL[t.state]} · ${t.model}/${t.effort} · ${tokens(t)}`}</Text>)}
          {data.warnings.length > 0 && <Text color="yellow">{`${data.warnings.length} profile warning(s): /foreman profile`}</Text>}
          {v.error !== undefined && <Text color="red">{v.error}</Text>}
          {(data.notices ?? []).slice(-5).map(n => <Text dimColor>{`${n.at.slice(11, 16)} ${one(n.text, 200)}`}</Text>)}
          {ui.lastAction !== undefined && <Text dimColor>{`Last button: ${ui.lastAction.at.slice(11, 16)} ${lastActionText(ui.lastAction.text)}`}</Text>}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{`${v.root || 'this repo'} · ${v.refreshedAt ? `listed ${new Date(v.refreshedAt).toISOString().slice(11, 16)} UTC` : 'not listed yet'}`}</Text>
            {btn('refresh', 'Refresh', true)}
          </Box>
        </Box>
      )}
    </Box>
  )

  if (plans.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>{EMPTY_TEXT}</Text>
        {needsBox}
        {sent && <Text color="green">Sent ✓ — the thread goes on</Text>}
        {details}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {plans.map(run => {
        const active = isPlanActive(run)
        const review = reviewToShow(run, cycles)
        const reviewShown = review !== undefined && ui.shown?.file === review.file
        const reportShown = ui.shown !== undefined && ui.shown.file.startsWith(run.dir)
        return (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>{run.title}</Text>
                {active && (
                  <Box flexDirection="row" gap={1}>
                    {btn(`toggle:${run.id}`, run.status === 'paused' ? 'Continue' : 'Pause', run.status !== 'paused')}
                    {btn(`stop:${run.id}`, 'Stop', true)}
                  </Box>
                )}
              </Box>
              <Text>{statusWords(run, cycles, data.threads)}</Text>
              {run.status === 'done' && btn(`report:${run.id}`, reportShown ? 'Hide report' : 'Show report')}
            </Box>
            <Box flexDirection="column">
              {run.parts.map((p, i) => <Text>{` ${partMark(run, i, cycles)} ${p.id}  ${one(p.title, 70)}`}</Text>)}
            </Box>
            {review !== undefined && (
              <Box flexDirection="row" gap={1}>
                <Text>{`Review round ${review.n}: ${review.words}`}</Text>
                {btn(`review:${review.c.implThread}`, reviewShown ? 'Hide' : 'Show', true)}
              </Box>
            )}
          </Box>
        )
      })}
      {needsBox}
      {sent && <Text color="green">Sent ✓ — the thread goes on</Text>}
      {ui.shown !== undefined && <Markdown key="shown" text={ui.shown.text} />}
      {plans.map(run => {
        const decided = lastDecision(run, cycles)
        return decided === undefined ? undefined : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text>{`foreman decided: ${decisionWords(decided.d, decided.part)} (${decided.d.at.slice(11, 16)})`}</Text>
              {decided.d.text !== undefined && btn(`why:${run.id}`, ui.why ? 'Hide why' : 'Why', true)}
            </Box>
            {ui.why === true && decided.d.text !== undefined && <Text dimColor>{full(decided.d.text)}</Text>}
          </Box>
        )
      })}
      {details}
    </Box>
  )
}
