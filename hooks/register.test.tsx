import { expect, mock, test } from 'claude-code/testing'

import type { Board, ChildRecord, Pulse, RegistryEntry } from '../types'

const HOUR = 60 * 60 * 1000
const NOW = 100 * HOUR
const ME = 'me-0000'

type On = Parameters<Parameters<typeof test>[1]>[1]

const reg = (sessionId: string, name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid: Number(`${sessionId.length}${sessionId.charCodeAt(0)}`),
  sessionId,
  cwd: '/repo',
  startedAt: NOW - 60_000,
  name,
  status: 'idle',
  ...over,
})

const pulse = (title: string, over: Partial<Pulse> = {}): Pulse => ({ at: NOW - 10_000, title, cwd: '/repo', usd: 1, shells: [], ...over })

/**
 * Answers everything session.start reaches beneath the plugin: the clock, the
 * store, the session registry and `ps` in memory, and the last board the plugin
 * wrote, kept in `seen`.
 */
function world(on: On, store: Record<string, unknown>, registry: RegistryEntry[] = [], dead: number[] = [], checklist: unknown = { title: 'checklist', groups: [] }) {
  const clock = mock.clock(on, { now: NOW })
  const seen: { board?: Board } = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('state.set', ($, e, next) => {
    // An atom's value travels in its shape envelope: { shape, value }.
    const board = (e.value as { value?: Board } | undefined)?.value
    if (e.key === 'board' && board) seen.board = board
    return next(e)
  })
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('env.get', () => ({ value: '/home' }))
  on('command.register', () => ({ value: { command: 'session-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { percent: 42, tokens: 84_000, window: 200_000 }, rateLimits: [], cost: { usd: 2.5 } } as never }))
  on('process.run', (_, e) => {
    // `ps -o pid= -p 1,2,3`: every pid asked for is alive unless the test killed it.
    const asked = (e.argv[e.argv.length - 1] ?? '').split(',').map(Number)
    return { value: { stdout: asked.filter(pid => !dead.includes(pid)).join('\n'), stderr: '', code: 0 } as never }
  })
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/sessions') ? registry.map(one => ({ name: `${one.pid}.json`, kind: 'file', mtimeMs: NOW })) : [],
  }))
  on('fs.read', (_, e) => {
    const one = registry.find(r => e.path.endsWith(`/${r.pid}.json`))
    return { value: JSON.stringify(one ?? checklist) }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const board = () => {
    if (!seen.board) throw new Error('the plugin wrote no board')
    return seen.board
  }
  return { clock, board }
}

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], clock: { settle: () => Promise<unknown> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

const spawned = (title: string, over: Partial<ChildRecord> = {}): ChildRecord => ({ title, at: NOW - 120_000, tool: 'start_session', ...over })

test('child sessions are the ones this session spawned, found by title; strangers are left out', async ($, on) => {
  const child = reg('child-1', 'Fix the parser')
  const stranger = reg('other-1', 'Something else')
  const { clock, board } = world(on, { [`children:${ME}`]: [spawned('Fix the parser')] }, [child, stranger])
  await start($, clock)

  expect(board().children.map(c => c.id)).toEqual(['child-1'])
})

test("a child's own children show beneath it, one level deeper", async ($, on) => {
  const child = reg('child-1', 'Fix the parser')
  const grand = reg('grand-1', 'Add a test', { startedAt: NOW - 30_000 })
  const { clock, board } = world(
    on,
    { [`children:${ME}`]: [spawned('Fix the parser')], 'children:child-1': [spawned('Add a test', { at: NOW - 40_000 })] },
    [child, grand],
  )
  await start($, clock)

  expect(board().children.map(c => [c.id, c.depth])).toEqual([
    ['child-1', 1],
    ['grand-1', 2],
  ])
})

test('a child that has closed drops off', async ($, on) => {
  const child = reg('child-1', 'Fix the parser')
  const { clock, board } = world(on, { [`children:${ME}`]: [spawned('Fix the parser')] }, [child], [child.pid])
  await start($, clock)

  expect(board().children).toEqual([])
})

test('a session started before the spawn was recorded is not its child', async ($, on) => {
  const early = reg('early-1', 'Fix the parser', { startedAt: NOW - HOUR })
  const { clock, board } = world(on, { [`children:${ME}`]: [spawned('Fix the parser')] }, [early])
  await start($, clock)

  expect(board().children).toEqual([])
})

test('a child stays linked after /rename', async ($, on) => {
  const store: Record<string, unknown> = { [`children:${ME}`]: [spawned('Fix the parser')] }
  const child = reg('child-1', 'Fix the parser')
  const registry = [child]
  const { clock, board } = world(on, store, registry)
  await start($, clock)
  expect(board().children.map(c => c.id)).toEqual(['child-1'])

  registry[0] = { ...child, name: 'parser, renamed' }
  await clock.advance(3000)
  expect(board().children.map(c => [c.id, c.title])).toEqual([['child-1', 'parser, renamed']])
})

test('a spawn with no session yet counts as proposed', async ($, on) => {
  const { clock, board } = world(on, { [`children:${ME}`]: [spawned('Not started'), spawned('Long gone', { at: NOW - 3 * 24 * HOUR })] })
  await start($, clock)

  expect(board().children).toEqual([])
  expect(board().proposed).toBe(1)
})

test('the fleet holds every other open session, and drops one whose pulse is stale', async ($, on) => {
  const { clock, board } = world(on, {
    'pulse:open': pulse('open', { shells: [{ id: 's1', command: 'sleep 9999', startedAt: NOW - 20 * 60_000, status: 'running' }] }),
    'pulse:closed': pulse('closed', { at: NOW - 5 * 60_000 }),
  })
  await start($, clock)

  expect(board().fleet.map(f => f.id)).toEqual(['open'])
  expect(board().fleet[0]?.pulse.shells[0]?.command).toBe('sleep 9999')
})

test('the session publishes its pulse on start and every 30 seconds', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = world(on, store)
  await start($, clock)
  expect((store[`pulse:${ME}`] as Pulse).at).toBe(NOW)
  expect((store[`pulse:${ME}`] as Pulse).usd).toBe(2.5)
  expect((store[`pulse:${ME}`] as Pulse).ctx).toBe(42)

  await clock.advance(30_000)
  expect((store[`pulse:${ME}`] as Pulse).at).toBe(NOW + 30_000)
})

test('a background shell is published at once, so the others can see it', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = world(on, store)
  on('tool.call', () => ({ result: { backgroundTaskId: 'bg1' } as never }))
  await start($, clock)

  await $.tool.call({ tool: 'Bash', command: 'sleep 9999', description: 'sleep forever', run_in_background: true })
  await clock.settle()

  expect((store[`pulse:${ME}`] as Pulse).shells).toEqual([{ id: 'bg1', command: 'sleep forever', startedAt: NOW, status: 'running' }])
})

test('a spawn tool call records its title for the child to be found by', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { clock } = world(on, store)
  on('tool.call', () => ({ result: {} }))
  await start($, clock)

  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Fix the parser', prompt: 'go' } as never)
  await clock.settle()

  expect((store[`children:${ME}`] as ChildRecord[]).map(r => [r.title, r.tool])).toEqual([['Fix the parser', 'start_session']])
})

const PANE = {
  plugin: 'session-monitor',
  component: 'Pane',
  requestId: 'session-monitor',
  props: { title: 'HUD', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

test('the pane totals every session, flags a long shell, and lists only child sessions', async ($, on) => {
  const child = reg('child-1', 'Fix the parser', { status: 'busy' })
  const stranger = reg('other-1', 'Unrelated work')
  const { clock } = world(
    on,
    {
      [`children:${ME}`]: [spawned('Fix the parser')],
      'pulse:other-1': pulse('Unrelated work', {
        usd: 4,
        shells: [{ id: 's1', command: 'pnpm build --watch', startedAt: NOW - 45 * 60_000, status: 'running' }],
      }),
    },
    [child, stranger],
  )
  await start($, clock)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /CTX/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /84k\/200k/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /all sessions/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 long/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /pnpm build --watch/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Fix the parser/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the options hide every panel but the vitals', { options: { showTasks: false, showShells: false, showAgents: false, showSkills: false, showMcp: false } }, async ($, on) => {
  const child = reg('child-1', 'Fix the parser', { status: 'busy' })
  const { clock } = world(on, { [`children:${ME}`]: [spawned('Fix the parser')], 'pulse:other-1': pulse('Unrelated work', { shells: [{ id: 's1', command: 'pnpm build --watch', startedAt: NOW - 60_000, status: 'running' }] }) }, [child, reg('other-1', 'Unrelated work')])
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /CTX/ })).toBeTruthy()
  for (const label of [/TASKS/, /SHELLS/, /AGENTS/, /SKILLS/, /MCP/, /Fix the parser/, /pnpm build --watch/]) {
    expect(await ui.find({ type: 'Text', text: label })).toBeFalsy()
  }
  await ui.unmount()
})

test('hiding tasks leaves the shells panel', { options: { showTasks: false } }, async ($, on) => {
  const { clock } = world(on, { 'pulse:other-1': pulse('Unrelated work', { shells: [{ id: 's1', command: 'pnpm build --watch', startedAt: NOW - 60_000, status: 'running' }] }) }, [reg('other-1', 'Unrelated work')])
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /TASKS/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /pnpm build --watch/ })).toBeTruthy()
  await ui.unmount()
})

test('/session-monitor help lists each panel option with its value', { options: { showMcp: false } }, async ($, on) => {
  const { clock } = world(on, {})
  await start($, clock)

  const { text } = await $.command.run({ command: 'session-monitor', args: 'help', origin: { kind: 'plugin', name: 'session-monitor' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(text).toMatch(/showTasks\s+.*on/)
  expect(text).toMatch(/showMcp\s+.*off/)
  expect(text).toMatch(/hooks\/register\.tsx/)
})

test('a checklist draws gated 🔒, approved 🔓, doing ▶️ and done ✅', async ($, on) => {
  const { clock } = world(on, {}, [], [], {
    title: 'plan',
    groups: [
      {
        title: 'steps',
        steps: [
          { label: 'wait', status: 'gated' },
          { label: 'cleared', status: 'approved' },
          { label: 'working', status: 'doing' },
          { label: 'finished', status: 'done' },
        ],
      },
    ],
  })
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const [mark, label] of [['🔒', 'wait'], ['🔓', 'cleared'], ['▶️', 'working'], ['✅', 'finished']]) {
    expect(await ui.find({ type: 'Text', text: new RegExp(`${mark}.*${label}`) })).toBeTruthy()
  }
  await ui.unmount()
})
