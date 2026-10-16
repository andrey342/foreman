// The foreman pane (v2, plan §8): what needs the person first, then the plan
// part by part, each in the person's words ("Needs your answer", "Working",
// "Reviewing (r1 of 3)", "Ready") with the question or the reason in full and
// the technical details in one dim line, then the repo's other background
// sessions. Every button keeps its key while the pane redraws (Pause and
// Resume are one button), and register.tsx answers presses by that key
// (`ui.press`), so a press never lands on a button that is gone. Pure: it gets
// the surface's element table and the values to draw.

import type { ElementTable } from 'claude-code'
import type { ForemanCycle, ForemanNotice, ForemanPlanMode, ForemanPlanPart, ForemanPlanRun, ForemanThread, ForemanView } from '../../types'
import { GROUP_LABEL, ago, groupRows } from '../lib/agents'
import { isPlanActive, modeOf, partCycleId } from '../lib/run'
import { STATE_LABEL, tokens } from '../lib/threads'

export type PaneData = {
  view: ForemanView
  threads: readonly ForemanThread[]
  cycles?: readonly ForemanCycle[]
  plans?: readonly ForemanPlanRun[]
  warnings: readonly string[]
  notices?: readonly ForemanNotice[]
  /** The review the person asked to see (Show review), its text cut to fit (M5). */
  shown?: { file: string; text: string }
  /** What the last button did, in a line: a press that does nothing still says why. */
  lastAction?: { at: string; text: string }
}

export type PaneActions = {
  refresh: () => void
  /** Puts the thread in the desktop app's sidebar (Open, F0-4). */
  open: (threadId: string) => void
  /** Sends the text to the thread (stop + `--bg --resume`, D-03). */
  reply: (threadId: string, text: string) => void
  /** Shows the last review of the thread's part, or hides the one shown. */
  showReview: (threadId: string) => void
  hideReview: () => void
  next: (runId: string) => void
  /** Pause when it runs, Resume when it is paused: one button, one key. */
  toggle: (runId: string) => void
  stop: (runId: string) => void
  mode: (runId: string, mode: ForemanPlanMode) => void
}

/** The pane's button keys: `<action>:<id>`, read back by register.tsx's `ui.press` hook. */
export const PANE_KEYS = ['refresh', 'next', 'toggle', 'stop', 'open', 'review', 'hide-review'] as const
export type PaneKey = (typeof PANE_KEYS)[number]

export function parseKey(element: string): { action: PaneKey; id: string } | undefined {
  const i = element.indexOf(':')
  const action = (i < 0 ? element : element.slice(0, i)) as PaneKey
  return PANE_KEYS.includes(action) ? { action, id: i < 0 ? '' : element.slice(i + 1) } : undefined
}

const MODE_OPTIONS = [{ value: 'auto', label: 'auto: chain the parts' }, { value: 'review', label: 'review: wait for Next part' }] as const
const FULL = 1000
const full = (s: string) => (s.length > FULL ? `${s.slice(0, FULL - 1)}…` : s)

/** The plans the pane shows: the active ones, else the last one that ended in the last day. */
export function shownPlans(plans: readonly ForemanPlanRun[], now: number): ForemanPlanRun[] {
  const active = plans.filter(isPlanActive)
  if (active.length) return active
  const last = [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return last && now - Date.parse(last.updatedAt) < 86_400_000 ? [last] : []
}

const cycleOf = (run: ForemanPlanRun, part: ForemanPlanPart | undefined, cycles: readonly ForemanCycle[]) =>
  part ? cycles.find(x => x.id === partCycleId(run.id, part.id)) : undefined

/** The person can start the next part now: the plan waits before it and the current part is ready. */
export function canNext(run: ForemanPlanRun, cycles: readonly ForemanCycle[]): boolean {
  return run.status === 'paused' && cycleOf(run, run.parts[run.current], cycles)?.phase === 'ready' && run.parts[run.current + 1] !== undefined
}

/** A part as the person reads it: its state in words, the question or the reason in full, and whether it waits for them. */
export type PartView = { words: string; detail?: string; needsYou: boolean }

export function partView(index: number, current: number, c: ForemanCycle | undefined, t: ForemanThread | undefined): PartView {
  if (!c) return { words: index < current ? 'Skipped' : 'Not started', needsYou: false }
  const last = c.rounds.at(-1)
  switch (c.phase) {
    case 'ready': return { words: last?.verdict === 'OK' ? `Ready (review r${last.n} OK)` : 'Ready', needsYou: false }
    case 'closed': return { words: 'Stopped', needsYou: false }
    case 'reviewing': return { words: `Reviewing (round ${Math.max(1, c.rounds.length)} of ${c.maxCycles})`, needsYou: false }
    case 'applying': return { words: `Applying review r${last?.n ?? '?'}`, needsYou: false }
    case 'limit': return { words: 'Usage limit', ...(t?.retryAt ? { detail: `goes on by itself at ${t.retryAt.slice(11, 16)} UTC` } : {}), needsYou: false }
    case 'implementing': return { words: t?.openedAt ? 'Open in the app' : 'Working', needsYou: false }
    default: break
  }
  // waiting
  if (t?.openedAt) return { words: 'Open in the app', detail: 'answer it in its own chat in the sidebar; foreman goes on when its turn ends', needsYou: true }
  if (c.waitingOn === 'thread' && t) {
    if (t.state === 'waiting' && t.lastResult?.status === 'question') return { words: 'Needs your answer', detail: full(t.lastResult.question ?? t.waitingFor ?? t.lastResult.summary), needsYou: true }
    if (t.state === 'waiting' && t.lastResult?.status === 'blocked') return { words: 'Blocked: needs you', detail: full(t.lastResult.question ?? t.lastResult.summary), needsYou: true }
    if (t.state === 'waiting') return { words: 'Needs you', detail: full(t.waitingFor ?? 'the thread ended its turn without a result'), needsYou: true }
    if (t.state === 'blocked') return { words: 'Needs you: a dialog', detail: `${t.waitingFor ?? 'a permission prompt'}: Open puts it in the app, where you answer it`, needsYou: true }
    if (t.state === 'failed') return { words: 'Failed', detail: full(t.waitingFor ?? c.reason ?? ''), needsYou: true }
    if (t.state === 'stopped') return { words: 'Stopped', detail: full(t.waitingFor ?? c.reason ?? 'its thread stopped'), needsYou: true }
  }
  return { words: 'Needs you', detail: full(c.reason ?? 'it waits for you'), needsYou: true }
}

/** The plan as the person reads it. */
export function planWords(run: ForemanPlanRun, cycles: readonly ForemanCycle[]): string {
  switch (run.status) {
    case 'done': return 'Done'
    case 'stopped': return 'Stopped'
    case 'paused': return canNext(run, cycles) ? 'Waiting for Next part' : 'Paused'
    default: return modeOf(run) === 'review' ? 'Running; stops after each part' : 'Running'
  }
}

/** What waits for the person, one line each: a part (once), a thread outside the plans, a paused plan. */
export function waitingLines(data: PaneData): string[] {
  const cycles = data.cycles ?? []
  const plans = data.plans ?? []
  const out: string[] = []
  const inPlans = new Set<string>()
  for (const run of plans) {
    run.parts.forEach((p, i) => {
      const c = cycleOf(run, p, cycles)
      const t = c ? data.threads.find(x => x.id === c.implThread) : undefined
      if (c) inPlans.add(c.implThread)
      const v = partView(i, run.current, c, t)
      if (v.needsYou && (c === undefined || c.phase === 'waiting')) out.push(`Part ${p.id}: ${v.words}`)
    })
    if (canNext(run, cycles)) out.push(`${run.id}: Next part starts part ${run.parts[run.current + 1]?.id}`)
    else if (run.status === 'paused' && run.reason) out.push(`${run.id}: paused (${run.reason.slice(0, 120)})`)
  }
  for (const t of data.threads) {
    if (t.closed || inPlans.has(t.id) || (t.state !== 'waiting' && t.state !== 'blocked')) continue
    out.push(`${t.name}: ${STATE_LABEL[t.state]}${t.waitingFor ? ` · ${t.waitingFor.slice(0, 120)}` : ''}`)
  }
  return out
}

export function paneTree(els: ElementTable, data: PaneData, actions: PaneActions) {
  const { Box, Text, Button, Markdown } = els
  // the mobile surface draws no text field and no picker yet: Reply and the mode are left out there
  const Input = 'Input' in els ? els.Input : undefined
  const Select = 'Select' in els ? els.Select : undefined
  const v = data.view
  const now = v.refreshedAt
  const cycles = data.cycles ?? []
  const plans = shownPlans(data.plans ?? [], now || Date.now())
  const planThreads = new Set(cycles.filter(c => plans.some(p => p.id === c.runId)).map(c => c.implThread))
  const others = data.threads.filter(t => !t.closed && !planThreads.has(t.id) && t.state !== 'done')
  const threadIds = new Set(data.threads.map(t => t.id))
  const groups = groupRows(v.rows.filter(r => r.id === undefined || !threadIds.has(r.id)))
  const waiting = waitingLines({ ...data, plans })
  const listed = v.refreshedAt ? `listed ${new Date(v.refreshedAt).toLocaleTimeString()}` : 'not listed yet'

  // a thread's controls and, last and dim, its technical details
  const threadControls = (t: ForemanThread, c: ForemanCycle | undefined) => {
    const lastReview = c?.rounds.at(-1)
    const shownHere = lastReview !== undefined && data.shown?.file === lastReview.file
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text>{'   '}</Text>
          <Button key={`open:${t.id}`} label="Open" dimColor={t.state !== 'blocked' && t.state !== 'waiting'} onPress={() => actions.open(t.id)} />
          <Button key={`review:${t.id}`} label={lastReview === undefined ? 'No review yet' : shownHere ? `Hide review r${lastReview.n}` : `Show review r${lastReview.n}`} dimColor onPress={() => actions.showReview(t.id)} />
          {Input !== undefined && t.state !== 'done' && (
            <Input key={`reply:${t.id}`} placeholder={t.state === 'waiting' ? 'your answer…' : 'a message to the thread…'} submitLabel="Reply" onSubmit={text => actions.reply(t.id, text)} />
          )}
        </Box>
        <Text dimColor>{`    thread ${t.id} · ${STATE_LABEL[t.state]} · ${t.model}/${t.effort} · ${tokens(t)}${t.lastLine !== undefined ? ` · › ${t.lastLine.slice(0, 100)}` : ''}`}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{v.root ? `${v.root} · ${listed}` : listed}</Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => actions.refresh()} />
      </Box>
      {v.error !== undefined && <Text color="red">{v.error}</Text>}
      {data.warnings.length > 0 && <Text color="yellow">{`${data.warnings.length} profile warning(s): /foreman profile`}</Text>}
      {waiting.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="yellow">{`Needs you (${waiting.length})`}</Text>
          {waiting.map(l => <Text color="yellow">{`  ${l}`}</Text>)}
        </Box>
      )}
      {plans.length === 0 && <Text dimColor>No plan running. /foreman go {'<plan.md>'} starts one.</Text>}
      {plans.map(run => {
        const active = isPlanActive(run)
        const current = run.parts[run.current]
        const next = canNext(run, cycles)
        return (
          <Box flexDirection="column">
            <Text bold>{run.title}</Text>
            <Text>{`  ${planWords(run, cycles)}`}</Text>
            {active && (
              <Box flexDirection="row" gap={1}>
                <Text>{' '}</Text>
                <Button key={`next:${run.id}`} label="Next part" dimColor={!next} onPress={() => actions.next(run.id)} />
                <Button key={`toggle:${run.id}`} label={run.status === 'paused' ? 'Resume' : 'Pause'} dimColor={run.status !== 'paused'} onPress={() => actions.toggle(run.id)} />
                <Button key={`stop:${run.id}`} label="Stop" dimColor onPress={() => actions.stop(run.id)} />
                {Select !== undefined && (
                  <Select key={`mode:${run.id}`} label="Mode" options={MODE_OPTIONS} value={modeOf(run)} onSelect={value => actions.mode(run.id, value as ForemanPlanMode)} />
                )}
              </Box>
            )}
            {run.parts.map((p, i) => {
              const c = cycleOf(run, p, cycles)
              const t = c ? data.threads.find(x => x.id === c.implThread) : undefined
              const view = partView(i, run.current, c, t)
              const isCurrent = i === run.current && active
              return (
                <Box flexDirection="column">
                  <Text bold={isCurrent} dimColor={!isCurrent && !view.needsYou}>{`  ${isCurrent ? '›' : ' '} ${p.id} · ${p.title.slice(0, 70)} — ${view.words}${p.pauseBefore && !p.go && i > run.current ? ' (the plan pauses before it)' : ''}`}</Text>
                  {view.detail !== undefined && <Text {...(view.needsYou ? { color: 'yellow' as const } : {})}>{`      ${view.detail}`}</Text>}
                  {t !== undefined && c !== undefined && isCurrent && threadControls(t, c)}
                </Box>
              )
            })}
            <Text dimColor>{`  plan ${run.id} · ${run.plan} · ${modeOf(run)} mode · part ${current?.id ?? '-'} (${run.current + 1} of ${run.parts.length})${run.reason && run.status !== 'running' ? ` · ${run.reason.slice(0, 140)}` : ''}`}</Text>
          </Box>
        )
      })}
      {data.lastAction !== undefined && <Text dimColor>{`Last: ${data.lastAction.at.slice(11, 16)} ${data.lastAction.text.slice(0, 300)}`}</Text>}
      {data.shown !== undefined && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{`Review ${data.shown.file.split(/[\\/]/).pop() ?? ''}`}</Text>
            <Button key="hide-review" label="Hide" dimColor onPress={() => actions.hideReview()} />
          </Box>
          <Markdown text={data.shown.text} />
        </Box>
      )}
      {others.length > 0 && (
        <Box flexDirection="column">
          <Text bold>{`Threads outside a plan (${others.length})`}</Text>
          {others.map(t => (
            <Box flexDirection="column">
              <Text>{`  ${t.name} — ${STATE_LABEL[t.state]}`}</Text>
              {t.waitingFor !== undefined && <Text {...(t.state === 'waiting' || t.state === 'blocked' ? { color: 'yellow' as const } : {})}>{`      ${full(t.waitingFor)}`}</Text>}
              {threadControls(t, undefined)}
            </Box>
          ))}
        </Box>
      )}
      {(data.notices ?? []).length > 0 && (
        <Box flexDirection="column">
          <Text bold dimColor>Notices</Text>
          {(data.notices ?? []).slice(-3).map(n => (
            <Text dimColor>{`  ${n.at.slice(11, 16)} ${n.text.slice(0, 200)}`}</Text>
          ))}
        </Box>
      )}
      {v.error === undefined && groups.length === 0 && <Text dimColor>No other background sessions in this repo.</Text>}
      {groups.map(g => (
        <Box flexDirection="column">
          <Text bold dimColor>{`${GROUP_LABEL[g.group]} (${g.rows.length})`}</Text>
          {g.rows.map(r => (
            <Text dimColor>
              {`  ${r.id ?? r.sessionId.slice(0, 8)}  ${r.name ?? ''}  ${ago(r.startedAt, now)}${r.waitingFor ? `  · ${r.waitingFor}` : ''}${r.pid === undefined ? '  · exited' : ''}`}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
