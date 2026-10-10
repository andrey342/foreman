// The Overview pane: foreman's threads first, then the repo's other
// background sessions, grouped by state. Pure: it gets the surface's element
// table and the values to draw.

import type { ElementTable } from 'claude-code'
import type { ForemanCycle, ForemanReview, ForemanThread, ForemanView } from '../../types'
import { GROUP_LABEL, ago, groupRows } from '../lib/agents'
import { isActive } from '../lib/cycle'
import { reviewSummary } from '../lib/reviews'
import { STATE_LABEL, tokens } from '../lib/threads'

export type PaneData = { view: ForemanView; threads: readonly ForemanThread[]; reviews?: readonly ForemanReview[]; cycles?: readonly ForemanCycle[]; warnings: readonly string[] }
export type PaneActions = {
  refresh: () => void
  /** Copies `claude attach <id>` to the clipboard of the surface pressed on. */
  open: (id: string, surface: string) => void
  /** Starts a review of the thread's run part. */
  review: (id: string) => void
  /** Sends the text to the thread (a /foreman tell). */
  reply: (id: string, text: string) => void
}

export function paneTree(els: ElementTable, data: PaneData, actions: PaneActions) {
  const { Box, Text, Button } = els
  // the mobile surface draws no text field yet: Reply is left out there
  const Input = 'Input' in els ? els.Input : undefined
  const v = data.view
  const now = v.refreshedAt
  const open = data.threads.filter(t => !t.closed)
  const threadIds = new Set(data.threads.map(t => t.id))
  const groups = groupRows(v.rows.filter(r => r.id === undefined || !threadIds.has(r.id)))
  const listed = v.refreshedAt ? `listed ${new Date(v.refreshedAt).toLocaleTimeString()}` : 'not listed yet'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{v.root ? `${v.root} · ${listed}` : listed}</Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => actions.refresh()} />
      </Box>
      {v.error !== undefined && <Text color="red">{v.error}</Text>}
      {data.warnings.length > 0 && <Text color="yellow">{`${data.warnings.length} profile warning(s): /foreman profile`}</Text>}
      <Box flexDirection="column">
        <Text bold>{`Threads (${open.length})`}</Text>
        {open.length === 0 && <Text dimColor>  None yet: /foreman launch {'<role>'} "{'<task>'}"</Text>}
        {open.map((t, i) => (
          <Box flexDirection="column">
            <Text>{`  ${i + 1}. ${t.id}  ${t.name}  · ${STATE_LABEL[t.state]}${t.waitingFor ? ` (${t.waitingFor.slice(0, 50)})` : ''}`}</Text>
            <Text dimColor>{`     ${t.model}/${t.effort} · ${tokens(t)}${t.lastResult ? ` · ${t.lastResult.summary.slice(0, 70)}` : ''}`}</Text>
            {t.lastLine !== undefined && <Text dimColor>{`     › ${t.lastLine}`}</Text>}
            <Box flexDirection="row" gap={1}>
              <Text>{'    '}</Text>
              <Button key={`open:${t.id}`} label="Open" dimColor onPress={press => actions.open(t.id, press.surface)} />
              {t.runId !== undefined && t.state === 'ready' && <Button key={`review:${t.id}`} label="Review" dimColor onPress={() => actions.review(t.id)} />}
              {Input !== undefined && t.state !== 'working' && (
                <Input key={`reply:${t.id}`} placeholder={t.state === 'waiting' ? 'answer it…' : 'tell it…'} submitLabel="Reply" onSubmit={text => actions.reply(t.id, text)} />
              )}
            </Box>
          </Box>
        ))}
      </Box>
      {(data.cycles ?? []).filter(isActive).length > 0 && (
        <Box flexDirection="column">
          <Text bold>Cycles</Text>
          {(data.cycles ?? []).filter(isActive).map(c => (
            <Text>{`  ${c.id}  · ${c.phase}${c.reason ? ` (${c.reason.slice(0, 60)})` : ''} · ${c.rounds.map(r => `r${r.n} ${r.verdict}`).join(', ') || 'no review yet'} · max ${c.maxCycles}${c.night ? ' · night' : ''}`}</Text>
          ))}
        </Box>
      )}
      {(data.reviews ?? []).length > 0 && (
        <Box flexDirection="column">
          <Text bold>Reviews</Text>
          {(data.reviews ?? []).slice(-3).map(r => (
            <Text dimColor={r.finishedAt !== undefined}>{`  ${r.finishedAt ? reviewSummary(r) : `${r.kind === 'review' ? 'Review' : 'Critique'} ${r.part} r${r.n}: running`}`}</Text>
          ))}
        </Box>
      )}
      {v.error === undefined && groups.length === 0 && <Text dimColor>No other background sessions in this repo.</Text>}
      {groups.map(g => (
        <Box flexDirection="column">
          <Text bold>{`${GROUP_LABEL[g.group]} (${g.rows.length})`}</Text>
          {g.rows.map(r => (
            <Text>
              {`  ${r.id ?? r.sessionId.slice(0, 8)}  ${r.name ?? ''}  ${ago(r.startedAt, now)}${r.waitingFor ? `  · ${r.waitingFor}` : ''}${r.pid === undefined ? '  · exited' : ''}`}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
