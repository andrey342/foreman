import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'foreman spike',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

test('the pane button counts presses on terminal and desktop', async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'foreman-spike', surface, component: 'Pane', requestId: 'fspike', props: PANE_PROPS })
    const before = Number(/presses: (\d+)/.exec((await ui.find({ type: 'Text', text: /presses/ }))?.text ?? '')?.[1])
    await ui.press({ key: 'press' })
    const after = (await ui.find({ type: 'Text', text: /presses/ }))?.text
    expect(after).toBe(`presses: ${before + 1}`)
    await ui.unmount()
  }
})
