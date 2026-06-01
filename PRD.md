# PRD: Pi Agent Board Extension

**Status:** Draft  
**Last Updated:** 2026-05-30  
**Owner:** TBD

## 1. Summary

Build a Pi extension that delivers a Claude Code agent-view-like experience inside Pi, packaged as **Pi Agent Board**: a single terminal UI to dispatch, monitor, reply to, attach to, and manage multiple **background Pi sessions**.

Each row in the view must represent a **real Pi session** with persisted history and resumable state, not just a transient subagent job.

## 1.1 Locked product decisions

These decisions were confirmed on 2026-05-30 and are part of the MVP contract:

- dashboard is **global across projects** by default,
- `/agent-board` is the required MVP entry point,
- implementation should remain extensible for a future `/bg` flow,
- attaching to a running background session should **interrupt with confirmation, then attach**,
- same-repo parallel writer sessions must **require worktree isolation**,
- MVP may use a **cheap model summarizer**,
- returning to the dashboard via `/agent-board` is acceptable for MVP.

## 2. Problem

Pi has strong primitives for sessions, extensions, tools, TUI components, and subagents, but it does **not** have a first-class built-in agent board. Today, users must manually juggle sessions and subagents and cannot easily:

- see all active/background work in one place,
- know which session needs input,
- reply inline without opening full transcripts,
- safely run several coding sessions in parallel,
- treat background work as first-class resumable conversations.

## 3. Product Goal

Provide a Pi-native “agent board” that feels behaviorally equivalent to Claude’s agent board where Pi’s extension APIs allow it.

The product should let a user:

1. dispatch a new background coding task,
2. watch its state and summary live,
3. peek and reply inline,
4. attach to the full session when needed,
5. detach without losing work,
6. manage many background sessions safely.

## 4. Non-Goals

### V1 non-goals

- Exact top-level CLI parity with `claude agents`.
- Cloud-hosted/background remote execution.
- Replacing `pi-subagents` as a general orchestration package.
- Multi-user/shared dashboards.
- Full PR integration, PR badges, or SCM review workflows.
- Perfect parity for every Claude keyboard shortcut.
- Full shell-job support (`! command`) in MVP.

## 5. Core Product Principles

1. **Session-oriented, not job-oriented**  
   Background work is a real Pi session with a session file.

2. **Dashboard first, transcript second**  
   Most triage should happen from the dashboard or peek panel.

3. **Safe parallelism**  
   Background coding sessions must not silently trample each other’s files.

4. **Resumable and durable**  
   The dashboard should survive Pi restart/reload and be able to rehydrate rows from disk.

5. **Public-API-first implementation**  
   Build on Pi’s documented extension/session/TUI APIs, not unstable internal package imports.

## 6. Users / Primary Use Cases

### Primary user
A Pi power user working on several independent coding tasks at once.

### Core use cases

- Dispatch a bug fix, refactor, and review task in parallel.
- Keep coding in one attached session while other sessions continue in background.
- Return to a dashboard to see which sessions are blocked or complete.
- Reply to a question from a background session without reopening the full transcript.
- Attach to a session for deep work, then return to the dashboard.
- Safely isolate edits from concurrent tasks.

## 7. User Experience

## 7.1 Entry points

V1 should support:

- `/agent-board` — open the dashboard from within Pi.
- Optional extension flag such as `--agent-board` if practical.

Stretch goals:

- `/bg [prompt]` — move current work into a managed background session, or send a follow-up prompt while backgrounding.
- `pi agents` style entrypoint, if Pi core or packaging model allows it cleanly.

## 7.2 Main dashboard

The dashboard is a full-screen custom TUI component.

It must include:

- header with current global scope/defaults,
- grouped session rows,
- bottom input for dispatch/filter,
- footer with key hints.

### Row fields
Each row should show at minimum:

- session name,
- current summary,
- semantic state,
- process/liveness state,
- relative last-activity time,
- cwd or project context,
- pin status,
- optional model/agent label.

### Row grouping
V1 groups:

- Queued
- Running
- Needs input
- In Progress
- Done

Stretch:

- Group by directory/project.
- “Ready for review” style secondary grouping.

## 7.3 States

Each session row needs two state dimensions.

### Semantic state

- `queued`
- `working`
- `needs_input`
- `idle`
- `completed`
- `failed`
- `stopped`

### Process/liveness state

- `alive`
- `exited`

This distinction is required so a session can remain resumable even when no worker process is currently alive.

## 7.4 Core interactions

### From dashboard

- `↑ / ↓` — move selection
- `Enter` — attach to selected session
- `Space` — open peek panel
- `Shift+Enter` — dispatch and attach
- `Ctrl+R` — rename session
- `Ctrl+T` — pin/unpin session
- `Ctrl+X` — stop/delete flow
- `Ctrl+S` — switch grouping mode
- `Esc` — close/clear/back
- `?` — help

Keybindings should be extension-configurable and aligned with Pi keybinding conventions.

## 7.5 Peek panel

Peek panel is the lightweight triage surface.

It must show:

- current summary,
- latest meaningful output,
- current question/blocker (if any),
- inline reply box.

It should support:

- sending a normal reply,
- optional suggested reply later,
- navigating between adjacent sessions without fully closing.

## 7.6 Attach / detach

### Attach
Attaching opens the full interactive Pi session for that row’s session file.

### Detach
Detaching returns the user to agent board without losing session state.

V1 requirement:

- attaching must work,
- detaching back to agent board must work at least from an idle/known-safe state.

Stretch:

- detach while a session is actively running by handing execution back to a headless worker.

## 8. Functional Requirements

### FR1. Background session model
Each background row must map to:

- a Pi session file,
- a persisted session ID,
- a working directory,
- a stored dashboard record,
- zero or one live worker processes at a time.

### FR2. Background execution engine
The extension must be able to:

- create a background session,
- append user messages to it,
- spawn a headless Pi worker to advance it,
- parse streaming JSON events,
- update row state live,
- mark the session resumable when the worker exits.

### FR3. Dashboard persistence
Agent-view state must persist across:

- Pi restart,
- `/reload`,
- session switching,
- worker exit.

### FR4. Dispatch
Dispatch input must:

- create a new background session from a user prompt,
- support dispatch + attach,
- support filtering mode when input matches reserved patterns.

V1 filtering support:

- `s:<state>`
- free-text substring on name/summary/cwd

Stretch:

- `a:<agent>`
- `#PR` or URL mapping

### FR5. Reply from peek
A user must be able to send a reply from peek without manually opening the attached session.

### FR6. Attach to session
A user must be able to switch into the selected session’s full transcript and continue working interactively.

### FR7. Rename / pin / stop / delete
The dashboard must support:

- renaming a session,
- pinning/unpinning,
- stopping active work,
- deleting dashboard entries,
- preserving transcript safety unless user explicitly chooses destructive cleanup.

### FR8. Safe file isolation
When background sessions may edit the same repository, the system must provide an isolation strategy.

V1:

- support optional git worktree isolation.

Later:

- automatically create worktree isolation before first mutation.

### FR9. Session summaries
Each row must have a short summary suitable for dashboard scanning.

V1:

- heuristic summary based on current tool, latest assistant text, blocker text, and terminal state.

Later:

- lightweight summarizer model pass with throttling.

### FR10. Recovery / respawn
If a worker process exits, the session must remain attachable and replyable.

If Pi is restarted, the extension must be able to reconstruct the dashboard from persisted state and resume/respawn sessions as needed.

## 9. Technical Constraints

### 9.1 Runtime target
Implementation must target the active Pi runtime:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`

Do **not** anchor on the stale legacy copy under `~/.pi/agent/npm/node_modules/@mariozechner/...`.

### 9.2 Public API constraint
Implementation should use Pi’s documented/public extension APIs, especially:

- extension lifecycle/events,
- `ctx.ui.custom()` and TUI components,
- widgets/footer/header,
- message renderers,
- session switching / newSession / switchSession / fork APIs,
- extension commands and shortcuts.

### 9.3 No unstable internal imports
Do **not** runtime-import `~/.pi/agent/npm/node_modules/pi-subagents/src/...` internals.

Allowed:

- study `pi-subagents` source as a reference,
- copy/adapt patterns if necessary.

Not allowed:

- depending on its internal TS files as if they were a stable library contract.

### 9.4 Headless child constraint
Background workers will run headless.

This means:

- child Pi processes should run in JSON/print-style non-interactive mode,
- child sessions do not own UI,
- parent agent board owns all live visualization and state aggregation.

## 10. Suggested Architecture

### Option A — recommended
Build a **session-oriented background engine** specifically for agent board.

Components:

- `dashboard.ts` — main TUI
- `peek-panel.ts` — inline triage UI
- `store.ts` — persisted roster/state
- `supervisor.ts` — worker spawn/watch/respawn
- `session-launch.ts` — create/advance background sessions
- `session-summary.ts` — short summary generation
- `worktree.ts` — optional edit isolation

Why: this best matches Claude’s product shape.

### Option B — fallback
Fork/copy the official `examples/extensions/subagent` example and evolve it into a session-based engine.

Why: uses clean public APIs, but requires more features to be built from scratch.

### Option C — partial reuse
Use `pi-subagents` only as a design reference for:

- async tracking,
- widget rendering,
- nested progress ideas,
- worktree patterns.

Why: high leverage, lower coupling.

## 11. MVP Scope

### Included in MVP

- `/agent-board` dashboard
- global cross-project session view by default
- persisted roster/store
- create background Pi sessions
- spawn headless workers to process prompts
- live row updates
- project-safe attach to full session
- peek + reply
- rename/pin/stop/delete
- basic grouping
- cheap model-backed summaries with heuristic fallback
- required worktree isolation for same-repo parallel writer sessions

### Excluded from MVP

- shell job rows (`! command`)
- PR badges / PR-aware grouping
- full Claude-style detach semantics while actively running

## 12. Phase Plan

### Phase 1 — foundation

- Extension scaffold
- Persistent store format
- Worker launcher
- Event parser
- `/agent-board` TUI
- Dispatch + live updates

### Phase 2 — interactive workflow

- Peek panel
- Inline reply
- Attach flow
- Safe detach-back path
- Rename/pin/stop/delete polish
- Restore dashboard after restart/reload

### Phase 3 — parity improvements

- Better summaries
- Auto worktree isolation
- Idle reap + lazy respawn
- Shell job rows
- Advanced filtering/grouping
- `/bg` flow for current interactive session

## 13. Acceptance Criteria

The PRD is satisfied for MVP when:

1. A user can open `/agent-board` and see a dashboard UI.
2. A user can dispatch a new background coding task from the dashboard.
3. The task creates a real persisted Pi session file.
4. The row updates while the background worker runs.
5. If the worker exits, the row remains in the dashboard and is still resumable.
6. A user can open peek, read current context, and send a reply.
7. A user can attach to the full session from the dashboard.
8. Dashboard state survives Pi restart or `/reload`.
9. Two tasks in the same repo can be run without silent file corruption when worktree mode is enabled.
10. The implementation does not depend on unstable `pi-subagents/src/...` runtime imports.

## 14. Success Metrics

Initial success measures:

- User can manage at least 3 concurrent background sessions comfortably.
- Attach/peek/reply flows feel faster than manual `/resume` juggling.
- Dashboard rehydration works reliably after reload/restart.
- No known file-clobber incidents in supported isolation mode.

## 15. Risks / Open Questions

1. **Detach semantics**  
   How close can we get to Claude’s “return to agent board” behavior using only extension/session APIs?

2. **Top-level launch experience**  
   Is `/agent-board` enough, or do we need a true standalone startup path?

3. **Worktree timing**  
   Should worktrees be created at dispatch time or lazily on first mutation?

4. **Current session backgrounding**  
   When `/bg` lands later, should it create a fresh managed background session from current transcript, or simply convert current session ownership?

## 16. Reference Inputs

Product/behavior reference:

- Claude agent-view docs: https://code.claude.com/docs/en/agent-view

Pi implementation references:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts`
- `~/.pi/agent/npm/node_modules/pi-subagents/README.md`

## 17. Recommendation

Proceed with a **session-oriented agent-board extension** as the primary implementation path.

Do **not** treat this as a UI wrapper over `pi-subagents`. Use `pi-subagents` as a source of implementation ideas, but build the actual product around persisted Pi sessions, a parent-owned dashboard, and a lightweight supervisor/store.
