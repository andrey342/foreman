import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'fspike'
const presses = atom({ plugin: 'foreman-spike', key: 'presses' } as const, 0)
const lastAnswer = atom({ plugin: 'foreman-spike', key: 'lastAnswer' } as const, '')
const OUT = 'spike-out.json'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const loads = Number((await $.store.get('loads')) ?? 0) + 1
    await $.store.set('loads', loads)
    await $.command.register({ name: 'fspike', description: 'foreman spike probes', argumentHint: 'proc|spawn|pane|store' })
    await $.agent.register({
      name: 'echo',
      description: 'Spike agent: answers one word',
      prompt: 'You answer with exactly the word the user asks for and nothing else.',
      tools: [],
      model: 'haiku',
      effort: 'low',
    })
    $.ui.status(`fspike: loads=${loads}`)
    return next(e)
  })

  on('command.run', { command: 'fspike' }, async ($, e) => {
    const sub = e.args.trim().split(/\s+/)[0] ?? ''
    if (sub === 'proc') {
      const results: Record<string, unknown> = {}
      for (const exe of ['claude', 'claude.exe', 'C:\\Users\\you\\.local\\bin\\claude.exe']) {
        try {
          const r = await $.process.run([exe, 'agents', '--json', '--all'], { timeoutMs: 20_000 })
          const list = JSON.parse(r.stdout) as unknown[]
          results[exe] = { exitCode: r.exitCode, count: list.length, stderr: r.stderr.slice(0, 200) }
        } catch (err) {
          results[exe] = { error: String(err) }
        }
      }
      await $.fs.write(OUT, JSON.stringify({ proc: results }, null, 2))
      return { text: `proc: ${JSON.stringify(results)}` }
    }
    if (sub === 'spawn') {
      const r = await $.agent.spawn({ subagentType: 'foreman-spike:echo', prompt: 'Say the word PONG.', description: 'spike echo' })
      await $.store.set('spawnedAgentId', r.agentId ?? null)
      return { text: `spawn: ${JSON.stringify(r)}` }
    }
    if (sub === 'pane') {
      const opened = await $.ui.open({ id: PANE, title: 'foreman spike' })
      return { text: `pane: ${JSON.stringify(opened)}` }
    }
    if (sub === 'store') {
      const keys = await $.store.keys()
      const values: Record<string, unknown> = {}
      for (const k of keys) values[k] = await $.store.get(k)
      return { text: `store: ${JSON.stringify(values)}` }
    }
    return { text: 'usage: /fspike proc|spawn|pane|store' }
  })

  on('turn.complete', async ($, e, next) => {
    const spawned = await $.store.get('spawnedAgentId')
    if (e.agentId !== undefined && e.agentId === spawned) {
      await $.store.set('spawnAnswer', { agentId: e.agentId, answer: e.answer, usage: e.usage ?? null })
      await update($, lastAnswer, () => e.answer)
      await $.fs.write('spike-spawn.json', JSON.stringify({ agentId: e.agentId, answer: e.answer, usage: e.usage ?? null }, null, 2))
      $.ui.toast(`fspike: subagent answered ${e.answer}`)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const n = await read($, presses)
    const answer = await read($, lastAnswer)
    return (
      <Box flexDirection="column">
        <Text>presses: {n}</Text>
        <Text dimColor>last subagent answer: {answer || '-'}</Text>
        <Button
          key="press"
          label="Press"
          onPress={async () => {
            const v = await update($, presses, x => (x ?? 0) + 1)
            await $.store.set('presses', v)
          }}
        />
      </Box>
    )
  })
}
