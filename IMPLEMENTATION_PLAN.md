# Implementation Plan: Pi Agent Board Extension

**Status:** Draft  
**Depends on:** `PRD.md`  
**Last Updated:** 2026-05-30

---

## 1. Purpose

This document turns the PRD into an execution-ready technical plan.

It answers:

1. what we are building first,
2. how the MVP will work internally,
3. what files/modules we need,
4. what sequence we should implement in,
5. what product decisions are now locked.

---

## 2. Version / platform assumptions

Implementation will target the **active Pi runtime**:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`

Key references already validated:

- `docs/extensions.md`
- `docs/tui.md`
- `docs/sessions.md`
- `docs/keybindings.md`
- `examples/extensions/subagent/index.ts`
- `examples/extensions/plan-mode/index.ts`
- `~/.pi/agent/npm/node_modules/pi-subagents/README.md`
- `~/.pi/agent/npm/node_modules/pi-subagents/src/...` (reference only)

### Hard constraints

- Use **public Pi extension/session/TUI APIs** first.
- Do **not** runtime-import `pi-subagents/src/...` internals as if they are a stable library API.
- Background Pi workers are **headless**; they do not own UI. Parent dashboard owns all visualization.

## 2.1 Product decisions locked on 2026-05-30

These decisions are now considered part of the MVP contract unless changed explicitly later.

1. **Dashboard scope is global across projects by default.**
2. **Primary MVP entry point is `/agent-board`.**
3. **Design should stay extensible for a future `/bg` flow.**
4. **Attaching to a running background session should interrupt with confirmation, then attach.**
5. **Same-repo parallel writer sessions require worktree isolation.**
6. **MVP may use a cheap model summarizer, with heuristics as fallback.**
7. **Returning to the dashboard via `/agent-board` is acceptable for MVP.**

---

## 3. MVP implementation strategy

## 3.1 What we will build first

We will build a **session-oriented background dashboard** for Pi.

Each dashboard row will represent:

- a real Pi session file,
- persisted agent-board metadata,
- one active or inactive background run history,
- resumable state even after the worker exits.

## 3.2 What we will *not* build in the first pass

We will **not** start with:

- a permanent always-on daemon,
- cloud/remote execution,
- PR-aware row badges,
- shell-job rows (`! command`),
- exact Claude attach/detach parity from day one,
- direct dependency on `pi-subagents` internals.

## 3.3 Architectural choice for MVP

### Decision
For MVP, use a **file-backed detached runner model**, not a centralized daemon.

That means:

1. the extension owns the dashboard and store,
2. each background execution is launched via a detached **runner shim** process,
3. the runner shim spawns a headless Pi worker,
4. the shim writes durable status/event files,
5. the dashboard rehydrates by scanning those files.

### Why this is the best MVP choice

It gives us:

- persistence across Pi restart,
- no dependency on current extension process staying alive,
- real background work,
- simpler operational model than a per-user supervisor daemon,
- a clean path to a future daemon if needed.

### Why not a daemon first

A real supervisor/daemon is attractive, but it adds early complexity around:

- discovery and reconnection,
- process ownership,
- shutdown/restart semantics,
- stale socket/IPC failure modes,
- multi-instance coordination.

We can reach useful Claude-like behavior without paying that cost up front.

---

## 4. High-level architecture

```text
Pi Extension (interactive parent)
  ├─ /agent-board command
  ├─ dashboard TUI
  ├─ peek panel UI
  ├─ store reader/writer
  ├─ job launcher
  └─ attach/reply controls

Detached job-runner shim (one per active run)
  ├─ owns pid/lock/status for that run
  ├─ spawns headless Pi worker
  ├─ parses JSON events from worker stdout
  ├─ updates status.json + events.jsonl
  └─ exits when worker exits

Headless Pi worker
  ├─ runs against real session file
  ├─ executes tools / produces assistant output
  └─ exits when that run is complete
```

## 4.1 Parent extension responsibilities

The extension will:

- open and render the dashboard,
- dispatch new background sessions,
- tail/poll run status,
- show grouped rows,
- let the user peek/reply,
- attach to a session,
- stop/delete/pin/rename rows,
- recover dashboard state on reload/restart.

## 4.2 Detached runner shim responsibilities

The shim will:

- create/update lock state for one run,
- spawn Pi in JSON mode,
- persist raw events,
- derive summary/state snapshots,
- mark completion/failure,
- release lock and exit.

## 4.3 Pi worker responsibilities

The Pi worker will:

- run a single background turn (which may internally span multiple tool calls/turn loops until Pi completes the request),
- persist the actual session transcript,
- emit structured JSON events.

---

## 5. User-visible flows

## 5.1 Open dashboard

User runs:

- `/agent-board`

Result:

- full-screen custom TUI component opens,
- rows across projects are loaded by default,
- live jobs are watched.

## 5.2 Dispatch new background session

1. User types task in dashboard input.
2. Extension creates a new managed session record.
3. Extension assigns a session file path.
4. Extension launches detached runner shim.
5. Dashboard row enters `queued` then `working`.

## 5.3 Peek and reply

1. User selects row and opens peek.
2. Peek shows summary + recent output + blocker/question.
3. User types reply.
4. Extension appends reply by launching a new run for the same session.
5. Row re-enters `working`.

## 5.4 Attach

1. User selects row and attaches.
2. If row is idle/completed/needs_input, switch into that session file.
3. If row is actively running, MVP behavior will be one of:
   - confirm interrupt + attach, or
   - block until idle.

(Needs product decision; see section 16.)

## 5.5 Return to dashboard

MVP baseline:

- user runs `/agent-board` again from attached session.

Stretch:

- dedicated shortcut / detach flow back to dashboard.

## 5.6 Restart / reload recovery

When Pi restarts or `/reload` happens:

1. extension scans managed store,
2. reconstructs rows,
3. checks whether any runner pids are still alive,
4. resumes watching active statuses,
5. leaves completed rows intact.

---

## 6. Proposed package / file layout

Recommended repo/package structure:

```text
package.json
README.md
PRD.md
IMPLEMENTATION_PLAN.md

src/
  index.ts

  commands/
    agent-board.ts
    bg.ts

  dashboard/
    dashboard-component.ts
    dashboard-state.ts
    dashboard-keymap.ts
    peek-panel.ts
    filters.ts
    groups.ts

  runtime/
    launch-run.ts
    attach-session.ts
    reply-to-session.ts
    derive-row-state.ts
    pid.ts
    locks.ts

  store/
    paths.ts
    schemas.ts
    roster.ts
    migrations.ts
    files.ts

  summaries/
    summarize.ts
    heuristics.ts

  safety/
    worktree.ts
    repo-coordination.ts

  session/
    session-paths.ts
    session-meta.ts

  test-support/
    fixtures.ts
    fake-events.ts

runner/
  job-runner.mjs
```

## Important note about the runner

The detached runner should be a **plain `.mjs` file**, not a TypeScript file that assumes Pi’s internal `jiti` loader.

Reason:

- Pi can load extension TS files internally,
- but a detached external Node process should not depend on Pi’s extension loader machinery to boot.

So:

- extension code can stay in TS,
- detached runner should be plain JS/MJS.

---

## 7. Persistent data model

Use a user-scoped store root:

```text
~/.pi/agent/agent-board/
```

Recommended layout:

```text
~/.pi/agent/agent-board/
  roster.json
  sessions/
    <viewId>.jsonl
  views/
    <viewId>/
      meta.json
      state.json
      runs/
        <runId>/
          status.json
          events.jsonl
          stdout.log
          stderr.log
          pid.json
```

## 7.1 `roster.json`

Global index of known rows.

Suggested shape:

```json
{
  "version": 1,
  "views": ["view_abc", "view_def"]
}
```

## 7.2 `meta.json`

Stable row metadata.

Suggested shape:

```json
{
  "id": "view_abc",
  "name": "flaky-test-fix",
  "cwd": "/path/to/repo",
  "sessionFile": "/Users/.../.pi/agent/agent-board/sessions/view_abc.jsonl",
  "createdAt": 1760000000000,
  "updatedAt": 1760000010000,
  "pinned": false,
  "kind": "pi-session",
  "defaultModel": null,
  "worktreeMode": "off",
  "worktreePath": null,
  "source": "agent-board"
}
```

## 7.3 `state.json`

Current dashboard state snapshot derived from latest run.

Suggested shape:

```json
{
  "viewId": "view_abc",
  "currentRunId": "run_123",
  "semanticState": "working",
  "processState": "alive",
  "summary": "Editing auth middleware",
  "lastActivityAt": 1760000015000,
  "updatedAt": 1760000015000,
  "needsInput": false,
  "hasError": false,
  "latestAssistantPreview": "I found the issue in ...",
  "latestTool": {
    "name": "edit",
    "path": "src/auth/middleware.ts"
  }
}
```

## 7.4 `runs/<runId>/status.json`

Per-run durable execution snapshot.

Suggested shape:

```json
{
  "runId": "run_123",
  "viewId": "view_abc",
  "pid": 12345,
  "startedAt": 1760000010000,
  "endedAt": null,
  "exitCode": null,
  "semanticState": "working",
  "processState": "alive",
  "summary": "Running tests",
  "lastActivityAt": 1760000015000,
  "currentTool": "bash",
  "latestAssistantPreview": "Now validating the fix",
  "question": null,
  "error": null
}
```

## 7.5 Why both row state and run state exist

We need both because:

- a row/session persists across many prompts/replies,
- a run is a single active execution attempt.

This separation makes reply/resume/attach logic much cleaner.

---

## 8. Session creation and execution model

## 8.1 Creating a managed session

We will create a predictable managed session file path:

```text
~/.pi/agent/agent-board/sessions/<viewId>.jsonl
```

We do **not** need to manually synthesize the whole session file up front if Pi can create it when launched with `--session <path>`.

Recommended first implementation:

- choose new session file path,
- launch Pi against that path with the initial prompt,
- let Pi create/persist the actual transcript.

## 8.2 Launching a background run

The parent extension launches:

```text
node runner/job-runner.mjs <args>
```

The runner then launches Pi similar to:

```text
pi --mode json --session <sessionFile> <prompt>
```

Notes:

- use real cwd for the session or worktree path if isolated,
- persist stdout JSON events,
- persist stderr separately,
- update `status.json` continuously.

## 8.3 Why use a runner shim instead of spawning Pi directly from the dashboard process

If we spawn Pi directly from the extension process:

- dashboard lifetime and child monitoring are tightly coupled,
- a parent exit/reload can orphan derived state updates,
- status persistence becomes fragile.

The shim solves that by being the durable monitor for one run.

## 8.4 Runner locking rules

A session row should never have two active runs at once.

Enforce with:

- `pid.json` / lock file in the current run directory,
- on new run launch, check if prior run pid is alive,
- if alive, block/interrupt/replace according to user action.

---

## 9. Dashboard state derivation

We need deterministic rules to turn raw events into row state.

## 9.1 Semantic state rules

### While runner alive
- `queued` if worker process started but no meaningful activity yet
- `working` once assistant/tool activity begins

### After worker exits successfully
- `needs_input` if final assistant output is asking for a decision / clarification
- `completed` if task appears finished
- `idle` only for sessions backgrounded without a one-shot task framing, or when explicitly marked as still open-ended

### After worker exits unsuccessfully
- `failed`

### If explicitly stopped by user
- `stopped`

## 9.2 Process/liveness rules

- `alive` if run pid exists and is live
- `exited` otherwise

## 9.3 Summary derivation rules (MVP)

MVP summaries should use a **cheap model summarizer when available**, with deterministic heuristics as fallback.

Priority order:

1. cheap model summary generated from latest meaningful activity/output
2. active tool summary (`Editing …`, `Running tests …`)
3. explicit blocker/question extracted from latest assistant text
4. first sentence of latest assistant output
5. stderr/error summary if failed
6. fallback status text (`Queued`, `Idle`, `Done`)

## 9.4 Needs-input heuristics

Initial heuristic triggers:

- latest assistant text ends in a direct question,
- contains phrases like `need your input`, `which option`, `should I`, `please confirm`,
- runner sees explicit structured blocker markers if we later add them.

Later we can replace or augment this with a lightweight classifier.

---

## 10. UI implementation plan

## 10.1 Dashboard surface

Use `ctx.ui.custom()` with a full-screen custom TUI component.

Why:

- it is the strongest documented Pi UI primitive,
- it can fully own keyboard handling while open,
- it avoids awkward composition with transcript rows.

## 10.2 Dashboard sections

- **Header**: title, global scope/default filters, counts, maybe active defaults
- **Grouped list**: rows by state
- **Input bar**: dispatch or filter
- **Footer**: key hints

## 10.3 Row content (MVP)

Each row should show:

- icon/state glyph
- name
- summary
- age (`2m`, `10s`)
- cwd basename or repo label
- optional pin marker

## 10.4 Peek panel

Implement as either:

- nested mode inside dashboard component, or
- secondary `ctx.ui.custom()` component.

Recommendation:

- keep it inside dashboard component state so navigation remains simple.

Peek content:

- state
- summary
- last meaningful output
- question/blocker if any
- reply editor/input

## 10.5 Attach flow

Attach uses session switching APIs from Pi.

Recommended behavior:

- from dashboard, choose attach,
- if safe to attach, switch to target session file,
- preserve enough metadata so `/agent-board` can reopen dashboard later.

## 10.6 Why dashboard should not be its own long-lived special session in V1

We do not need a dedicated dashboard transcript/session to ship MVP.

Using `/agent-board` as a fullscreen transient UI is simpler because:

- less session juggling,
- fewer stale context problems,
- easier to invoke from any session.

---

## 11. Safety and repository coordination

## 11.1 MVP repo-safety rule

Assume every background coding session is **write-capable** unless explicitly read-only.

So in MVP:

- same-repo parallel writer sessions are allowed **only when each session runs in its own worktree**,
- otherwise the extension must block the second writer launch.

This avoids silent file clobbering and matches the locked product decision that worktree isolation is required for same-repo parallel writers.

## 11.2 Worktree strategy

Recommended phased strategy:

### Phase A
- support explicit `worktree` mode on dispatch
- create one worktree per managed session in a git repo
- run that session in the worktree path
- persist `worktreePath` in metadata
- require this mode for same-repo parallel writer sessions

### Phase B
- make worktree isolation the default for same-repo parallel writer sessions

### Phase C
- consider broader default-on worktrees for all managed writer sessions in git repos if product wants stricter isolation

## 11.3 Cleanup policy

Deleting a row should be separate from deleting data.

MVP recommendation:

- deleting a row removes it from dashboard and marks it archived,
- transcript/session file is preserved by default,
- worktree deletion requires explicit confirmation.

This is safer than Claude-like destructive cleanup in V1.

---

## 12. Detailed milestone plan

## Milestone 0 — scaffold and primitives

### Goal
Create the extension skeleton and all core types/paths.

### Tasks
- Create package structure.
- Add extension entrypoint.
- Add constants for agent-board storage root.
- Add JSON schemas/types for roster/meta/state/status.
- Add safe file helpers + atomic writes.
- Add migration/version field support.

### Exit criteria
- Extension loads cleanly.
- `/agent-board` command exists and opens a placeholder UI.
- Store root initializes.

---

## Milestone 1 — detached runner + durable store

### Goal
Be able to dispatch a background session and persist execution state.

### Tasks
- Implement `job-runner.mjs`.
- Implement row/session creation.
- Implement run directory creation.
- Launch Pi worker in JSON mode.
- Capture stdout JSON lines and stderr logs.
- Update `runs/<runId>/status.json` continuously.
- Update row `state.json` on run completion/progress.
- Add lock/pid handling.

### Exit criteria
- Dispatch creates session file + metadata.
- Background run survives parent Pi reload/exit.
- Reopening `/agent-board` can rediscover the row and latest status.

---

## Milestone 2 — dashboard list + live updates

### Goal
Render useful grouped rows with live status.

### Tasks
- Implement dashboard component state.
- Implement list rendering with selection.
- Implement grouping by semantic state.
- Implement polling or file-watch refresh loop.
- Implement dispatch input.
- Implement text filtering and `s:<state>` filtering.
- Add footer key hints.

### Exit criteria
- User can dispatch from dashboard.
- Row becomes `queued` → `working` → final state.
- Dashboard reflects updates live enough for practical use.

---

## Milestone 3 — peek + reply

### Goal
Support lightweight triage without attach.

### Tasks
- Add peek state mode/panel.
- Show summary + recent output + blocker.
- Add reply input.
- Launch a new run for the same session on reply.
- Prevent overlapping runs for same session.

### Exit criteria
- User can answer a blocked session from peek.
- Session continues from same transcript/session file.

---

## Milestone 4 — attach / running-session handling / recovery polish

### Goal
Make dashboard useful alongside normal Pi sessions.

### Tasks
- Implement attach to idle/completed/needs-input sessions.
- Decide and implement behavior for attach-while-running.
- Rehydrate dashboard on `/reload` and Pi restart.
- Add stale pid detection.
- Add stop action.
- Add rename + pin actions.

### Exit criteria
- User can attach to a row and continue in the session.
- User can come back to `/agent-board` later and see consistent state.

---

## Milestone 5 — repo safety + worktree mode

### Goal
Prevent or isolate same-repo write conflicts.

### Tasks
- Implement repo identity detection.
- Block or warn on second active writer in same repo by default.
- Implement explicit worktree session mode.
- Persist worktree path + cleanup hooks.
- Add delete confirmations with worktree warnings.

### Exit criteria
- No silent same-repo write collisions in supported flows.
- Same-repo parallel sessions work when worktree mode is enabled.

---

## Milestone 6 — polish / post-MVP parity work

### Candidates
- `/bg` for current session
- better filtering (`a:`, repo, cwd)
- shell-job rows
- attach/detach shortcut parity
- dedicated lightweight supervisor daemon
- project-scoped filters/views layered on top of the global default dashboard

---

## 13. Testing plan

## 13.1 Unit tests

Focus areas:

- store migrations
- atomic file writes
- row-state derivation
- needs-input heuristics
- summary heuristics
- repo identity detection
- worktree path handling

## 13.2 Integration tests

Use temp dirs/repos and spawned mock/background processes to verify:

- dispatch creates durable artifacts
- runner updates status correctly from streamed JSON events
- recovery after parent exit/restart
- attach to managed session path
- reply launches new run against same session file
- same-repo concurrency safety

## 13.3 Manual acceptance scenarios

Required manual flows:

1. Dispatch one session and watch it finish.
2. Dispatch two sessions in different repos.
3. Dispatch two sessions in same repo and confirm safety rule.
4. Peek and reply to blocked session.
5. Attach to completed session and continue.
6. Reload Pi and reopen `/agent-board`.
7. Kill Pi parent while background run continues; reopen dashboard later.
8. Delete row with/without worktree.

---

## 14. Key engineering decisions to lock early

1. **Detached runner shim is plain `.mjs`, not TS.**
2. **Managed sessions use predictable agent-board-owned session file paths.**
3. **One row = one real session file.**
4. **One run = one detached execution attempt against that session.**
5. **Dashboard is a fullscreen custom UI, not a special transcript mode.**
6. **MVP uses a cheap model summarizer when available, with heuristics fallback for summaries/state.**
7. **MVP avoids importing `pi-subagents` internals.**

---

## 15. Risks and fallback choices

## Risk 1: attach while running is messy

### Why
Concurrent interactive attach and background worker execution against the same session is unsafe/confusing.

### Fallback
In MVP, require:

- interrupt background run before attach, or
- attach only when run is idle/exited.

## Risk 2: worktree support may slow MVP

### Why
Git edge cases, dirty repos, cleanup, and path rewriting add complexity.

### Fallback
Ship with strict same-repo single-writer rule first, then add worktree mode.

## Risk 3: heuristic summaries may misclassify

### Why
Assistant text is free-form.

### Fallback
Keep state derivation conservative, and expose raw preview in peek.

## Risk 4: session switching UX may be less seamless than Claude

### Why
Pi extension APIs differ from Claude’s built-in product surface.

### Fallback
Use `/agent-board` as explicit re-entry instead of forcing full detach parity early.

---

## 16. Product decisions resolved

These product questions have now been answered and are incorporated into the MVP plan.

1. **Dashboard scope:** global across projects by default.
2. **Entry point:** `/agent-board` is required for MVP.
3. **Future extensibility:** design should remain extensible for `/bg`, but `/bg` is not required in the first implementation slice.
4. **Attach while running:** interrupt with confirmation, then attach.
5. **Same-repo parallel writers:** require worktree isolation.
6. **Summary strategy:** cheap model summarizer is allowed in MVP.
7. **Return to dashboard:** `/agent-board` is acceptable for MVP.

---

## 17. Next execution step

Once you confirm the product questions (or approve the defaults), the next step is:

### Build milestone 0 + milestone 1

That means:

- scaffold package/extension,
- implement store schema,
- implement detached runner shim,
- launch first real background managed session,
- persist durable state.

That is the right first coding slice because it validates the hardest architectural assumption early.
