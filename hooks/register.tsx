import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown, SessionRateLimit } from 'claude-code'

import type { Board, ChecklistFile, ChildRecord, ChildSession, Counts, Pulse, RegistryEntry, Sample, SessionEntry, Shell, TaskItem } from '../types'

const PANE = 'session-monitor'
const TITLE = '🧭 Session HUD'
// About 400 px at a typical terminal cell width of 8 px.
const PANE_COLUMNS = 50
// Change a tag when that value's fields change.
const shells = atom({ plugin: 'session-monitor', key: 'shells' } as const, [], { shape: 'shells-1' })
const skills = atom({ plugin: 'session-monitor', key: 'skills' } as const, {}, { shape: 'counts-1' })
const mcp = atom({ plugin: 'session-monitor', key: 'mcp' } as const, {}, { shape: 'counts-1' })
// Context fill and cost readings for the sparklines.
const history = atom({ plugin: 'session-monitor', key: 'history' } as const, [], { shape: 'samples-1' })
const effort = atom({ plugin: 'session-monitor', key: 'effort' } as const, '')
// Bumped on timers and events so the pane redraws agents, context and the spinner.
const tick = atom({ plugin: 'session-monitor', key: 'tick' } as const, 0)

const board = atom({ plugin: 'session-monitor', key: 'board' } as const, null as Board | null, { shape: 'board-2' })

// Task list: this session's tasks are kept in the plugin store so a parent can show them.
const TASK_EVERY_MS = 3000
const KEEP_MS = 14 * 24 * 60 * 60 * 1000
const SESSION_KEY = (id: string) => `session:${id}`
// Each open session publishes `pulse:<id>` (cost, shells, title) this often and
// whenever its shells change; a pulse older than LIVE_MS means that session closed.
// Vitals and Shells total every open session from these.
const PULSE_EVERY_MS = 30_000
const LIVE_MS = 3 * PULSE_EVERY_MS
const PULSE_KEY = (id: string) => `pulse:${id}`
// `children:<id>` lists the sessions that session spawned.
const CHILDREN_KEY = (id: string) => `children:${id}`
const SPAWN_TOOLS = new Set(['mcp__ccd_session__start_session', 'mcp__ccd_session__spawn_task', 'mcp__ccd_session__hand_off_to_session'])
const SPAWN_SLACK_MS = 10_000
const PROPOSED_MS = 24 * 60 * 60 * 1000
const CHILD_DEPTH = 3
// A shell running this long is a long shell: yellow, then orange, then red.
const LONG_MS = 10 * 60_000
const LONGER_MS = 30 * 60_000
const LONGEST_MS = 60 * 60_000
const HISTORY_MAX = 48

// The status line's palette (configs/claude/statusline.sh), Tokyo Night.
const C = {
  cyan: '#7dcfff',
  teal: '#52d0c4',
  purple: '#bb9af7',
  yellow: '#e0af68',
  orange: '#ff9e64',
  claude: '#cf6444',
  gray: '#565f89',
  green: '#9ece6a',
  dollar: '#85bb65',
  red: '#f7768e',
  white: '#ffffff',
  fg: '#a9b1d6',
  track: '#3b4261',
  cave: '#d78700',
}

// The status line's thresholds: ≤40 green · 41-55 yellow · 56-80 orange · 81+ red.
const heat = (p: number) => (p > 80 ? C.red : p > 55 ? C.orange : p > 40 ? C.yellow : C.green)

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

type Els = ReturnType<EngineInterface['ui']['resolve']>

/** A run of cells drawn in one colour. */
type Seg = { text: string; color: string }

function merge(cells: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last && last.color === cell.color) last.text += cell.text
    else out.push({ ...cell })
  }
  return out
}

function paint(els: Els, segs: Seg[]) {
  const { Text } = els
  return segs.map(s => <Text color={s.color}>{s.text}</Text>)
}

/**
 * A heat bar the full width of the pane: filled cells take the colour of the
 * threshold they sit at, so a full bar runs green to red. `marker` draws ┃ at
 * that percent: the pace a rate-limit window would be at if it were spent
 * evenly. Box-drawing glyphs, which every font draws one cell wide; block
 * glyphs (█░) come out wider in some and overran the pane.
 */
function gauge(pct: number, width: number, marker?: number): Seg[] {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const at = marker === undefined ? -1 : Math.max(0, Math.min(width - 1, Math.floor((marker / 100) * width)))
  const cells: Seg[] = []
  for (let i = 0; i < width; i++) {
    if (i === at) cells.push({ text: '┃', color: i < filled ? C.white : C.fg })
    else if (i < filled) cells.push({ text: '━', color: heat(((i + 1) / width) * 100) })
    else cells.push({ text: '─', color: C.track })
  }
  return merge(cells)
}

const SPARK = '▁▂▃▄▅▆▇█'

function spark(values: number[], color: (v: number) => string, top?: number): Seg[] {
  if (values.length === 0) return []
  const hi = top ?? Math.max(...values)
  const lo = top === undefined ? Math.min(...values) : 0
  const span = hi - lo || 1
  return merge(values.map(v => ({ text: SPARK[Math.max(0, Math.min(7, Math.round(((v - lo) / span) * 7)))] ?? '▁', color: color(v) })))
}

/** A one-colour progress line for the terminal; the count goes on the row above. */
const plainBar = (pct: number, width: number, color: string): Seg[] => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return [
    { text: '━'.repeat(filled), color },
    { text: '─'.repeat(width - filled), color: C.track },
  ]
}

const BAR_H = 8

/**
 * The desktop draws text in a proportional face, so a bar made of glyphs
 * never matches the pane: there a bar is an SVG stretched to the slot. 'heat'
 * fills with the green-to-red ramp laid across the whole track, so the colour
 * at the bar's end is the colour of the threshold it reached.
 */
function svgBar(pct: number, fill: string, marker?: number): string {
  const w = Math.max(0, Math.min(100, pct))
  const ramp =
    fill === 'heat'
      ? `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="100" y1="0" y2="0"><stop offset="0.4" stop-color="${C.green}"/><stop offset="0.55" stop-color="${C.yellow}"/><stop offset="0.8" stop-color="${C.orange}"/><stop offset="1" stop-color="${C.red}"/></linearGradient></defs>`
      : ''
  const paintWith = fill === 'heat' ? 'url(#g)' : fill
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAR_H}" viewBox="0 0 100 ${BAR_H}" preserveAspectRatio="none">` +
    ramp +
    `<rect x="0" y="0" width="100" height="${BAR_H}" rx="0.8" ry="${BAR_H / 2}" fill="${C.track}"/>` +
    (w > 0 ? `<rect x="0" y="0" width="${w}" height="${BAR_H}" rx="0.8" ry="${BAR_H / 2}" fill="${paintWith}"/>` : '') +
    (marker !== undefined ? `<rect x="${Math.max(0, Math.min(99.2, marker - 0.4))}" y="0" width="0.8" height="${BAR_H}" fill="${C.white}"/>` : '') +
    '</svg>'
  )
}

/** A bar the full width of the pane. `marker` is a percent, the ┃ pace tick. */
function Bar({ els, pct, fill, marker, cols, alt }: { els: Els; pct: number; fill: string; marker?: number; cols: number; alt: string }) {
  if ('Svg' in els) {
    const { Svg } = els
    // Without `height` the surface scales the markup's height with its width: a 100×8 viewBox drawn 500 px wide stood 40 px tall.
    return <Svg source={svgBar(pct, fill, marker)} alt={alt} height={BAR_H} />
  }
  const { Text } = els
  return <Text wrap="truncate-end">{paint(els, fill === 'heat' ? gauge(pct, cols, marker) : plainBar(pct, cols, fill))}</Text>
}

const ratio = (done: number, total: number) => (total > 0 ? (done / total) * 100 : 0)
const doneColor = (done: number, total: number) => (total > 0 && done === total ? C.green : C.teal)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** MCP servers connected by id read as a hash; show its head. */
const shortName = (name: string) => (name.length > 22 ? `${name.slice(0, 8)}…` : name)

type Caveman = { mode: string; outputTokens?: number; turns?: number; title?: string }
let caveman: { at: number; value: Caveman } = { at: 0, value: { mode: 'off' } }

async function save($: EngineInterface, change: (tasks: TaskItem[]) => TaskItem[]) {
  const id = await $.session.id()
  const old = (await $.store.get(SESSION_KEY(id))) as SessionEntry | undefined
  const cwd = await $.session.cwd()
  const entry: SessionEntry = {
    title: caveman.value.title ?? old?.title ?? baseName(cwd),
    cwd,
    updated: await $.clock.now(),
    tasks: change(old?.tasks ?? []),
  }
  await $.store.set(SESSION_KEY(id), entry)
}

async function readRegistry($: EngineInterface): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = []
  try {
    const dir = `${await $.env.get('HOME')}/.claude/sessions`
    for (const item of await $.fs.list(dir)) {
      if (item.kind !== 'file' || !item.name.endsWith('.json')) continue
      try {
        const one = JSON.parse(await $.fs.read(`${dir}/${item.name}`)) as RegistryEntry
        if (typeof one.sessionId === 'string' && typeof one.pid === 'number') out.push(one)
      } catch {
        // A half-written file is picked up on the next pass.
      }
    }
  } catch {
    // No registry folder yet.
  }
  return out
}

async function livePids($: EngineInterface, pids: number[]): Promise<Set<number>> {
  if (pids.length === 0) return new Set()
  const ran = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')])
  return new Set(ran.stdout.split('\n').map(line => Number(line.trim())).filter(Boolean))
}

// This session's name in the registry, which follows /rename; read at most every SLOW_MS.
let ownName: { at: number; value: string | undefined } = { at: 0, value: undefined }
let lastPublish = 0

/** Tell the other sessions this one is open: its cost, shells and name. */
async function publish($: EngineInterface, force = true) {
  try {
    const now = await $.clock.now()
    if (!force && now - lastPublish < 10_000) return
    lastPublish = now
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    if (now - ownName.at >= SLOW_MS) {
      const mine = (await readRegistry($)).find(one => one.sessionId === id)
      ownName = { at: now, value: mine?.name }
    }
    const usage = await $.session.usage()
    const pulse: Pulse = {
      at: now,
      title: caveman.value.title ?? ownName.value ?? baseName(cwd),
      cwd,
      usd: usage.cost?.usd ?? 0,
      ctx: usage.context.percent,
      shells: (await read($, shells)).slice(-20),
    }
    await $.store.set(PULSE_KEY(id), pulse)
  } catch {
    // A missed pulse only hides this session from the others for a moment.
  }
}

/** Change the shell list and tell the other sessions at once. */
async function setShells($: EngineInterface, change: (list: Shell[]) => Shell[]) {
  await update($, shells, change)
  void publish($)
}

/** Sessions that every spawn tool call of this one made, found again by the registry. */
async function findChildren($: EngineInterface, root: string, registry: RegistryEntry[], now: number) {
  const found: { entry: RegistryEntry; depth: number }[] = []
  const taken = new Set<string>([root])
  let proposed = 0
  const walk = async (parent: string, depth: number) => {
    if (depth > CHILD_DEPTH) return
    const records = ((await $.store.get(CHILDREN_KEY(parent))) as ChildRecord[] | undefined) ?? []
    let pinned = false
    for (const rec of records) {
      const title = rec.title.trim().toLowerCase()
      const hit =
        (rec.sessionId ? registry.find(one => one.sessionId === rec.sessionId) : undefined) ??
        registry.find(one => !taken.has(one.sessionId) && one.name?.trim().toLowerCase() === title && one.startedAt >= rec.at - SPAWN_SLACK_MS)
      if (hit && !taken.has(hit.sessionId)) {
        taken.add(hit.sessionId)
        found.push({ entry: hit, depth })
        if (rec.sessionId !== hit.sessionId) {
          rec.sessionId = hit.sessionId
          pinned = true
        }
        await walk(hit.sessionId, depth + 1)
      } else if (!rec.sessionId && depth === 1 && now - rec.at < PROPOSED_MS) proposed++
    }
    if (pinned) await $.store.set(CHILDREN_KEY(parent), records)
  }
  await walk(root, 1)
  return { found, proposed }
}

async function load($: EngineInterface) {
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const keys = await $.store.keys()
  const registry = await readRegistry($)

  const { found, proposed } = await findChildren($, sessionId, registry, now)
  const alive = await livePids($, found.map(one => one.entry.pid))

  // Every other open session, for the totals and the shell list.
  const fleet: Board['fleet'] = []
  for (const key of keys) {
    if (!key.startsWith('pulse:')) continue
    const id = key.slice('pulse:'.length)
    const pulse = (await $.store.get(key)) as Pulse | undefined
    if (pulse && id !== sessionId && now - pulse.at < LIVE_MS) fleet.push({ id, pulse })
  }

  const checklistOf = async (id: string) => {
    try {
      return JSON.parse(await $.fs.read(`${await $.env.get('HOME')}/.claude/progress/${id}.json`)) as ChecklistFile
    } catch {
      // No checklist, or one half-written: picked up on the next pass.
      return undefined
    }
  }

  const children: ChildSession[] = []
  for (const { entry, depth } of found) {
    if (!alive.has(entry.pid)) continue
    const saved = (await $.store.get(SESSION_KEY(entry.sessionId))) as SessionEntry | undefined
    const pulse = fleet.find(one => one.id === entry.sessionId)?.pulse
    children.push({
      id: entry.sessionId,
      depth,
      title: entry.name || saved?.title || baseName(entry.cwd),
      status: entry.status ?? 'idle',
      startedAt: entry.startedAt,
      tasks: saved?.tasks ?? [],
      checklist: await checklistOf(entry.sessionId),
      shellsLive: pulse?.shells.filter(s => s.status === 'running').length ?? 0,
    })
  }

  const mine = (await $.store.get(SESSION_KEY(sessionId))) as SessionEntry | undefined
  const checklist = await checklistOf(sessionId)
  await update($, board, () => ({ sessionId, children, proposed, checklist, fleet, tasks: mine?.tasks ?? [], loadedAt: Date.now() }))
}

const STEP_MARK = { done: '✅', doing: '▶️', approved: '🔓', todo: '⬜', gated: '🔒' } as const
const TASK_MARK = { completed: '✅', in_progress: '▶️', pending: '⬜' } as const

function Checklist({ els, file, cols }: { els: Els; file: ChecklistFile; cols: number }) {
  const { Box, Text } = els
  const steps = file.groups.flatMap(group => group.steps)
  const finished = steps.filter(step => step.status === 'done').length
  return (
    <Box flexDirection="column" gap="xs">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.white} wrap="truncate-end">{file.title}</Text>
        <Text color={doneColor(finished, steps.length)}>{finished}/{steps.length}</Text>
      </Box>
      <Bar els={els} pct={ratio(finished, steps.length)} fill={doneColor(finished, steps.length)} cols={cols} alt={`${finished} of ${steps.length} steps done`} />
      {file.groups.map(group => (
        <Box flexDirection="column" marginTop="lg" gap="xs">
          <Text bold color={C.purple} wrap="truncate-end">{group.title}</Text>
          {group.steps.map(step => (
            <Text
              wrap="truncate-end"
              color={step.status === 'done' ? C.green : step.status === 'doing' ? C.yellow : step.status === 'approved' ? C.cyan : step.status === 'gated' ? C.purple : C.gray}
            >
              {STEP_MARK[step.status]} {step.label}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** A section heading, a blank row above it (more on desktop): 🧠 LABEL · right */
function Rule({ els, icon, label, right, rightColor }: { els: Els; icon: string; label: string; right?: string; rightColor?: string }) {
  const { Box, Text } = els
  return (
    <Box marginTop="lg" marginBottom="xs">
      <Text wrap="truncate-end">
        {icon} <Text bold color={C.white}>{label}</Text>
        {right && <Text color={C.gray}> · </Text>}
        {right && <Text color={rightColor ?? C.fg}>{right}</Text>}
      </Text>
    </Box>
  )
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The /context breakdown, caveman history, git and the session title are read at most this often.
const SLOW_MS = 15_000
const GIT_MS = 5_000
let breakdown: { at: number; value: SessionContextBreakdown | undefined } = { at: 0, value: undefined }
type Git = { dir: string; branch: string; ahead: number; behind: number; dirty: number; added: number; removed: number }
let git: { at: number; value: Git | null } = { at: 0, value: null }

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function kTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

function cells(part: number, whole: number, width: number): number {
  return whole > 0 ? Math.round((part / whole) * width) : 0
}

function top(counts: Counts, n: number): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n)
}

function bump(name: string) {
  return (counts: Counts): Counts => ({ ...counts, [name]: (counts[name] ?? 0) + 1 })
}

/** "claude-opus-5-5[1m]" → "O5.5·1M", as the status line abbreviates. */
function modelTag(model: string, level: string): string {
  const family = /opus/i.test(model) ? 'O' : /sonnet/i.test(model) ? 'S' : /haiku/i.test(model) ? 'H' : /fable/i.test(model) ? 'F' : model.replace(/^claude-/i, '').charAt(0).toUpperCase()
  const pair = /(\d+)[.-](\d+)/.exec(model)
  const version = pair ? `${pair[1]}.${pair[2]}` : (/(\d+)/.exec(model)?.[1] ?? '')
  const wide = /\[1m\]/i.test(model) ? '·1M' : ''
  const eff = { low: 'L', medium: 'M', high: 'H', xhigh: 'EX', max: '★' }[level] ?? level
  return `${family}${version}${wide}${eff ? `-${eff}` : ''}`
}

const two = (n: number) => String(n).padStart(2, '0')

function left(ms: number, days: boolean): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (days && m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h${two(m % 60)}m`
  return `${m}m`
}

const WINDOWS: Record<string, { label: string; icon: string; ms: number; days: boolean }> = {
  five_hour: { label: '5H', icon: '⌛', ms: 5 * 3600_000, days: false },
  seven_day: { label: '7D', icon: '📅', ms: 7 * 86400_000, days: true },
}

/** How far through its window a limit is, and where the spend is headed. */
function pace(limit: SessionRateLimit, now: number) {
  const win = WINDOWS[limit.kind]
  const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!win || Number.isNaN(resets)) return { resets: Number.isNaN(resets) ? undefined : resets }
  const elapsed = Math.max(0, Math.min(100, 100 - ((resets - now) / win.ms) * 100))
  const projected = elapsed >= 3 ? (limit.percentUsed / elapsed) * 100 : undefined
  return { resets, elapsed, projected }
}

async function readGit($: EngineInterface, cwd: string): Promise<Git | null> {
  const status = await $.process.run(['git', '-C', cwd, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
  if (status.exitCode !== 0) return null
  let branch = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let dirty = 0
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(m?.[1] ?? 0)
      behind = Number(m?.[2] ?? 0)
    } else if (line && !line.startsWith('#')) dirty++
  }
  if (branch === '(detached)') branch = oid.slice(0, 7)
  const root = (await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])).stdout.trim()
  const rel = root && cwd.startsWith(root) ? cwd.slice(root.length).replace(/^\//, '') : ''
  let dir = rel ? `${baseName(root)}/${rel}` : baseName(root || cwd)
  if (dir.length > 22) dir = `${dir.slice(0, 19)}…`
  let added = 0
  let removed = 0
  const diff = await $.process.run(['git', '-C', cwd, '--no-optional-locks', 'diff', '--numstat', 'HEAD'])
  if (diff.exitCode === 0) {
    for (const line of diff.stdout.split('\n')) {
      const [a, r] = line.split('\t')
      added += Number(a) || 0
      removed += Number(r) || 0
    }
  }
  return { dir, branch, ahead, behind, dirty, added, removed }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-monitor', description: 'Show the session HUD: status, limits, cost, tasks, context, shells, subagents, skills and MCP' })
    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    // Slow refresh for agents and context; fast only while a shell or agent runs, for the spinner.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      const value = await $.store.get(key)
      if (key.startsWith('session:') && value && now - (value as SessionEntry).updated > KEEP_MS) await $.store.delete(key)
      if (key.startsWith('alive:') && typeof value === 'number' && now - value > KEEP_MS) await $.store.delete(key)
      if (key.startsWith('pulse:') && value && now - (value as Pulse).at > KEEP_MS) await $.store.delete(key)
      if (key.startsWith('children:') && Array.isArray(value) && (value as ChildRecord[]).every(rec => now - rec.at > KEEP_MS)) await $.store.delete(key)
    }
    void publish($)
    void $.clock.every(PULSE_EVERY_MS, () => publish($))
    void load($)
    void $.clock.every(TASK_EVERY_MS, async () => {
      await load($)
      await update($, tick, n => n + 1)
    })
    void $.clock.every(200, async () => {
      const busy = (await read($, shells)).some(s => s.status === 'running') || (await $.agent.list()).some(a => a.status === 'running' || a.status === 'pending')
      if (busy) await update($, tick, n => n + 1)
    })
    return next(e)
  })

  on('command.run', { command: 'session-monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    return { text: 'Session HUD opened.' }
  })

  // Task list: TodoWrite replaces it, TaskCreate and TaskUpdate edit it.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await save($, () => e.todos.map(todo => ({ content: todo.content, status: todo.status, activeForm: todo.activeForm })))
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await save($, tasks => [...tasks, { id: String(tasks.length + 1), content: e.subject, status: 'pending', activeForm: e.activeForm }])
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await save($, tasks =>
          tasks.flatMap(task => {
            if (task.id !== e.taskId) return [task]
            if (e.status === 'deleted') return []
            return [{ ...task, content: e.subject ?? task.content, activeForm: e.activeForm ?? task.activeForm, status: e.status ?? task.status }]
          }),
        )
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  // The desktop app's task list: items replace it; advance, done and start move it.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const plan = e as unknown as { items?: { content: string; status: TaskItem['status'] }[]; advance?: boolean; done?: number[]; start?: number }
      try {
        await save($, tasks => {
          let list: TaskItem[] = plan.items ? plan.items.map((item, i) => ({ id: String(i + 1), content: item.content, status: item.status })) : tasks
          const set = (at: number, status: TaskItem['status']) => (list = list.map((task, i) => (i === at ? { ...task, status } : task)))
          if (plan.advance) {
            set(list.findIndex(task => task.status === 'in_progress'), 'completed')
            set(list.findIndex(task => task.status === 'pending'), 'in_progress')
          }
          for (const n of plan.done ?? []) set(n - 1, 'completed')
          if (plan.start !== undefined) set(plan.start - 1, 'in_progress')
          return list
        })
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  // The turn's wrap-up checks the list off.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await save($, tasks => tasks.map(task => ({ ...task, status: 'completed' as const })))
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const id = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
    if (id) {
      const now = await $.clock.now()
      const command = (e.description ?? e.command).slice(0, 200)
      await setShells($, list => [...list.filter(s => s.id !== id), { id, command, startedAt: now, status: 'running' as const }].slice(-50))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id) {
      const now = await $.clock.now()
      await setShells($, list => list.map(s => (s.id === id && s.status === 'running' ? { ...s, status: 'stopped' as const, endedAt: now } : s)))
    }
    return ran
  })

  // One catch-all hook (the engine allows a single): count MCP calls per server,
  // tool names being mcp__<server>__<tool>, and record sessions this one spawns.
  // A session it starts, proposes or hands off to shows in the registry under the
  // title given here, so the title is kept to find it again.
  on('tool.call', async ($, e, next) => {
    const match = /^mcp__(.+?)__/.exec(e.tool)
    if (match?.[1]) await update($, mcp, bump(match[1]))
    if (!SPAWN_TOOLS.has(e.tool)) return next(e)
    const ran = await next(e)
    const title = (e as unknown as { title?: unknown }).title
    if (ran.deny === undefined && ran.isError !== true && typeof title === 'string' && title.trim()) {
      try {
        const key = CHILDREN_KEY(await $.session.id())
        const old = ((await $.store.get(key)) as ChildRecord[] | undefined) ?? []
        const rec: ChildRecord = { title, at: await $.clock.now(), tool: e.tool.split('__').pop() ?? e.tool }
        await $.store.set(key, [...old.filter(one => one.title !== title), rec].slice(-40))
        void load($)
      } catch {
        // Tracking must never get in the way of the tool.
      }
    }
    return ran
  })

  // Every skill load, by the Skill tool or a slash command.
  on('skill.prompt', async ($, e, next) => {
    await update($, skills, bump(e.skill))
    return next(e)
  })

  // The effort level rides the tool-use hooks; the status line reads the same field.
  on('classic.PostToolUse', async ($, e, next) => {
    const level = e.effort?.level
    if (level && level !== (await read($, effort))) await update($, effort, () => level)
    return next(e)
  })

  // The Stop hook lists the session's in-flight background work: any shell
  // we track that is missing from it has finished.
  on('classic.Stop', async ($, e, next) => {
    const level = e.effort?.level
    if (level && level !== (await read($, effort))) await update($, effort, () => level)
    const live = new Set((e.background_tasks ?? []).filter(t => t.type === 'shell').map(t => t.id))
    const now = await $.clock.now()
    await setShells($, list => list.map(s => (s.status === 'running' && !live.has(s.id) ? { ...s, status: 'done' as const, endedAt: now } : s)))
    return next(e)
  })

  // One sample per change of fill or cost, for the sparklines.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('cost')) {
      const sample: Sample = { at: await $.clock.now(), ctx: e.context.percent ?? 0, usd: e.cost?.usd ?? 0 }
      await update($, history, list => {
        const last = list[list.length - 1]
        const kept = last && sample.at - last.at < 2000 ? list.slice(0, -1) : list
        return [...kept, sample].slice(-HISTORY_MAX)
      })
      void publish($, false)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    breakdown = { at: 0, value: breakdown.value }
    caveman = { at: 0, value: caveman.value }
    git = { at: 0, value: git.value }
    await update($, tick, n => n + 1)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const frame = await read($, tick)
    const now = await $.clock.now()
    const [list, skillCounts, mcpCounts, agents, data, samples, level, model, turns, cwd] = await Promise.all([
      read($, shells),
      read($, skills),
      read($, mcp),
      $.agent.list(),
      read($, board),
      read($, history),
      read($, effort),
      $.session.model(),
      $.session.turns(),
      $.session.cwd(),
    ])

    const freshBreakdown = now - breakdown.at < SLOW_MS
    const usage = await $.session.usage(freshBreakdown ? undefined : { breakdown: 'summary' })
    if (!freshBreakdown) breakdown = { at: now, value: usage.context.breakdown }
    const parts = breakdown.value

    if (now - git.at >= GIT_MS) {
      git = { at: now, value: git.value }
      try {
        git = { at: now, value: await readGit($, cwd) }
      } catch {
        // git missing or the folder is gone: the header falls back to the folder name.
      }
    }
    const repo = git.value

    if (now - caveman.at >= SLOW_MS) {
      const value: Caveman = { mode: 'off' }
      const home = await $.env.get('HOME')
      const id = await $.session.id()
      try {
        // /rename writes a custom-title record into the transcript; the last one wins.
        const found = await $.process.run(['sh', '-c', `grep -h '"type":"custom-title"' "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | tail -1`])
        const line = found.stdout.trim()
        if (line) value.title = (JSON.parse(line) as { customTitle?: string }).customTitle
      } catch {
        // No transcript yet, or the record is cut: the session stays unnamed.
      }
      try {
        value.mode = (await $.fs.read(`${home}/.claude/.caveman-sessions/${id}.mode`)).trim() || 'off'
        const log = await $.fs.read(`${home}/.claude/.caveman-history.jsonl`)
        for (const row of log.trim().split('\n').reverse()) {
          const entry = JSON.parse(row) as { session_id?: string; output_tokens?: number; turns?: number }
          if (entry.session_id === id) {
            value.outputTokens = entry.output_tokens
            value.turns = entry.turns
            break
          }
        }
      } catch {
        // No mode file or history yet: caveman is off or has not logged a turn.
      }
      caveman = { at: now, value }
    }
    const cave = caveman.value
    const sessionId = await $.session.id()

    const cols = e.props.bodyColumns ?? PANE_COLUMNS
    const limits = usage.rateLimits.filter(l => WINDOWS[l.kind])
    const overuse = usage.rateLimits.some(l => l.percentUsed >= 100)
    const usd = usage.cost?.usd ?? 0
    const uptime = now - usage.startedAt
    const burn = uptime > 120_000 ? usd / (uptime / 3600_000) : undefined
    // Gauge rows: "⌛ 5H  [" 8 · bar · "] " 2 · "100%" 4 · " ⏳6d23h" 8. Some fonts draw
    // █ and ░ wider than a cell, so the bar keeps slack and stops at 16.
    const gaugeWidth = Math.max(6, Math.min(16, cols - 30))
    const spend = samples.slice(1).map((s, i) => Math.max(0, s.usd - (samples[i]?.usd ?? 0))).slice(-Math.max(4, Math.min(12, cols - 34)))

    // Shells of every open session, this one's untagged; longest running first.
    const fleet = data?.fleet ?? []
    const everyShell: (Shell & { from?: string })[] = [...list, ...fleet.flatMap(one => one.pulse.shells.map(s => ({ ...s, from: one.pulse.title })))]
    const running = everyShell.filter(s => s.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const recent = everyShell.filter(s => s.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 5)
    const longest = running.length > 0 ? now - (running[0]?.startedAt ?? now) : 0
    const longCount = running.filter(s => now - s.startedAt >= LONG_MS).length
    const longColor = (ms: number) => (ms >= LONGEST_MS ? C.red : ms >= LONGER_MS ? C.orange : ms >= LONG_MS ? C.yellow : C.teal)
    const fleetUsd = fleet.reduce((sum, one) => sum + one.pulse.usd, 0)
    const ctxPct = Math.round(usage.context.percent ?? 0)
    const ctxHist = samples.map(s => s.ctx).slice(-Math.max(4, Math.min(12, cols - 34)))
    const fullest = Math.round(Math.max(ctxPct, ...fleet.map(one => one.pulse.ctx ?? 0)))
    const liveAgents = agents.filter(a => ['pending', 'running', 'waiting', 'idle'].includes(a.status))
    const endedAgents = agents.filter(a => !liveAgents.includes(a)).slice(-5)
    const mcpByServer: Counts = {}
    for (const t of parts?.mcpTools ?? []) if (t.isLoaded) mcpByServer[t.serverName] = (mcpByServer[t.serverName] ?? 0) + t.tokens
    const myList = data?.checklist
    const kids = data?.children ?? []
    const tasks = data?.tasks ?? []
    const tasksDone = tasks.filter(task => task.status === 'completed').length
    const skillTop = top(skillCounts, 8)
    const skillMax = Math.max(1, ...skillTop.map(([, n]) => n))
    const mcpServers = Array.from(new Set([...Object.keys(mcpCounts), ...Object.keys(mcpByServer)]))
      .sort((a, b) => (mcpCounts[b] ?? 0) - (mcpCounts[a] ?? 0))
      .slice(0, 8)
    const spin = (i: number) => <Text color={(Math.floor(frame / 4) + i) % 2 === 0 ? C.teal : C.orange}>{SPINNER[(frame + i) % SPINNER.length]} </Text>
    const skillLoads = Object.values(skillCounts).reduce((a, b) => a + b, 0)
    const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

    return (
      <Box flexDirection="column" paddingX="sm">
        {/* ── HEADER: where, what, who ── */}
        <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            📂 <Text bold color={C.cyan}>{repo?.dir ?? baseName(cwd)}</Text>
            {repo && <Text color={C.purple}> 🌿 {repo.branch}</Text>}
            {repo && repo.dirty > 0 && <Text color={C.yellow}> *</Text>}
            {repo && repo.ahead > 0 && <Text color={C.teal}> ↑{repo.ahead}</Text>}
            {repo && repo.behind > 0 && <Text color={C.orange}> ↓{repo.behind}</Text>}
          </Text>
          <Text bold color={C.claude}>[{modelTag(model, level)}]</Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            📋 {cave.title ? <Text bold color={C.white}>{cave.title}</Text> : <Text color={C.gray}>(unnamed · {sessionId.slice(0, 8)})</Text>}
          </Text>
          {cave.mode !== 'off' && <Text bold color={C.cave}>🪨 {cave.mode.toUpperCase()}</Text>}
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end" color={C.gray}>
            🚀 {ago(uptime)} · 💬 {plural(turns, 'turn')}
            {cave.mode !== 'off' && cave.outputTokens !== undefined ? ` · 🗣️ ${kTokens(cave.outputTokens)} out` : ''}
          </Text>
          {repo &&
            (repo.dirty === 0 ? (
              <Text color={C.green}>✨ clean</Text>
            ) : (
              <Text>
                <Text color={C.green}>+{repo.added}</Text> <Text color={C.red}>-{repo.removed}</Text>
                <Text color={C.gray}> · {plural(repo.dirty, 'file')}</Text>
              </Text>
            ))}
        </Box>
        </Box>

        {/* ── VITALS: the status line's gauges, with pace and trend ── */}
        <Rule els={els} icon="⚡" label="VITALS" right={overuse ? 'OVER LIMIT' : undefined} rightColor={C.red} />
        <Box flexDirection="column" gap="sm">
        <Box key="g-ctx" flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              🧠 <Text bold color={C.white}>CTX</Text> <Text bold color={heat(ctxPct)}>{ctxPct}%</Text>
              <Text color={C.gray}> · {kTokens(usage.context.tokens)}/{kTokens(usage.context.window)}</Text>
            </Text>
            {ctxHist.length > 1 && <Text mono>{paint(els, spark(ctxHist, heat, 100))}</Text>}
          </Box>
          <Bar els={els} pct={ctxPct} fill="heat" cols={cols} alt={`${ctxPct}% of the context window used`} />
        </Box>
        {limits.length === 0 && <Text color={C.gray}>⌛ no rate-limit reading yet</Text>}
        {limits.map(limit => {
          const win = WINDOWS[limit.kind]!
          const used = Math.round(limit.percentUsed)
          const p = pace(limit, now)
          const hot = p.projected !== undefined && p.projected >= 100
          const ahead = p.elapsed !== undefined ? used - p.elapsed : 0
          return (
            <Box key={`g-${limit.kind}`} flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end">
                  {win.icon} <Text bold color={C.white}>{win.label}</Text> <Text bold color={heat(used)}>{used}%</Text>
                  {p.elapsed !== undefined && <Text color={C.gray}> · </Text>}
                  {p.elapsed !== undefined &&
                    (ahead > 5 ? <Text color={C.orange}>🔥 {Math.round(ahead)}% hot</Text> : ahead < -5 ? <Text color={C.teal}>🧊 {Math.round(-ahead)}% cool</Text> : <Text color={C.green}>🎯 on pace</Text>)}
                  {p.projected !== undefined && <Text color={hot ? C.red : C.gray}> · ⇢ {Math.round(p.projected)}% at reset</Text>}
                </Text>
                {p.resets !== undefined && <Text color={hot ? C.red : C.teal}>{hot ? '🚦' : '⏳'} {left(p.resets - now, win.days)}</Text>}
              </Box>
              <Bar els={els} pct={used} fill="heat" marker={p.elapsed} cols={cols} alt={`${used}% of the ${win.label} limit used${p.elapsed !== undefined ? `, ${Math.round(p.elapsed)}% of the window gone` : ''}`} />
            </Box>
          )
        })}
        <Box key="g-cost" flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              {overuse ? '💸' : '🏦'} <Text bold color={overuse ? C.red : C.dollar}>{money(usd)}</Text>
              {burn !== undefined && <Text color={C.gray}> · 🔥 {money(burn)}/h</Text>}
              {turns > 0 && <Text color={C.gray}> · {money(usd / turns)}/turn</Text>}
            </Text>
            {spend.length > 1 && <Text mono>{paint(els, spark(spend, () => (overuse ? C.red : C.dollar)))}</Text>}
          </Box>
        </Box>
        {fleet.length > 0 && (
          <Box key="g-all" flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              🌐 <Text bold color={C.white}>all sessions</Text> <Text bold color={C.dollar}>{money(usd + fleetUsd)}</Text>
            </Text>
            <Text color={C.gray}>
              {plural(fleet.length + 1, 'session')} · 🧠 max <Text color={heat(fullest)}>{fullest}%</Text>
            </Text>
          </Box>
        )}
        </Box>

        {/* ── TASKS ── */}
        <Rule els={els} icon="📌" label="TASKS" right={tasks.length > 0 ? `${tasksDone}/${tasks.length}` : undefined} rightColor={tasksDone === tasks.length ? C.green : C.teal} />
        <Box flexDirection="column" gap="xs">
        {!data && <Text color={C.gray}>{spin(0)}loading…</Text>}
        {data && tasks.length === 0 && !myList && <Text color={C.gray} wrap="truncate-end">💤 none yet · they appear when Claude keeps a plan</Text>}
        {tasks.length > 0 && <Bar els={els} pct={ratio(tasksDone, tasks.length)} fill={doneColor(tasksDone, tasks.length)} cols={cols} alt={`${tasksDone} of ${tasks.length} tasks done`} />}
        {tasks.map(task => (
          <Text wrap="truncate-end" color={task.status === 'completed' ? C.green : task.status === 'in_progress' ? C.yellow : C.gray}>
            {task.status === 'in_progress' ? spin(0) : `${TASK_MARK[task.status]} `}
            {task.status === 'in_progress' ? (task.activeForm ?? task.content) : task.content}
          </Text>
        ))}
        {myList && <Checklist els={els} file={myList} cols={cols} />}
        </Box>
        {(kids.length > 0 || (data?.proposed ?? 0) > 0) && (
          <Box flexDirection="column" marginTop="lg" gap="sm">
            <Text wrap="truncate-end">
              🛰️ <Text bold color={C.purple}>child sessions</Text>
              <Text color={C.gray}> · {kids.length} open{(data?.proposed ?? 0) > 0 ? ` · ✉️ ${data?.proposed} proposed` : ''}</Text>
            </Text>
            {kids.map(kid => {
              const steps = kid.checklist?.groups.flatMap(group => group.steps) ?? []
              const total = kid.tasks.length || steps.length
              const finished = kid.tasks.length > 0 ? kid.tasks.filter(task => task.status === 'completed').length : steps.filter(step => step.status === 'done').length
              const doing = kid.tasks.find(task => task.status === 'in_progress')
              const busy = kid.status !== 'idle'
              return (
                <Box flexDirection="column" key={kid.id} gap="xs" paddingLeft={kid.depth > 1 ? 'md' : undefined}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text wrap="truncate-end">
                      {busy ? spin(0) : <Text color={C.gray}>💤 </Text>}
                      <Text bold color={C.cyan}>{kid.title}</Text>
                    </Text>
                    <Text color={C.gray}>
                      {busy ? <Text color={C.yellow}>{kid.status}</Text> : 'idle'} · {ago(now - kid.startedAt)}
                      {kid.shellsLive > 0 ? <Text color={C.teal}> · 🐚{kid.shellsLive}</Text> : ''}
                      {total > 0 ? <Text color={doneColor(finished, total)}> · {finished}/{total}</Text> : ''}
                    </Text>
                  </Box>
                  {total > 0 && <Bar els={els} pct={ratio(finished, total)} fill={doneColor(finished, total)} cols={cols} alt={`${finished} of ${total} done`} />}
                  {doing && <Text color={C.yellow} wrap="truncate-end">  ▶️ {doing.activeForm ?? doing.content}</Text>}
                </Box>
              )
            })}
          </Box>
        )}

        {/* ── SHELLS: every open session; a long one is flagged ── */}
        <Rule
          els={els}
          icon="🐚"
          label="SHELLS"
          right={running.length > 0 ? `${running.length} live${longCount > 0 ? ` · 🐢 ${longCount} long` : ''}` : undefined}
          rightColor={longColor(longest)}
        />
        <Box flexDirection="column" gap="xs">
        {running.length === 0 && recent.length === 0 && <Text color={C.gray}>none in any session</Text>}
        {running.map((s, i) => {
          const run = now - s.startedAt
          const color = longColor(run)
          return (
            <Box flexDirection="row" justifyContent="space-between" key={`${s.from ?? 'me'}-${s.id}`}>
              <Text wrap="truncate-end">
                {run >= LONG_MS ? <Text color={color}>{run >= LONGEST_MS ? '🔥 ' : '🐢 '}</Text> : spin(i)}
                {s.from && <Text color={C.purple}>[{s.from.length > 14 ? `${s.from.slice(0, 13)}…` : s.from}] </Text>}
                <Text color={run >= LONG_MS ? color : C.white}>{s.command}</Text>
              </Text>
              <Text bold={run >= LONG_MS} color={color}> {ago(run)}</Text>
            </Box>
          )
        })}
        {recent.map(s => (
          <Box flexDirection="row" justifyContent="space-between" key={`${s.from ?? 'me'}-${s.id}`}>
            <Text wrap="truncate-end" color={C.gray}>
              {s.status === 'stopped' ? '🛑' : '✅'} {s.from ? `[${s.from.length > 14 ? `${s.from.slice(0, 13)}…` : s.from}] ` : ''}{s.command}
            </Text>
            {s.endedAt !== undefined && <Text color={C.gray}> {ago(s.endedAt - s.startedAt)}</Text>}
          </Box>
        ))}
        </Box>

        {/* ── SUBAGENTS ── */}
        <Rule els={els} icon="🤖" label="AGENTS" right={liveAgents.length > 0 ? `${liveAgents.length} live` : undefined} rightColor={C.teal} />
        <Box flexDirection="column" gap="xs">
        {agents.length === 0 && <Text color={C.gray}>none this session</Text>}
        {liveAgents.map((a, i) => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              {spin(i)}<Text color={C.white}>{a.description || a.type}</Text>
            </Text>
            <Text>
              <Text color={C.purple}> {a.type}</Text> <Text color={C.gray}>{a.status}</Text>
            </Text>
          </Box>
        ))}
        {endedAgents.map(a => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end" color={C.gray}>
              {a.status === 'completed' ? '✅' : '❌'} {a.description || a.type}
            </Text>
            <Text color={C.gray}> {a.type}</Text>
          </Box>
        ))}
        </Box>

        {/* ── SKILLS ── */}
        <Rule els={els} icon="🧰" label="SKILLS" right={skillLoads > 0 ? plural(skillLoads, 'load') : undefined} />
        <Box flexDirection="column" gap="xs">
        {skillTop.length === 0 && <Text color={C.gray}>none since the HUD loaded</Text>}
        {skillTop.map(([name, n]) => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={C.purple}>▸</Text> <Text color={C.fg}>{name}</Text>
            </Text>
            <Text color={C.gray}> ×{n}</Text>
          </Box>
        ))}
        </Box>

        {/* ── MCP ── */}
        <Rule els={els} icon="🔌" label="MCP" right={mcpServers.length > 0 ? plural(mcpServers.length, 'server') : undefined} />
        <Box flexDirection="column" gap="xs">
        {mcpServers.length === 0 && <Text color={C.gray}>none loaded or called</Text>}
        {mcpServers.map(name => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end" color={mcpCounts[name] ? C.cyan : C.gray}>
              {mcpCounts[name] ? '●' : '○'} {shortName(name)}
            </Text>
            <Text color={C.gray}>
              {' '}{mcpCounts[name] ? plural(mcpCounts[name]!, 'call') : 'idle'}{mcpByServer[name] ? ` · ${kTokens(mcpByServer[name])} ctx` : ''}
            </Text>
          </Box>
        ))}
        </Box>
      </Box>
    )
  })
}
