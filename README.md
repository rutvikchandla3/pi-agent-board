# Pi Agent Board

A Claude-Code-style **agent board** for [Pi](https://github.com/earendil-works/pi-mono): one full-screen TUI to dispatch, monitor, peek/reply to, attach to, and manage multiple **background Pi sessions**. Each row is a real, persisted, resumable Pi session — not a transient subagent job.

Built on Pi's public extension/session/TUI APIs. Implements `PRD.md` / `IMPLEMENTATION_PLAN.md`.

## Install

From npm after publish:

```bash
pi install npm:pi-agent-board
pi                          # then type /agent-board
pi --agent-board             # launch straight into the dashboard UI
```

From a local checkout while developing:

```bash
npm install
pi install "$(pwd)"          # or symlink this repo into ~/.pi/agent/extensions/agent-board
pi
```

> **Requires working pi provider auth.** The dashboard launches background `pi` workers; if pi
> can't reach a model provider, rows will sit in `Working`. Confirm with
> `pi --mode json -p --no-session "say hi"` (must end in an `agent_end` event). See **VERIFY.md**.

## What it does

- **`/agent-board`** opens a full-screen dashboard, global across projects.
- **`pi --agent-board`** starts directly in a cleaner dashboard-first UI (no normal Pi header/footer chrome) and quits Pi when you leave it.
- **Dispatch** by typing in the bottom input and pressing `enter` → a new persisted Pi session + headless worker.
- **Live rows** grouped by stage: Queued · Working · Needs input · Idle · Done · Failed · Stopped.
- **Peek** (`space`) a row for its summary, blocker/question, and latest output; **reply** (`r`) inline without attaching.
- **Attach** (`enter` or `→` / `>`) to continue the full interactive Pi session (confirms + interrupts if it's still running); `←` from an empty attached-session input returns to the dashboard (`/agent-board` works too).
- **Transcript view** (`v`) opens a full-screen read-only live transcript without interrupting it; **back** with (`←` / `<`).
- **Manage:** rename (`ctrl+r`), pin (`ctrl+t`), stop (`ctrl+s`), delete selected (`ctrl+x`, archives row & keeps the session), delete all inactive rows in the selected state (`X`), filter (`/`, supports `s:<state>` + free text), help (`?`).
- **Durable & resumable:** survives `/reload` and pi restart; reconciles runs whose monitor died.
- **Safe parallelism:** same-repo parallel writers are auto-isolated into git worktrees.

## How it works

The extension owns the dashboard + a file-backed store at `~/.pi/agent/agent-board/`. Each dispatch launches a **detached `runner/job-runner.mjs`** (plain Node, survives pi exiting) that spawns a headless worker — `pi --mode json -p --session <file> "<prompt>"` — streams its JSON events into `events.jsonl`, and reduces them into `status.json` + the row's `state.json`. The dashboard polls those files. No daemon, no `pi-subagents` internals. Full design + the exact Pi API contract: **`docs/EXPLORATION.md`**. Progress log + nuances: **`PROGRESS.md`**.

## Layout

```
src/core/*.mjs          pure, node-runnable brain (store, events, derive, heuristics, rows, …)
src/runtime/            service.mjs (dispatch/reply/stop/safety/recovery)
src/ui/                 dashboard.ts (the ctx.ui.custom component)
src/commands/           agent-board.ts (the /agent-board command + attach)
src/index.ts            extension entry · index.ts re-export for auto-discovery
runner/                 job-runner.mjs (detached per-run monitor)
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

Config env: `AGENT_BOARD_ROOT` (store location), `AGENT_BOARD_SUMMARY_MODEL` (summary model; default `gpt-4o`, `off` to disable). Legacy `AGENT_VIEW_*` env vars are still honored for migration.
