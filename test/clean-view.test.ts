import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cleanName } from '../hooks/clean-view'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

type ToolAnswer = { result: unknown; isError?: true; text?: string }

/** The engine beneath the plugin: a store and clock in memory, and tools that succeed unless told otherwise. */
function world(on: On, tools: () => ToolAnswer | Promise<ToolAnswer> = () => ({ result: 'ok' })) {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}))
  on('tool.call', () => tools() as never)
  return clock
}

const endTurn = (reason: 'answer' | 'aborted' | 'error', answer = '') =>
  ({ reason, answer, durationMs: 1000, isAborted: reason === 'aborted', turnId: 't1' }) as const

async function startPlanned($: Engine) {
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
}

const band = (surface: (typeof SURFACES)[number]) =>
  ({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND }) as const

test('names are cleaned to plain words', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Update src/app/page.tsx header')).toBe('Update header')
  expect(cleanName('fix Pricing.tsx layout')).toBe('Fix layout')
  const long = cleanName('Make the whole landing page responsive for every phone tablet and desktop size ok')
  expect(long.length <= 40).toBe(true)
  expect(long.endsWith('…')).toBe(true)
  expect(cleanName('`npm test`')).toBe('Working on it')
})

test('a to-do list plus a 60% report draws done, current, next and up next rows', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ text: /✓/ })).toBeDefined()
    expect(await ui.find({ text: /▶/ })).toBeDefined()
    expect(await ui.find({ text: '60%' })).toBeDefined()
    expect(await ui.find({ text: '██████░░░░' })).toBeDefined()
    expect(await ui.find({ text: 'Next' })).toBeDefined()
    expect(await ui.find({ text: 'Up next' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Build the pricing section/ }))?.props.bold).toBe(true)
    await ui.unmount()
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ text: /Claude needs your OK to continue/ })).toBeDefined()
  expect(await ui.find({ text: /‖/ })).toBeDefined()
})

test('/simple off hides the band but keeps the button, and tool rows come back', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const hidden = await $.ui.mount({
    plugin: 'clean-view', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: 'u1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await hidden.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })

  await $.command.run({
    command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 },
  })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ text: /Build my landing page/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button' }))?.props.label).toBe('○ Clean View: OFF')
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const noted = await $.tool.call({ tool: PROGRESS, task: 'Read your brand notes', percent: 100 })
  expect(noted.result).toBe('Progress noted: 100%.')
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ text: 'Done' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Build the pricing section/ }))?.props.bold).toBe(true)
  expect(await ui.find({ text: 'Working' })).toBeDefined()
  expect(await ui.find({ text: 'Next' })).toBeDefined()
})

test('tools are denied before a plan exists and allowed after', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const before = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(JSON.stringify(before)).toContain('plan_steps')
  await $.tool.call({ tool: PLAN, steps: ['Look around', 'Answer the question'] })
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(after.result).toBe('ok')
})

test('a finished job says All done with the time, then shrinks to one line after 5 seconds', async ($, on) => {
  const clock = world(on)
  await startPlanned($)
  await clock.advance(134_000)
  await $.tool.call({ tool: PROGRESS, task: 'Add the contact form', percent: 100 })
  await $.turn.complete(endTurn('answer'))
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /✓ All done · .* · took 2m 14s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read your brand notes/ })).toBeDefined()
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Read your brand notes/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /✓ All done/ })).toBeDefined()
})

test('the header counts steps and the busy line names the current step', async ($, on) => {
  world(on)
  let spinnerSaid: unknown
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    spinnerSaid = e.props.message
    return $.ui.resolve(e).Box({})
  })
  await startPlanned($)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /step 1 of 3/ })).toBeDefined()
  const spinner = await $.ui.mount({
    plugin: 'clean-view', surface: 'terminal', component: 'Spinner',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
  })
  expect(await spinner.drawn()).toBeDefined()
  expect(spinnerSaid).toBe('Read your brand notes')
})

test('Esc shows Stopped, and unfinished steps wait for your reply', async ($, on) => {
  world(on)
  await startPlanned($)
  await $.turn.complete(endTurn('answer'))
  let ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /Claude is waiting for your reply/ })).toBeDefined()
  await $.turn.start({ text: 'yes, go ahead', turnId: 't2' })
  await $.turn.complete(endTurn('aborted'))
  ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /■ Stopped · .* · you pressed Esc/ })).toBeDefined()
})

test('an API error becomes one calm sentence', async ($, on) => {
  world(on)
  await startPlanned($)
  await $.turn.complete(endTurn('error', 'API Error: 529 Overloaded'))
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: "⚠ Stuck: Claude's servers are busy, try again in a minute" })).toBeDefined()
})

test('three failures in a row show Stuck, and a success clears it', async ($, on) => {
  let isFailing = true
  world(on, () => (isFailing ? { result: 'boom', isError: true, text: 'boom' } : { result: 'ok' }))
  await startPlanned($)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'false' })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /a step keeps failing, Claude is trying another way/ })).toBeDefined()
  isFailing = false
  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(await ui.find({ type: 'Text', text: /Stuck/ })).toBeUndefined()
})

test('the card frames the job, shows overall progress and fine-grained bars, and goes flat when short of room', async ($, on) => {
  world(on)
  await startPlanned($)
  await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 64 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { borderStyle: 'round', borderColor: 'cyan' } })
    expect(await ui.find({ type: 'Text', text: '██████▍░░░' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  55%' })).toBeDefined()
    await ui.unmount()
  }
  const short = await $.ui.mount({ ...band('terminal'), props: { ...BAND, maxRows: 4 } })
  expect(await short.drawn()).not.toMatchObject({ props: { borderStyle: 'round' } })
})

test('a quick answer needs no plan, may look things up, and leaves no card behind', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'What does this spreadsheet say about March?', turnId: 't1' })
  const looked = await $.tool.call({ tool: 'Read', file_path: '/Users/me/budget.xlsx' })
  expect(looked.result).toBe('ok')
  await $.turn.complete(endTurn('answer'))
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /All done/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'clean-view-toggle' })).toBeDefined()
})

test('the receipt counts what really changed and lists it on request', async ($, on) => {
  let answer: ToolAnswer = { result: 'ok' }
  world(on, () => answer)
  await startPlanned($)
  answer = { result: { type: 'create' } }
  await $.tool.call({ tool: 'Write', file_path: '/Users/me/site/contact.html', content: '<form>' })
  answer = { result: 'ok' }
  await $.tool.call({ tool: 'Edit', file_path: '/Users/me/site/pricing.html', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await $.tool.call({ tool: PROGRESS, task: 'Add the contact form', percent: 100 })
  await $.turn.complete(endTurn('answer'))
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /changed 1 file · created 1 file · ran 1 command/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /created contact.html/ })).toBeUndefined()
  await ui.press({ key: 'clean-view-changes' })
  expect(await ui.find({ type: 'Text', text: '+ created contact.html' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✎ changed pricing.html' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /commands can change things this list can't show/ })).toBeDefined()
})

test('Needs you says what the OK is for', async ($, on) => {
  let release = () => {}
  const held = new Promise<ToolAnswer>(resolve => { release = () => resolve({ result: 'ok' }) })
  const clock = world(on, () => held)
  await startPlanned($)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf old-photos' })
  await clock.settle()
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: / Claude needs your OK to delete something/ })).toBeDefined()
  release()
  await call
  expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeUndefined()
})

const AGENT_DONE = { result: { status: 'completed', agentId: 'h1', content: [], totalDurationMs: 1, prompt: '' } }

test('a helper shows under its step while it works, then shows done', async ($, on) => {
  let release = () => {}
  const held = new Promise<ToolAnswer>(resolve => { release = () => resolve(AGENT_DONE) })
  const clock = world(on, () => held)
  await startPlanned($)
  const call = $.tool.call({ tool: 'Agent', description: 'Research competitor prices', prompt: 'look around' })
  await clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Helper: Research competitor prices/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^working · / })).toBeDefined()
    await ui.unmount()
  }
  release()
  await call
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
})

test('a background helper keeps the job going until it reports back', async ($, on) => {
  world(on, () => ({ result: { status: 'async_launched', agentId: 'bg1', description: 'Write the pricing copy', prompt: '', outputFile: '' } }))
  await startPlanned($)
  await $.tool.call({ tool: 'Agent', description: 'Write the pricing copy', prompt: 'write', run_in_background: true })
  await $.tool.call({ tool: PROGRESS, task: 'Add the contact form', percent: 100 })
  await $.turn.complete(endTurn('answer'))
  let ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /All done/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Helper: Write the pricing copy/ })).toBeDefined()
  await $.turn.complete({ ...endTurn('answer'), agentId: 'bg1', turnId: 'h-turn' })
  await $.turn.start({ text: '<task-notification>helper finished</task-notification>', turnId: 't2' })
  await $.turn.complete(endTurn('answer'))
  ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /✓ All done · Build my landing page/ })).toBeDefined()
})

test("a helper's permission prompt says the helper needs your OK", async ($, on) => {
  let release = () => {}
  const held = new Promise<ToolAnswer>(resolve => { release = () => resolve({ result: { type: 'create' } }) })
  const clock = world(on, () => held)
  await startPlanned($)
  const call = $.tool.call({ tool: 'Write', file_path: '/Users/me/notes.md', content: 'hi', agentId: 'h7' } as never)
  await clock.settle()
  await $.classic.Notification({ message: 'Claude needs your permission to use Write', notification_type: 'permission_prompt' })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: / Claude's helper needs your OK to save notes.md/ })).toBeDefined()
  release()
  await call
})
