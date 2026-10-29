import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: '2099-01-01T00:00:00Z' },
  { kind: 'seven_day', percentUsed: 12.5 },
]
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
} as const

const boot = async ($: any, on: any) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

test('the band shows percent left for each window, 7D before 5H, on every surface', async ($, on) => {
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: '42% left' })).toBeDefined()
    expect(await band.find({ text: '87.5% left' })).toBeDefined()
    const all = JSON.stringify(await band.find({ type: 'Box' }))
    expect(all.indexOf('7D')).toBeLessThan(all.indexOf('5H'))
    // No request seen yet: no cache chip.
    expect(await band.find({ key: 'cache' })).toBeUndefined()
    await band.unmount()
  }
})

test('a narrow band stacks each window with its reset time on its own line', async ($, on) => {
  await boot($, on)
  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 36 } })
  expect(await band.find({ text: '42% left' })).toBeDefined()
  expect(await band.find({ text: 'resets 2h 0m' })).toBeDefined()
  await band.unmount()
})

test('a resumed session 18 minutes idle shows WARM with 42m left and the cached tokens', async ($, on) => {
  await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 245000, model: 'claude-opus-5-5' })
  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' WARM ' })).toBeDefined()
  expect(await band.find({ text: ' 42m left' })).toBeDefined()
  expect(await band.find({ text: ' · 245k' })).toBeDefined()
  // Robo leads the cache on the desktop, in place of a text label.
  const alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts).toEqual(['Robo, bobbing'])
  expect(await band.find({ text: 'CACHE ' })).toBeUndefined()
  await band.unmount()
})

test('a row a few cells too long drops the token count before it stacks', async ($, on) => {
  await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 245000 })
  // 94 columns: the full row with Robo runs to about 97 cells, so the count goes and the row stays.
  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 94 } })
  expect(await band.find({ text: ' 42m left' })).toBeDefined()
  expect(await band.find({ key: 'tok' })).toBeUndefined()
  // Still one row: the 7D block is a row, not a stacked column.
  expect((await band.find({ key: 'w-0' }))?.props.flexDirection).toBe('row')
  await band.unmount()

  // 80 columns: too narrow even without the tokens, so each window stacks and the tokens are back on their own line.
  const half = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 80 } })
  expect((await half.find({ key: 'w-0' }))?.props.flexDirection).toBe('column')
  expect(await half.find({ text: '245k tokens' })).toBeDefined()
  await half.unmount()
})

test('55 minutes idle reads COOLING; three days idle reads COLD with the idle time', async ($, on) => {
  await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 55 * 60, context_tokens: 1000 })
  const warm = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await warm.find({ text: ' COOLING ' })).toBeDefined()
  expect(await warm.find({ text: ' 5m left' })).toBeDefined()
  await warm.unmount()

  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: (3 * 24 + 9) * 3600, context_tokens: 1000 })
  const cold = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await cold.find({ text: ' COLD ' })).toBeDefined()
  expect(await cold.find({ text: ' 3d 9h idle' })).toBeDefined()
  // The terminal has no drawings: the chip alone leads the cache.
  expect(await cold.findAll({ type: 'Svg' })).toEqual([])
  await cold.unmount()

  const desktop = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect((await desktop.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['Robo, frozen'])
  await desktop.unmount()
})

test('a cleared session drops the cache until the next reply', async ($, on) => {
  await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 245000 })
  await $.classic.SessionStart({ source: 'clear' })
  const band = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ key: 'cache' })).toBeUndefined()
  expect(await band.find({ text: '87.5% left' })).toBeDefined()
  await band.unmount()
})
