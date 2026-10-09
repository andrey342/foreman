// The Overview pane: this repo's background sessions, grouped by state.
// Pure: it gets the surface's element table and the values to draw.

import type { ElementTable } from 'claude-code'
import type { ForemanView } from '../../types'
import { GROUP_LABEL, ago, groupRows } from '../lib/agents'

export type PaneData = { view: ForemanView; warnings: readonly string[] }
export type PaneActions = { refresh: () => void }

export function paneTree(els: ElementTable, data: PaneData, actions: PaneActions) {
  const { Box, Text, Button } = els
  const v = data.view
  const now = v.refreshedAt
  const groups = groupRows(v.rows)
  const listed = v.refreshedAt ? `listed ${new Date(v.refreshedAt).toLocaleTimeString()}` : 'not listed yet'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{v.root ? `${v.root} · ${listed}` : listed}</Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => actions.refresh()} />
      </Box>
      {v.error !== undefined && <Text color="red">{v.error}</Text>}
      {data.warnings.length > 0 && <Text color="yellow">{`${data.warnings.length} profile warning(s): /foreman profile`}</Text>}
      {v.error === undefined && groups.length === 0 && <Text dimColor>No background sessions in this repo.</Text>}
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
