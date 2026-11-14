# session-monitor

A Claude Code mod that docks a side pane (about 400 px, 50 columns), the
"Session HUD". It replaces the bottom status line and keeps its style: Tokyo
Night colours and emoji labels. Every bar
runs the full width of the pane on its own row. On the desktop, whose pane is
set in a proportional face, a bar is an SVG stretched to the slot; on the
terminal it is a line of box-drawing glyphs (`━━━┃───`), which every font
draws one cell wide (block glyphs `█░` came out wider and overran the pane).
Sections start with an emoji heading after a blank row; there are no boxes or
rules. From the top:

- a header: repo and folder, git branch with dirty `*` and ahead/behind
  arrows, the model tag (`[O5.5-L]`), the `/rename` session name, the caveman
  mode, uptime, turn count and uncommitted churn;
- vitals, across every open session: the context window (🧠, with a trend
  sparkline), the 5-hour (⌛) and 7-day (📅) limits and
  cost (🏦, 💸 once a limit is past 100%). Bars are heat ramps, green to red.
  Each limit bar carries a ┃ pace marker at how much of the window has gone
  by, with a "hot/cool" verdict, the use projected at reset and the time to
  reset on the row above (🚦 once the projection passes 100%). Spend has a
  sparkline. With other sessions open, a 🌐 row totals the cost of all of them and
  shows the fullest context among them;
- this session's task list, kept from TodoWrite, TaskCreate and TaskUpdate and
  from the desktop app's `mcp__ccd_turn__update_plan` and `wrap_up`, with a
  spinner on the one in progress; then 🛰️ child sessions, only the ones this
  session started (see below), each with its state, age, task progress and
  live shells;
- shells, across every open session: a braille spinner while running, ✅ or 🛑
  when done, other sessions' shells tagged `[session name]`. A shell running
  10 minutes is a long shell: it turns yellow with a 🐢, orange at 30 minutes,
  red with a 🔥 at an hour, and the heading counts them (`🐢 2 long`). Constants
  `LONG_MS`, `LONGER_MS` and `LONGEST_MS` in `hooks/register.tsx`;
- this session's subagents, skills loaded and MCP servers with their calls and
  context cost.

Per session: tasks, child sessions, subagents, skills and MCP. Across all
sessions: vitals and shells.

Child sessions. The engine keeps no parent link, so the mod builds one. When a
session calls `mcp__ccd_session__start_session`, `spawn_task` or
`hand_off_to_session`, it records the `title` in the plugin store
(`children:<id>`). A session in `~/.claude/sessions/*.json` whose name equals
that title and that started after the call is its child; the link is then
pinned by session id, so a later `/rename` keeps it. A child whose process has
exited drops off, and children of children show one level deeper. A spawn with
no session yet counts as ✉️ proposed (for 24 hours). Sessions you start by
hand, or by an older version of the mod, are never anyone's child.

Every open session publishes `pulse:<id>` (name, cost, shells) to the plugin
store every 30 seconds and whenever its shells change. A pulse older than 90
seconds means that session closed, and it drops out of the totals and the
shell list. Sessions on an older version of the mod publish no pulse, so they
do not show until they are restarted.

The pulse includes each background shell's description, or the first 200
characters of its command, and the session's working directory. Every session's
pane shows them, and the store keeps them for 14 days. Keep secrets out of
background commands: a token typed into a command line is stored in plain text
on this machine.

Checklist steps in `~/.claude/progress/<session id>.json` take a `status` of
`gated` 🔒 (awaiting approval), `approved` 🔓 (cleared, not started), `doing` ▶️,
`done` ✅ or `todo` ⬜. Whatever writes the file must set `approved` once the
step is cleared; the HUD only draws what it is given.

`/session-monitor` reopens the pane.

The pane opens unasked from 144 terminal columns, or from 110 once it has been
opened by hand. Skills and MCP calls are counted from when the mod loads.

## What it reads

Everything stays on this machine. Nothing is sent over a network.

- `~/.claude/sessions/*.json`: open sessions, to find child sessions.
- `~/.claude/progress/<session id>.json`: checklist steps.
- `~/.claude/projects/*/<session id>.jsonl`: the custom title from `/rename`,
  read with `grep`.
- `~/.claude/.caveman-sessions/<session id>.mode` and
  `~/.claude/.caveman-history.jsonl`: caveman mode, when that plugin is installed.
- `ps`: whether a session's process is still running.
- `git` in the session's folder: branch and uncommitted churn for the header.

A session id with anything other than word characters or hyphens is refused
before any file is read.

## Install

Type this at the prompt of a Claude Code terminal session:

```bash
/plugin install session-monitor --marketplace snyderb-de/session-monitor
```

Answer `y` to add the marketplace, then pick a scope. `/session-monitor` opens
the pane.

## Options and help

Each panel can be hidden in `/config`: `showTasks` (tasks, checklist and child
sessions), `showShells`, `showAgents`, `showSkills` and `showMcp`. All default to
on. The header and vitals always show.

`/session-monitor help` lists the panels with their current values and what each
mark means.

To change the emojis or colours, edit the `C` palette and the section icons in
`hooks/register.tsx`.
