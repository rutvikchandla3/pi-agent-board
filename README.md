# Pi Agent View

A Claude-Code-style **agent-view dashboard for [Pi](https://github.com/earendil-works/pi-mono)**:
one full-screen TUI to dispatch, monitor, peek/reply to, attach to, and manage multiple
**background Pi sessions**. Each row is a real, persisted, resumable Pi session — not a
transient subagent job.

Built on Pi's public extension/session/TUI APIs. Implements `PRD.md` / `IMPLEMENTATION_PLAN.md`.

## Quick start

```bash
npm install                 # dev-only: typescript + @types/node (runtime uses pi's own deps)
ln -s "$(pwd)" ~/.pi/agent/extensions/agent-view    # install (auto-discovered)
pi                          # then type /agents  (or press Ctrl+G)
pi --agent-view             # launch straight into the dashboard UI
```

> **Requires working pi provider auth.** The dashboard launches background `pi` workers; if pi
> can't reach a model provider, rows will sit in `Working`. Confirm with
> `pi --mode json -p --no-session "say hi"` (must end in an `agent_end` event). See **VERIFY.md**.

## What it does

- **`/agents`** opens a full-screen dashboard, global across projects.
- **`pi --agent-view`** starts directly in a cleaner dashboard-first UI (no normal Pi header/footer chrome) and quits Pi when you leave it.
- **Dispatch** by typing in the bottom input and pressing `enter` → a new persisted Pi session + headless worker.
- **Live rows** grouped by state: Needs input · Working · Queued · Failed · Completed · Idle · Stopped.
- **Peek** (`space`) a row for its summary, blocker/question, and latest output; **reply** (`r`)
  inline without attaching.
- **Session view** (`→` / `>`) opens a full-screen live transcript view for the selected session
  without interrupting it; **back** with (`←` / `<`).
- **Attach** (`enter`) to continue the full interactive session (confirms + interrupts if it's
  still running); `/agents` returns you to the dashboard.
- **Manage:** rename (`ctrl+r`), pin (`ctrl+t`), stop (`ctrl+s`), delete (`ctrl+x`, archives row & keeps the session),
  filter (`/`, supports `s:<state>` + free text), help (`?`).
- **Durable & resumable:** survives `/reload` and pi restart; reconciles runs whose monitor died.
- **Safe parallelism:** same-repo parallel writers are auto-isolated into git worktrees.

## How it works (one paragraph)

The extension owns the dashboard + a file-backed store at `~/.pi/agent/agent-view/`. Each
dispatch launches a **detached `runner/job-runner.mjs`** (plain Node, survives pi exiting) that
spawns a headless worker — `pi --mode json -p --session <file> "<prompt>"` — streams its JSON
events into `events.jsonl`, and reduces them into `status.json` + the row's `state.json`. The
dashboard polls those files. No daemon, no `pi-subagents` internals. Full design + the exact Pi
API contract: **`docs/EXPLORATION.md`**. Progress log + nuances: **`PROGRESS.md`**.

## Layout

```
src/core/*.mjs     pure, node-runnable brain (store, events, derive, heuristics, rows, …)
src/runtime/       service.mjs (dispatch/reply/stop/safety/recovery)
src/ui/            dashboard.ts (the ctx.ui.custom component)
src/commands/      agents.ts (the /agents command + attach)
src/index.ts       extension entry · index.ts re-export for auto-discovery
runner/            job-runner.mjs (detached per-run monitor)
test/ test-support/  node --test suite + fake-pi worker stub
```

## Develop

```bash
npm run typecheck   # tsc --noEmit against pi's real type defs (path-mapped, no install)
npm test            # node --test: unit + hermetic runner integration (no API key needed)
```

Config env: `AGENT_VIEW_ROOT` (store location), `AGENT_VIEW_SUMMARY_MODEL` (summary model;
default `gpt-4o`, `off` to disable).
