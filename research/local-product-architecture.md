# Code Context

## Files Retrieved
1. `README.md` (lines 13-15, 41-62, 64-82, 93-116) - product promise, install/usage, feature list, current README architecture, layout, env config.
2. `PRD.md` (lines 7-23, 60-75, 91-180, 302-340, 374-389, 426-462) - product goals, MVP contract, public API constraints, worktree safety requirements, acceptance/open questions.
3. `docs/EXPLORATION.md` (lines 11-21, 23-53, 66-90, 92-138, 140-178, 180-187) - Pi extension/runtime contract, JSON worker behavior, durable store design, state rules, known gotchas.
4. `docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` (lines 1-39, 70-82, 116-129, 250-285, 287-328, 378-423, 490-538, 554-570) - live PTY attach target design, known fidelity risks, socket protocol, hardening plan.
5. `docs/BATCH_SELECTION_READ_FLOW.md` (lines 7-29, 55-123, 127-180) - multi-select and read/unread product flow.
6. `package.json` (lines 1-79) - package metadata, Pi extension entry, scripts, peer/dev/prod dependencies.
7. `src/index.ts` (lines 1-102) - extension entry, command registration, startup flag, foreground/hosted child event mirroring.
8. `src/commands/agent-board.ts` (lines 1-236) - `/agent-board` command, dashboard polling, attach loop, PTY attach vs `switchSession` fallback.
9. `src/runtime/service.mjs` (lines 1-230, 260-350, 350-789) - imperative product actions: dispatch/reply/stop/host management/archive/recovery/PTY health.
10. `src/core/types.mjs` (lines 1-180) - semantic/process/host/run/store types and group labels.
11. `src/core/paths.mjs` (lines 1-66) - on-disk store paths.
12. `src/core/store.mjs` (lines 1-271) - roster/meta/state/status/host read-write, row load/list/create.
13. `src/core/events.mjs` (lines 1-187) - JSON event reducer and projection into row state.
14. `src/core/derive.mjs` (lines 1-114) - terminal state and summary derivation.
15. `src/core/heuristics.mjs` (lines 1-202) - assistant text extraction, needs-input, tool summaries, relative time.
16. `src/core/rows.mjs` (lines 1-190) - row view-models, glyphs, unread derivation, grouping/filtering.
17. `src/core/session-view.mjs` (lines 1-155) - read-only transcript/session projection.
18. `src/core/launch.mjs` (lines 1-91) - detached JSON runner, PTY host, and title runner launch helpers.
19. `src/core/launch-options.mjs` (lines 1-150) - launch dialog cwd/model/thinking resolution.
20. `src/core/worktree.mjs` (lines 1-64) - unused git worktree helper functions.
21. `src/core/title.mjs` (lines 1-43) - title model defaults and prompt/normalization.
22. `src/core/atomic.mjs` (lines 1-108) - atomic JSON/text/log file helpers.
23. `src/core/pid.mjs` (lines 1-42) - process liveness and termination helpers.
24. `src/core/invocation.mjs` (lines 1-43) - Pi/node invocation resolution.
25. `src/ui/dashboard.ts` (lines 1-1455) - dashboard TUI state machine, launch dialog, list/peek/reply/transcript/manage modes, rendering.
26. `src/ui/pty-attach.ts` (lines 1-860) - live PTY attach component, virtual terminal, input forwarding, detach, mouse/link/copy behavior.
27. `runner/job-runner.mjs` (lines 1-246) - detached JSON-mode worker monitor, event logging/reduction, terminal summarization.
28. `runner/pty-runner.mjs` (lines 1-301) - long-lived interactive Pi PTY host and JSONL Unix socket protocol.
29. `runner/title-runner.mjs` (lines 1-80) - detached model-generated title pass.
30. `test/service.test.mjs` (lines 1-449) - service behavior tests, including current worktree-disabled/same-repo-allowed assertions.
31. `test/runner.integration.test.mjs` (lines 1-164) - JSON runner integration against fake `pi`.
32. `test/pty-runner.integration.test.mjs` (lines 1-80) - PTY runner socket/input/resize/finalize integration.
33. `test/rows.test.mjs` (lines 1-113) - grouping/filter/unread glyph tests.
34. `test/session-view.test.mjs` (lines 1-53) - active-branch transcript projection tests.
35. `test/pty-support.test.mjs` (lines 1-75) - node-pty diagnostics tests.

Note: the repo has `test/`, not `tests/`.

## Product currently does

Pi Agent Board is a Pi extension/package (`pi-agent-board` v0.2.1) that gives Pi a Claude-Code-style background agent board. The README describes it as one full-screen TUI to dispatch, monitor, peek/reply, attach to, and manage multiple background Pi sessions, with every row backed by a real persisted/resumable Pi session, not a transient job (`README.md` lines 13-15).

Implemented capabilities:

- Opens via `/agent-board` and can launch dashboard-first with `pi /agent-board` (`README.md` lines 51-52; `src/index.ts` lines 27-40; `src/commands/agent-board.ts` lines 29-57).
- Creates managed rows with stored metadata/state and a real session JSONL under `~/.pi/agent/agent-board/` (`src/core/paths.mjs` lines 11-66; `src/core/store.mjs` lines 223-271).
- Dispatches new sessions from a launch dialog with cwd, model, and thinking controls (`README.md` lines 53-55; `src/ui/dashboard.ts` lines 564-667, 734-765; `src/runtime/service.mjs` lines 375-411).
- Prefers live PTY-hosted interactive Pi sessions when `node-pty` works; falls back to the JSON one-shot runner when it does not (`src/runtime/service.mjs` lines 402-410; `runner/pty-runner.mjs` lines 80-123; `runner/job-runner.mjs` lines 42-60).
- Monitors sessions through file-backed state and groups/filter rows by semantic state, with unread glyphs based on last agent activity vs last visit (`src/core/rows.mjs` lines 44-63, 96-144, 147-190; `src/ui/dashboard.ts` lines 157-171, 1012-1050).
- Provides peek, inline reply, and read-only transcript views (`README.md` lines 56-58; `src/ui/dashboard.ts` lines 767-782, 948-965, 1239-1315; `src/core/session-view.mjs` lines 33-85).
- Attaches to live PTY hosts through `PtyAttachComponent`; if no host is available, it can start one or fall back to `ctx.switchSession(sessionFile)` (`README.md` lines 57-58; `src/commands/agent-board.ts` lines 145-205, 207-236; `src/ui/pty-attach.ts` lines 160-227, 274-311).
- Manages rows: rename, pin, stop/interrupt, mark done, archive/delete, delete-by-state, multi-select batch done/delete (`README.md` lines 59-60; `src/ui/dashboard.ts` lines 803-945; `src/runtime/service.mjs` lines 503-615).
- Reconciles stale/died runners and mirrors foreground/hosted child Pi events back into dashboard state (`README.md` line 61; `src/index.ts` lines 42-64, 83-101; `src/runtime/service.mjs` lines 617-670).
- Generates best-effort model titles and terminal summaries (`README.md` lines 55, 116; `src/runtime/service.mjs` lines 118-142; `runner/title-runner.mjs` lines 25-43; `runner/job-runner.mjs` lines 170-201).

Notable current product scope gaps:

- It explicitly does **not** auto-create worktrees and does **not** block same-repo parallel sessions (`README.md` line 62; `src/runtime/service.mjs` lines 361-397; `test/service.test.mjs` lines 233-255).
- No `/bg` command exists; only `agent-board` is registered (`PRD.md` lines 100-103, 417-424; `src/commands/agent-board.ts` lines 29-57).
- No shell-job rows or PR-aware workflows are in MVP (`PRD.md` lines 391-395).

## Main user flows

1. **Open board**
   - User runs `/agent-board` or starts Pi with `--agent-board`/`pi /agent-board` semantics.
   - `src/index.ts` registers the command and startup flag (`src/index.ts` lines 27-40, 66-81).
   - `src/commands/agent-board.ts` creates a service and opens `DashboardComponent` in `ctx.ui.custom`, polling every 700ms (`src/commands/agent-board.ts` lines 61-117).

2. **Dispatch a background session**
   - User enters insert mode (`i`), types a prompt, and presses Enter to open the launch dialog (`src/ui/dashboard.ts` lines 316-348, 564-593, 682-710).
   - Launch dialog resolves cwd/model/thinking from saved prefs and Pi scoped-model settings (`src/ui/dashboard.ts` lines 573-667; `src/core/launch-options.mjs` lines 72-100).
   - `service.dispatch()` creates a `ViewMeta`/`ViewState`, then launches either a PTY host or JSON runner, and queues title generation (`src/runtime/service.mjs` lines 375-411).

3. **Monitor board state**
   - Dashboard polls `service.rows()` and derives grouped row view-models (`src/ui/dashboard.ts` lines 157-171, 1012-1050; `src/core/rows.mjs` lines 134-144).
   - JSON runner reduces `pi --mode json` events into `status.json`/`state.json` (`runner/job-runner.mjs` lines 88-167; `src/core/events.mjs` lines 64-187).
   - PTY-hosted child Pi mirrors extension events into row state using `AGENT_BOARD_VIEW_ID` (`runner/pty-runner.mjs` lines 86-98; `src/index.ts` lines 83-101; `src/runtime/service.mjs` lines 664-670).

4. **Peek/reply/transcript triage**
   - `space` opens peek, showing summary/question/latest output/error (`src/ui/dashboard.ts` lines 948-959, 1239-1279).
   - `r` sends inline reply: if a PTY host is alive, text is injected into the PTY; otherwise the service starts a host or JSON fallback run (`src/runtime/service.mjs` lines 420-430; `src/ui/dashboard.ts` lines 767-782).
   - `v` opens a non-interrupting transcript generated from the session JSONL active branch (`src/ui/dashboard.ts` lines 961-965, 1282-1315; `src/core/session-view.mjs` lines 1-85).

5. **Attach/detach**
   - Enter/arrow asks dashboard to attach. Running JSON-runner rows require confirmation/stop; live hosted rows attach directly (`src/ui/dashboard.ts` lines 977-999).
   - Command handler prefers existing PTY host, then `ensureHost()`, then `ctx.switchSession()` fallback (`src/commands/agent-board.ts` lines 145-205; `src/runtime/service.mjs` lines 462-492).
   - `PtyAttachComponent` forwards most keyboard input to the child Pi and detaches on `←`, `ctrl+]`, or `ctrl+g` when the child input line appears empty (`src/ui/pty-attach.ts` lines 160-210, 260-311).

6. **Manage and clean up**
   - Rename/pin/stop/done/delete/batch actions happen in-place through service methods (`src/ui/dashboard.ts` lines 803-945; `src/runtime/service.mjs` lines 503-615).
   - Deletes archive dashboard rows but preserve session files (`src/runtime/service.mjs` lines 563-591; README line 59).

## Key Code

### Actual dispatch path is PTY-first, JSON-runner fallback
```js
const pty = ptySupport({ refresh: true });
if (pty.ok) launchHost(meta, prompt);
else launchForView(meta, prompt, "dispatch");
```
`src/runtime/service.mjs` lines 402-404.

### Each row merges durable task state plus host/run liveness
```js
const host = readHost(root, viewId);
const hostPid = host?.runnerPid ?? readHostPid(root, viewId);
const hostAlive = Boolean(host && host.state === "alive" && isAlive(hostPid));
return { meta, state, alive, hostAlive, host };
```
`src/core/store.mjs` lines 183-186.

### Agent output drives latest preview, needs-input, and unread timestamps
```js
if (msg?.role === "assistant") {
  const text = assistantText(msg);
  if (text) {
    status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
    const nb = detectNeedsInput(text);
    status.question = nb.question;
  }
  status.lastAgentActivityAt = now;
}
```
`src/core/events.mjs` lines 96-115.

### Attach selection chooses live PTY before fallback session switch
```ts
const target = service.attachTarget(viewId);
if (target.kind === "pty" && target.socketPath) {
  const result = await openPtyAttach(...);
  return { action: result.action === "closed" ? "closed" : "detached" };
}
const ensured = service.ensureHost(viewId);
...
const result = await ctx.switchSession(latest.meta.sessionFile, ...);
```
`src/commands/agent-board.ts` lines 166-205.

## Architecture

### Data flow

```text
/agent-board command
  -> DashboardComponent (ctx.ui.custom, polled every 700ms)
  -> AgentViewService
     -> createView() writes roster/meta/state/session path
     -> launchHost() preferred OR launchForView() fallback
        -> runner/pty-runner.mjs owns interactive Pi in PTY + control.sock + host.json + screen.log
        -> runner/job-runner.mjs owns pi --mode json -p --session <file> <prompt> + events/status logs
     -> row state is stored in ~/.pi/agent/agent-board/views/<id>/state.json
Dashboard polls store -> rows/grouping/peek/transcript/attach render
```

### Architectural constraints

- **Pi public API only.** The PRD forbids unstable `pi-subagents` internals (`PRD.md` lines 311-331). Extension/UI paths use `registerCommand`, events, `ctx.ui.custom`, and `ctx.switchSession` (`docs/EXPLORATION.md` lines 23-53).
- **Extension code is TS via Pi/jiti; detached runners are plain ESM.** External runners cannot depend on Pi's TS loader (`docs/EXPLORATION.md` lines 11-21; `runner/job-runner.mjs` lines 1-10).
- **File-backed store, no daemon.** Default root is `~/.pi/agent/agent-board`; rows are loaded from roster/meta/state/host/run files and atomically written (`README.md` lines 64-82; `src/core/paths.mjs` lines 11-66; `src/core/atomic.mjs` lines 1-70).
- **Eventual consistency via polling.** Dashboard refreshes every 700ms and rerenders from store; runner/host event writes are separate processes (`src/commands/agent-board.ts` lines 15, 96-99; `src/ui/dashboard.ts` lines 157-171).
- **PTY attach is not a raw terminal takeover.** `ctx.ui.custom()` is line/component based; the PTY plan calls out that Pi exposes no documented raw terminal takeover API and uses a virtual terminal as best effort (`docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 70-82, 287-328; `src/ui/pty-attach.ts` lines 26-28, 213-227).
- **Native dependency risk.** Live attach depends on `node-pty` and `@xterm/headless` in production deps (`package.json` lines 75-78). Service probes node-pty and falls back/diagnoses failures (`src/runtime/service.mjs` lines 751-789; `test/pty-support.test.mjs` lines 17-75).
- **Provider auth/network is a runtime prerequisite.** JSON one-shot workers can hang indefinitely without provider auth/network, leaving rows `Running` until stopped (`README.md` lines 41-43; `docs/EXPLORATION.md` lines 79-87).
- **Same-repo safe parallelism is currently a product/architecture mismatch.** PRD says same-repo parallel writers must require worktree isolation (`PRD.md` lines 17-23, 68-75, 374-389), but code disables worktree mode and allows parallel same-repo sessions (`src/runtime/service.mjs` lines 361-397; `test/service.test.mjs` lines 233-255).
- **Transcript view is active-branch only.** It walks from the last JSONL leaf to root and renders selected message/custom/summary entries, not a complete branch tree/tool transcript (`src/core/session-view.mjs` lines 1-85, 87-155; `test/session-view.test.mjs` lines 9-53).

## High-impact improvement opportunities

### 1. P0 - Restore safe parallelism with real worktree isolation

**Impact:** Highest. The product is for parallel coding agents; silent file clobbering would break trust and violates the locked MVP contract.

**Evidence:**
- PRD locked decision: same-repo parallel writer sessions must require worktree isolation (`PRD.md` lines 17-23) and core principle says background coding sessions must not silently trample files (`PRD.md` lines 68-75).
- MVP scope includes required worktree isolation (`PRD.md` lines 374-389); acceptance mentions no silent corruption when worktree mode is enabled (`PRD.md` lines 426-439).
- Current README says the board does not auto-create worktrees and does not block multiple same-repo sessions (`README.md` line 62).
- Current service rejects explicit worktree requests and always persists `worktreeMode: "off"` (`src/runtime/service.mjs` lines 361-397).
- Tests lock the unsafe current behavior: explicit worktree requests are rejected and a second same-repo session is allowed (`test/service.test.mjs` lines 233-255).
- Worktree helper code exists but is unused (`src/core/worktree.mjs` lines 1-64).

**Direction:** Add auto or explicit worktree mode in the launch dialog/service, block non-isolated same-repo write-capable sessions, consider `hostAlive && writeCapable && worktreeMode !== "worktree"` as active risk (called out in `docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 410-423), and update tests to assert safety.

### 2. P0 - Add privacy/retention controls for raw logs and terminal streams

**Impact:** High. Agent output, prompts, tool args, terminal output, OSC52 clipboard, and inline images can include secrets. The product persists them under the agent-board store without a visible retention/privacy model.

**Evidence:**
- JSON runner writes raw event lines, stdout, and stderr logs (`runner/job-runner.mjs` lines 88-119).
- PTY runner appends raw PTY output to `screen.log` and broadcasts raw output (`runner/pty-runner.mjs` lines 118-123).
- Attach replays the last 100KB of `screen.log` (`src/ui/pty-attach.ts` lines 789-809).
- Attach forwards OSC52 clipboard and terminal image/file protocols unless env-disabled (`src/ui/pty-attach.ts` lines 770-787).
- Deletes archive rows but keep session files/data (`src/runtime/service.mjs` lines 563-591; README line 59).

**Direction:** Document what is persisted, add retention/clear-log commands, configurable screen-log/event-log limits, stricter file permissions, opt-out for `screen.log`, safer defaults for OSC52/image forwarding, and an explicit destructive cleanup option for sessions/logs/worktrees.

### 3. P1 - Preflight and explain provider-auth/network hangs before/while dispatching

**Impact:** High for first-run and support. A user can see rows stuck in Running with no clear next action when provider auth/network is broken.

**Evidence:**
- README warns background workers require working Pi provider auth and can sit in `Running` (`README.md` lines 41-43).
- Exploration documents a verified hang where `pi --mode json -p` blocks indefinitely at provider request with no `agent_end` (`docs/EXPLORATION.md` lines 79-87).
- JSON runner has no worker timeout/diagnostic beyond user stop; it only finalizes on worker close or explicit SIGTERM/SIGINT (`runner/job-runner.mjs` lines 122-167).
- Dashboard has rich PTY diagnostics, but no equivalent provider-health banner (`src/ui/dashboard.ts` lines 1431-1455 are node-pty-specific).

**Direction:** Add a cheap preflight (`pi --mode json -p --no-session "say hi"`) cache/check, a stalled-provider detector (no assistant/tool activity after N seconds), dashboard banner/help, and a recovery action to stop/retry with a clearer message.

### 4. P1 - Make PTY host lifecycle explicit and resource-safe

**Impact:** High as usage scales. PTY-hosted Pi processes are long-lived by design; users need clear controls for interrupt vs close host vs archive, and stale hosts need predictable cleanup.

**Evidence:**
- PTY runner starts a long-lived child Pi, socket, `host.json`, and `screen.log` (`runner/pty-runner.mjs` lines 3-8, 49-78, 136-201).
- Service has `terminateHost()` but dashboard help/actions expose `ctrl+s stop`, which only sends `interrupt` to a live host (`src/runtime/service.mjs` lines 438-453; `src/ui/dashboard.ts` lines 810-815, 1400-1422).
- PTY plan explicitly says stop needs two actions: interrupt active agent and kill hosted Pi, with a separate confirm if needed (`docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 378-383).
- Warm host pruning exists but only triggers from certain service paths; idle hosts are kept up to env-configured max/TTL (`src/runtime/service.mjs` lines 298-325).
- Hardening plan calls out host TTL/user-visible close host, stale socket cleanup, and worktree cleanup with live hosts (`docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 531-538).

**Direction:** Add UI actions/status for `interrupt`, `close host`, and `archive`; show host count/age; run pruning/reconciliation on dashboard open/poll; clean stale sockets; include host cleanup in row deletion and worktree safety.

### 5. P1 - Add `/bg` / current-session backgrounding and dispatch+attach parity

**Impact:** High product parity. The current board is strong for new tasks, but users still cannot fluidly background the session they are already in.

**Evidence:**
- PRD locked product decision says implementation should remain extensible for future `/bg` (`PRD.md` lines 17-23).
- PRD stretch and phase plan call out `/bg [prompt]` / current session backgrounding (`PRD.md` lines 100-103, 417-424, 461-462).
- Only `/agent-board` is registered today (`src/commands/agent-board.ts` lines 29-57; `src/index.ts` lines 27-40).
- Dashboard launch flow creates new managed views only (`src/runtime/service.mjs` lines 375-411).

**Direction:** Design `/bg` as either “convert current session into managed row” or “fork/copy transcript into managed row,” then add session ownership metadata and conflict handling. This would reduce context switching and make Agent Board feel native rather than a separate launcher.

### 6. P1 - Improve attention-first scaling: grouping, filtering, and row hierarchy

**Impact:** High once users manage more than a few sessions. Needs-input and unread work should dominate scanning; project/group context matters for global cross-project boards.

**Evidence:**
- Product goal includes seeing all active/background work and knowing which needs input (`PRD.md` lines 25-46).
- PRD stretch calls out grouping by directory/project and ready-for-review style grouping (`PRD.md` lines 128-140).
- Current `GROUP_ORDER` is `queued`, `working`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, despite comment “most-actionable first” (`src/core/types.mjs` lines 25-45).
- Filtering only supports `s:<state>` and free text over name/summary/cwd (`src/core/rows.mjs` lines 147-190; `test/rows.test.mjs` lines 65-94).
- Header/footer do show unread counts, but row grouping remains state-only (`src/ui/dashboard.ts` lines 1015-1028, 1125-1148).

**Direction:** Put `needs_input`/unread first or offer an attention view, add group-by-project/repo, expose model/worktree/host badges more clearly, add filters like `repo:`, `unread`, `hosted`, `model:`, and `worktree:`.

### 7. P1 - Close dashboard/attach UI test gaps

**Impact:** High engineering leverage. `dashboard.ts` is the primary product surface and a large state machine; regressions in modes/key handling can break core flows.

**Evidence:**
- Dashboard owns list/select/dispatch/filter/peek/reply/rename/confirm/help/session/launch modes (`src/ui/dashboard.ts` lines 62-127, 266-305).
- It directly implements key handling and management actions (`src/ui/dashboard.ts` lines 316-530, 734-999).
- Existing tests cover service/core/runner/PTY support, but no direct `DashboardComponent` mode/action tests were found under `test/`; available UI-adjacent tests are mostly row rendering logic and PTY attach render primitives (`test/rows.test.mjs` lines 1-113; `test/pty-runner.integration.test.mjs` lines 31-80; `test/pty-support.test.mjs` lines 1-75).
- PTY plan called for attach component tests for socket parser, terminal projection, detach chord, resize (`docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 463-470); only some pure render helpers are covered.

**Direction:** Add a fake TUI harness to drive `DashboardComponent.handleInput()` and assert dispatch/reply/confirm/filter/select/attach results; add PTY attach socket parser/detach/resize projection tests.

### 8. P2 - Update docs to reflect PTY-first architecture and reduce support drift

**Impact:** Medium-high for users and future agents. README’s “How it works” still describes each dispatch as launching `job-runner.mjs`, but current code prefers `pty-runner.mjs` when available.

**Evidence:**
- README architecture says each dispatch launches detached `runner/job-runner.mjs` and a headless JSON worker (`README.md` lines 64-82).
- Current service dispatch chooses `launchHost(meta, prompt)` when PTY is available and only uses `launchForView()` fallback otherwise (`src/runtime/service.mjs` lines 402-410).
- PTY implementation plan’s target model is now substantially present in code (`docs/PTY_ATTACH_IMPLEMENTATION_PLAN.md` lines 26-39, 490-552; `runner/pty-runner.mjs` lines 1-301).
- `runner/title-runner.mjs` comment says GPT-4o title generation, while `src/core/title.mjs` default is `openai-codex/gpt-5.5` (`runner/title-runner.mjs` lines 3-7; `src/core/title.mjs` lines 3-7).

**Direction:** Rewrite README “How it works” as PTY-first with JSON fallback, document host lifecycle/privacy, and fix stale title model wording.

## Start Here

Start with `src/runtime/service.mjs`. It is the best single source of actual product behavior: dispatch/reply/stop, PTY-vs-JSON fallback, worktree mismatch, cleanup, recovery, read tracking, and PTY health all converge there. Then open `src/commands/agent-board.ts` for attach/control flow and `src/ui/dashboard.ts` for user-visible interactions.

## Supervisor coordination

No supervisor decision was needed; this was repository research only.
