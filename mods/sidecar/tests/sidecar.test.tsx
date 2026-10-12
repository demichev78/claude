import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE_PROPS = {
  title: 'Sidecar',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40, contentRows: 0 },
  view: {},
} as const

test('an Edit shows up in Recent changes with its line counts and a preview', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // Answer what the engine would: the session's directory, and the Edit itself
  on('session.cwd', () => ({ value: '/repo' }))
  // Answer the Edit in Claude Code's place, with the patch the tool reports
  on('tool.call', () => ({
    result: {
      filePath: '/repo/src/app.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old line', '+new line', '+another'] }],
    },
  }))

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'old line', new_string: 'new line\nanother' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sidecar', surface, component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Recent changes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^app\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /- old line/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Limits/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/sidecar shows the limits and the context breakdown as percentages', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12.5 },
        { kind: 'seven_day', percentUsed: 41 },
        { kind: 'seven_day_fable', percentUsed: 7 },
      ],
      context: {
        tokens: 50000,
        window: 200000,
        percent: 25,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 10000, color: 'promptBorder', isDeferred: false, kind: 'used' },
            { name: 'Skills', tokens: 4000, color: 'permission', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 36000, color: 'claude', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 150000, color: 'inactive', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 50000,
          maxTokens: 200000,
          rawMaxTokens: 200000,
          percentage: 25,
          autocompactSource: 'model-default',
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    },
  }))

  await $.command.run({
    command: 'sidecar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^Session \(5h\) 12\.5%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12.5%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Weekly 41%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Weekly Fable 7%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /System prompt 5%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Skills 2%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Messages 18%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Free 75%$/ })).toBeDefined()
  await ui.unmount()
})

test('a Bash command that changes files shows up in Recent changes', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
  // Answer the Bash call in Claude Code's place, with the per-file diff the tool reports
  on('tool.call', () => ({
    result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      bashEditDiff: {
        files: [
          {
            filePath: '/repo/conf/settings.json',
            hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ['-  "theme": "dark"', '+  "theme": "custom"', '+  "x": 1'] }],
          },
          { filePath: '/repo/notes.md', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }], created: true },
        ],
        moreFiles: 0,
      },
    },
  }))

  await $.tool.call({ tool: 'Bash', command: "sed -i '' s/dark/custom/ conf/settings.json && echo hello > notes.md" })

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^settings\.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^notes\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+ hello/ })).toBeDefined()
  await ui.unmount()
})

test('the Model card shows the main loop model and its effort level', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // Answer the model request in Claude Code's place, so nothing is sent
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for await (const _chunk of stream) {
    // drain the stream
  }

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  // The Model card is first, above Limits
  expect(drawn.indexOf('"Model"')).toBeGreaterThan(-1)
  expect(drawn.indexOf('"Model"')).toBeLessThan(drawn.indexOf('"Limits"'))
  expect(await ui.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'high' })).toBeDefined()
  await ui.unmount()
})

test('the Agents card draws subagents as a tree with their status', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'Explore', description: 'Find auth code', status: 'running' },
      { id: 'a2', type: 'general-purpose', description: 'Read tests', status: 'running', parentId: 'a1' },
      { id: 'a3', type: 'Plan', description: 'Draft the plan', status: 'completed' },
    ],
  }))
  on('session.measure', () => ({ changed: ['context'] }))

  // After a turn the sidecar re-reads the agent list
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.indexOf('"Agents"')).toBeGreaterThan(-1)
  expect(drawn.indexOf('"Agents"')).toBeLessThan(drawn.indexOf('"Recent changes"'))
  // The child is drawn after its parent, indented with a branch mark
  expect(drawn.indexOf('Find auth code')).toBeLessThan(drawn.indexOf('Read tests'))
  // Each agent row is a button that opens its output
  expect(await ui.find({ type: 'Button', key: 'agent-a2', text: /^└ ● general-purpose Read tests$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agent-a1', text: /^● Explore Find auth code$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'agent-a3', text: /^✓ Plan Draft the plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /completed · \d+s$/ })).toBeDefined()
  await ui.unmount()
})

test('clicking an agent opens its output at half the screen width, and closing returns to the sidecar', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const opened: { id: string; columns?: number }[] = []
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, columns: e.columns })
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find auth code', status: 'running' }] }))
  on('session.measure', () => ({ changed: ['context'] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Find where auth tokens are checked', toolUses: [] },
      {
        role: 'assistant',
        text: 'Searching the middleware.',
        toolUses: [{ tool_use_id: 't1', tool: 'Grep', input: { pattern: 'verifyToken' }, text: 'src/auth.ts:12: verifyToken(' }],
      },
    ],
  }))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const sidecar = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: PANE_PROPS,
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  } as never)
  await sidecar.press({ key: 'agent-a1' })

  // The output window opens focused, sized to half of a 200-column terminal
  expect(opened.at(-1)?.id).toBe('sidecar-agent')
  expect(opened.at(-1)?.columns).toBe(98)

  const view = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar-agent', props: PANE_PROPS })
  expect(await view.find({ type: 'Text', text: /^Task: Find where auth tokens are checked$/ })).toBeDefined()
  expect(await view.find({ type: 'Text', text: 'Searching the middleware.' })).toBeDefined()
  expect(await view.find({ type: 'Text', text: /▸ Grep: verifyToken$/ })).toBeDefined()
  expect(await view.find({ type: 'Text', text: /⎿ src\/auth\.ts:12: verifyToken\($/ })).toBeDefined()

  // Its own close button closes it, and the sidecar is opened again at its share
  await view.press({ key: 'close' })
  expect(opened.at(-1)?.id).toBe('sidecar')
  expect(opened.at(-1)?.columns).toBe(38)
  await view.unmount()
  await sidecar.unmount()
})

test('the agent output window updates live as the agent works', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find auth code', status: 'running' }] }))
  on('session.measure', () => ({ changed: ['context'] }))
  let rows = [{ role: 'user', text: 'Find where auth tokens are checked', toolUses: [] as unknown[] }]
  on('session.messages', () => ({ value: rows }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const sidecar = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  await sidecar.press({ key: 'agent-a1' })
  const view = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar-agent', props: PANE_PROPS })
  expect(await view.find({ type: 'Text', text: /^Task: Find where auth tokens are checked$/ })).toBeDefined()
  expect(await view.find({ type: 'Text', text: '⇣ live' })).toBeDefined()

  // The agent replies: its step ends and the window shows the new text without any click
  rows = [...rows, { role: 'assistant', text: 'Found it in src/auth.ts.', toolUses: [] }]
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 2, agentId: 'a1' })) {
    // drain
  }
  expect(await view.find({ type: 'Text', text: 'Found it in src/auth.ts.' })).toBeDefined()

  await view.unmount()
  await sidecar.unmount()
})

test('the Agents card is hidden while there are no subagents', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('session.measure', () => ({ changed: ['context'] }))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('"Agents"')
  expect(drawn).toContain('"Recent changes"')
  await ui.unmount()
})

test('an agent row flips to done as soon as its run completes', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let status: 'running' | 'completed' = 'running'
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find auth code', status }] }))
  on('session.measure', () => ({ changed: ['context'] }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  expect(await ui.find({ type: 'Button', key: 'agent-a1', text: /^● Explore/ })).toBeDefined()

  // The subagent's run ends: no new turn of the main loop is needed for the row to change
  status = 'completed'
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1' } as never)
  expect(await ui.find({ type: 'Button', key: 'agent-a1', text: /^✓ Explore/ })).toBeDefined()
  await ui.unmount()
})

test('cards span the pane with no box, one rule between each pair', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.includes('borderStyle')).toBe(false)
  // Model, Limits, Context, Cache and Recent changes: four rules, none above Model
  const rule = '─'.repeat(PANE_PROPS.bodyColumns)
  expect(drawn.split(rule).length - 1).toBe(4)
  expect(drawn.indexOf(rule)).toBeGreaterThan(drawn.indexOf('"Model"'))
  // Each card's content sits one column in from the left edge
  expect(drawn.split('"paddingLeft":1').length - 1).toBe(5)
  await ui.unmount()
})

const MIN = 60 * 1000

// Answers one main-loop request in Claude Code's place, with the cache usage the API reported
function answerSteps(on: On, usage: { read: number; write: number; input: number }) {
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: usage.input, output_tokens: 5, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, model: 'claude-opus-5-5' },
    }
  })
}

async function step($: Engine) {
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) {
    // drain the stream
  }
}

test('the Cache card shows warm with time left, then cold, and the last request\'s token counts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  answerSteps(on, { read: 157000, write: 2300, input: 12 })
  await step($)

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  // The Cache card sits right under Context
  expect(drawn.indexOf('"Context"')).toBeLessThan(drawn.indexOf('"Cache"'))
  expect(drawn.indexOf('"Cache"')).toBeLessThan(drawn.indexOf('"Recent changes"'))
  expect(await ui.find({ type: 'Text', text: '● Warm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '157k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2.3k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12' })).toBeDefined()
  await ui.unmount()

  await clock.advance(61 * MIN)
  const later = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  expect(await later.find({ type: 'Text', text: '● Cold' })).toBeDefined()
  await later.unmount()
})

test('Keep warm pings once the cache nears its end, and stops when a ping finds it cold', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const forks: number[] = []
  const answers = [{ read: 157000, write: 0 }, { read: 0, write: 157000 }]
  on('model.fork', () => {
    forks.push(forks.length)
    const a = answers.shift() ?? { read: 0, write: 0 }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } }
  })
  answerSteps(on, { read: 157000, write: 0, input: 3 })
  await step($)

  const ui = await $.ui.mount({ plugin: 'sidecar', surface: 'terminal', component: 'Pane', requestId: 'sidecar', props: PANE_PROPS })
  await ui.press({ key: 'keepwarm' })
  expect(await ui.find({ type: 'Text', text: '■ Stop keep-warm' })).toBeDefined()

  // Nothing before fifty idle minutes; one ping just after
  await clock.advance(45 * MIN)
  expect(forks.length).toBe(0)
  await clock.advance(6 * MIN)
  expect(forks.length).toBe(1)
  // The next ping reads nothing: the cache had lapsed, so keep-warm stops
  await clock.advance(51 * MIN)
  expect(forks.length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /Stopped/ })).toBeDefined()
  await clock.advance(2 * 60 * MIN)
  expect(forks.length).toBe(2)
  await ui.unmount()
})

test('seated above the prompt on a narrow screen, the sidecar closes itself instead', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const closed: string[] = []
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: { ...PANE_PROPS, placement: 'inline' },
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.includes('"Model"')).toBe(false)
  await ui.unmount()
  expect(closed).toContain('sidecar')
})
