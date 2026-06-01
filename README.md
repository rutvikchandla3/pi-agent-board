# Pi Agent Board

<p align="center">
  <img src="https://raw.githubusercontent.com/rutvikchandla3/pi-agent-board/main/assets/banner.png" alt="Pi Agent Board" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/rutvikchandla3/pi-agent-board/blob/main/assets/demo.mp4"><strong>▶ Watch the 30s demo</strong></a>
  · <a href="https://pi.dev/packages?name=pi-agent-board">Pi package gallery</a>
  · <a href="https://www.npmjs.com/package/pi-agent-board">npm</a>
</p>

A Claude-Code-style **agent board** for [Pi](https://github.com/earendil-works/pi-mono): one full-screen TUI to dispatch, monitor, peek/reply to, attach to, and manage multiple **background Pi sessions**. Each row is a real, persisted, resumable Pi session — not a transient subagent job.

Built on Pi's public extension/session/TUI APIs. Implements `PRD.md` / `IMPLEMENTATION_PLAN.md`.

## Install

From npm:

```bash
pi install npm:pi-agent-board
pi                          # then type /agent-board
# or launch straight into the dashboard UI:
pi /agent-board
```

From a local checkout while developing:

```bash
npm install
pi install "$(pwd)"          # package install
# or symlink for /reload-friendly auto-discovery:
ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board
pi
```

> If you use the symlink route, Pi will keep auto-loading the extension until you remove the
> symlink. `pi remove "$(pwd)"` only removes the package install entry.

> **Requires working pi provider auth.** The dashboard launches background `pi` workers; if pi
> can't reach a model provider, rows will sit in `Running`. Confirm with
> `pi --mode json -p --no-session "say hi"` (must end in an `agent_end` event). See **VERIFY.md**.

## What it does

- **`/agent-board`** opens a full-screen dashboard, global across projects.
- **`pi /agent-board`** starts directly in a cleaner dashboard-first UI (no normal Pi header/footer chrome) and quits Pi when you leave it.
- **Dispatch** by typing in the bottom input and pressing `enter` → a **Start session** dialog opens with default focus on **Start session**; press `enter` again to launch, or change **cwd**, **model**, and **thinking** first. The dialog remembers your last launch defaults and prefers scoped models for the selected cwd when Pi settings define them.
- **Live rows** grouped by stage: Queued · Running · Needs input · In Progress · Done · Failed · Stopped.
- **Peek** (`space`) a row for its summary, blocker/question, and latest output; **reply** (`r`) inline without attaching.
- **Attach** (`enter` or `→` / `>`) to continue the full interactive Pi session (confirms + interrupts if it's still running). The live PTY surface supports clickable links plus drag/double-click copy; detach with `←`, `ctrl+]`, or `ctrl+g`.
- **Transcript view** (`v`) opens a full-screen read-only live transcript without interrupting it; **back** with (`←` / `<`).
- **Manage:** rename (`ctrl+r`), pin (`ctrl+t`), stop (`ctrl+s`), mark done (`d`), delete selected (`ctrl+x`, archives row & keeps the session), delete all inactive rows in the selected state (`X`), filter (`/`, supports `s:<state>` + free text), help (`?`).
- **Durable & resumable:** survives `/reload` and pi restart; reconciles runs whose monitor died.
- **Safe parallelism:** same-repo parallel writers are auto-isolated into git worktrees.

## How it works

```text
You
 │
 │  /agent-board or pi /agent-board
 ▼
Agent Board TUI ── dispatch prompt ──▶ detached runner ──▶ background pi session
      ▲                                      │                    │
      │                                      │ streams JSON events│
      │                                      ▼                    │
      └──────── polls durable store ◀── events/status/state ◀─────┘
      │
      ├─ space: peek latest summary/question/output
      ├─ r: reply inline to the background session
      └─ enter/→: attach to the real Pi session through a PTY host
```

The extension owns the dashboard + a file-backed store at `~/.pi/agent/agent-board/`. Each dispatch launches a **detached `runner/job-runner.mjs`** (plain Node, survives pi exiting) that spawns a headless worker — `pi --mode json -p --session <file> "<prompt>"` — streams its JSON events into `events.jsonl`, and reduces them into `status.json` + the row's `state.json`. The dashboard polls those files. No daemon, no `pi-subagents` internals. Full design + the exact Pi API contract: **`docs/EXPLORATION.md`**. Progress log + nuances: **`PROGRESS.md`**.

## Media used by package galleries

The npm package declares Pi gallery media in `package.json`:

- video: [`assets/demo.mp4`](https://github.com/rutvikchandla3/pi-agent-board/blob/main/assets/demo.mp4)
- image: [`assets/banner.png`](https://github.com/rutvikchandla3/pi-agent-board/blob/main/assets/banner.png)

`pi.dev/packages?name=pi-agent-board` and the published npm package use these from package metadata.

## Layout

```
src/core/*.mjs          pure, node-runnable brain (store, events, derive, heuristics, launch, rows, …)
src/runtime/            service.mjs (dispatch/reply/stop/safety/recovery)
src/ui/                 dashboard.ts (board UI) · pty-attach.ts (live attach surface)
src/commands/           agent-board.ts (the /agent-board command + attach)
src/index.ts            extension entry · index.ts re-export for auto-discovery
runner/                 job-runner.mjs (detached run monitor) · pty-runner.mjs (detached PTY host)
assets/                 banner and demo video for GitHub/npm/pi.dev
test/ test-support/     node --test suite + fake-pi worker stub
```

## Develop

```bash
npm run typecheck
npm test
npm run pack:dry
# or all checks:
npm run verify
```

Config env: `AGENT_BOARD_ROOT` (store location), `AGENT_BOARD_SUMMARY_MODEL` (summary model; default `gpt-4o`, `off` to disable), `AGENT_BOARD_DISABLE_PTY=1` / `AGENT_BOARD_FORCE_PTY=1` (override PTY attach mode), `AGENT_BOARD_ATTACH_MOUSE=0` (fall back to terminal-native selection). Legacy `AGENT_VIEW_*` env vars are still honored for migration.
