import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'foreman spike v0.2',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

test('the pane takes a press, a typed reply and a pick on terminal and desktop', async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'foreman-spike', surface, component: 'Pane', requestId: 'fspike', props: PANE_PROPS })
    const before = Number(/presses: (\d+)/.exec((await ui.find({ type: 'Text', text: /presses/ }))?.text ?? '')?.[1])
    await ui.press({ key: 'press' })
    expect((await ui.find({ type: 'Text', text: /presses/ }))?.text).toBe(`presses: ${before + 1}`)
    await ui.input({ key: 'reply', text: `hello ${surface}`, kind: 'submit' })
    expect((await ui.find({ type: 'Text', text: /typed/ }))?.text).toBe(`typed: hello ${surface}`)
    await ui.select({ key: 'mode', value: 'review' })
    expect((await ui.find({ type: 'Text', text: /picked/ }))?.text).toBe('picked: review')
    await ui.unmount()
  }
})
