export type Shell = {
  id: string
  command: string
  startedAt: number
  status: 'running' | 'done' | 'stopped'
  endedAt?: number
}

/** Name to number of uses this session. */
export type Counts = Record<string, number>

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = {
  id?: string
  content: string
  status: TaskStatus
  activeForm?: string
  note?: string
}

/** One session's task list, kept in the plugin's store so other sessions can see it. */
export type SessionEntry = {
  title: string
  cwd: string
  updated: number
  tasks: TaskItem[]
}

/**
 * A checklist an agent keeps in ~/.claude/progress/<session id>.json. A step runs
 * gated 🔒 (awaiting approval), approved 🔓 (cleared, not started), doing (play button), done ✅.
 */
export type ChecklistFile = {
  title: string
  updated?: string
  commit?: string
  groups: {
    title: string
    steps: { label: string; status: 'done' | 'doing' | 'approved' | 'todo' | 'gated'; note?: string }[]
  }[]
}

/** A session spawned from this one, recorded when the spawn tool call succeeded. */
export type ChildRecord = {
  /** The title given to the spawn call; the child's registry name matches it. */
  title: string
  at: number
  tool: string
  /** The child's session id, pinned once it is found, so a /rename cannot lose it. */
  sessionId?: string
}

/** One entry of ~/.claude/sessions/<pid>.json, the engine's registry of open sessions. */
export type RegistryEntry = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  name?: string
  status?: string
}

/** What each open session publishes every so often so the others can total it. */
export type Pulse = {
  at: number
  title: string
  cwd: string
  usd: number
  /** Context window fill, percent. */
  ctx?: number
  shells: Shell[]
}

/** A session spawned from this one, or from one of its children. */
export type ChildSession = {
  id: string
  /** 1 for a direct child, 2 for its child, and so on. */
  depth: number
  title: string
  status: string
  startedAt: number
  tasks: TaskItem[]
  checklist?: ChecklistFile
  shellsLive: number
}

export type Board = {
  sessionId: string
  /** Child sessions, depth first. */
  children: ChildSession[]
  /** Spawned recently with no session found yet: proposed, not started. */
  proposed: number
  /** The checklist this session keeps in ~/.claude/progress. */
  checklist?: ChecklistFile
  /** Every other open session, for the totals and the shell list. */
  fleet: { id: string; pulse: Pulse }[]
  /** This session's tasks. */
  tasks: TaskItem[]
  loadedAt: number
}

/** One reading of the context fill and the cost, for the HUD sparklines. */
export type Sample = {
  at: number
  ctx: number
  usd: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      shells: Shaped<Shell[]>
      skills: Shaped<Counts>
      mcp: Shaped<Counts>
      board: Shaped<Board | null>
      history: Shaped<Sample[]>
      /** Effort level of the last turn, '' before the first reading. */
      effort: string
      tick: number
    }
  }
}
