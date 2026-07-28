# Implementation Plan

## Goal
Add two product bets to Pi Agent Board—review evidence/diagnostics control plane and steering-first UX (`/bg`, start-and-attach, plan/approval states, queued follow-ups)—while explicitly leaving worktree-first/safe parallel coding out of scope.

## Scope / Non-Goals
- Do **not** add automatic worktrees, same-repo writer blocking, or safe-parallel-coding policy changes.
- Keep existing worktree-disabled behavior and related tests intact unless docs wording needs to say this scope is intentionally excluded.
- Do not replace the PTY-first execution model; extend it with diagnostics, evidence, steering, and queue semantics.
- Do not require exact enforcement of “no edits before approval” until Pi tool allowlist behavior is validated; plan mode can start as a prompt/UX contract with a clearly labeled risk.

## Tasks

### Phase 0 — Scope lock and data-model foundation

1. **Lock product scope and terminology**: Document the two bets and the explicit safe-parallelism exclusion so implementers do not revive worktree-first work in this slice.
   - Files: `README.md`, `PRD.md`, `VERIFY.md`
   - Changes: Add a short “current focus” section: review evidence/diagnostics and steering-first UX are in scope; worktree-first/same-repo safety is intentionally out of scope for this plan.
   - Acceptance: Docs mention `/bg`, queued follow-ups, evidence/diagnostics, and explicitly state no worktree policy behavior changes are included.

2. **Define new durable types and store paths**: Add schemas for diagnostics, review evidence, steering state, and queued follow-ups.
   - Files: `src/core/types.mjs`, `src/core/paths.mjs`, `src/core/store.mjs`
   - Changes:
     - Add typedefs for `DiagnosticEvent`, `EvidenceSnapshot`, `EvidenceCommand`, `EvidenceFileChange`, `FollowUpItem`, `FollowUpQueue`, and `SteeringState`.
     - Add optional row summaries to `ViewState`: `review`, `diagnostics`, `followUps`, `steering`.
     - Add optional run fields to `RunStatus`: `eventCount`, `lastEventAt`, `usage`, `stallReason`, `evidenceSummary`.
     - Add paths for `views/<id>/diagnostics.jsonl`, `views/<id>/evidence.json`, `views/<id>/queue.json`, `views/<id>/steering.json`, and optional `runs/<runId>/evidence.json`.
     - Extend `Row` loading to include compact evidence/queue/steering summaries without breaking existing rows.
   - Acceptance: Existing rows with only `meta.json`/`state.json` still load; new path helpers are unit-tested; no worktree paths or policies change.

3. **Add normalized store helpers for new artifacts**: Implement atomic read/write/append helpers for diagnostics, evidence snapshots, steering state, and follow-up queues.
   - Files: `src/core/store.mjs`, `src/core/atomic.mjs`
   - New Files: `src/core/diagnostics.mjs`, `src/core/evidence.mjs`, `src/core/follow-up-queue.mjs`, `src/core/steering.mjs`, `src/core/locks.mjs`
   - Changes:
     - `appendDiagnostic(root, viewId, event)` with bounded tail readers.
     - `readEvidence` / `writeEvidence` and per-run evidence helpers.
     - `readFollowUpQueue` / `enqueueFollowUp` / `claimNextFollowUp` / `completeFollowUp` with a simple per-view file lock to avoid lost queue updates.
     - `readSteering` / `writeSteering` and helpers to update `ViewState` summary fields.
   - Acceptance: Unit tests can append diagnostics, read the latest N events, enqueue/dequeue follow-ups, and round-trip steering/evidence data from a temp store.

### Phase 1 — Review evidence and diagnostics control plane

4. **Collect structured review evidence from JSON events**: Extract changed files, commands, test/build/lint runs, tool errors, assistant final claims, usage, and run outcome from the existing event stream.
   - Files: `src/core/events.mjs`, `src/core/evidence.mjs`, `src/core/heuristics.mjs`
   - Changes:
     - Keep `reduceEvent(status, event, now)` compatible, but add a parallel evidence reducer such as `reduceEvidence(snapshot, event, now)`.
     - Classify tool starts/ends: `edit`/`write` as file changes, `bash` commands into test/build/lint/git/other, tool errors into evidence errors.
     - Capture assistant text that looks like final review evidence (tests pass, files changed, not done due to blocker) without depending on model summaries.
   - Acceptance: `test/evidence.test.mjs` verifies evidence extraction from fake `tool_execution_*` and `message_end` events.

5. **Persist diagnostics and evidence from the detached JSON runner**: Make `runner/job-runner.mjs` write a supportable audit trail for every run.
   - Files: `runner/job-runner.mjs`, `src/core/events.mjs`, `src/core/evidence.mjs`, `src/core/diagnostics.mjs`
   - Changes:
     - Append diagnostics for runner start, worker spawn args (redacted), pid, first event, event counts, stderr, stall detection, final exit, summary-model attempt/result, and queue-drain decisions.
     - Write/update `runs/<runId>/evidence.json` and aggregate `views/<id>/evidence.json` as events arrive and on finalization.
     - Add configurable stall detection, e.g. `AGENT_BOARD_STALL_MS`, that marks `ViewState.diagnostics.stalled` and emits “waiting for provider response” when no assistant/tool event appears after start.
   - Acceptance: `test/runner.integration.test.mjs` has modes for successful evidence, failed tool/error evidence, and provider-stall diagnostics.

6. **Persist diagnostics/evidence for PTY-hosted sessions**: Cover the default PTY path, not just JSON fallback.
   - Files: `src/runtime/service.mjs`, `runner/pty-runner.mjs`, `src/index.ts`
   - Changes:
     - In `syncHostedEvent` / `syncForegroundEvent`, update the same evidence and steering snapshots from hosted Pi extension events.
     - In `pty-runner.mjs`, append host diagnostics for host start, socket listen, client attach/detach, input/resize/interrupt/terminate, child exit, and host errors.
   - Acceptance: `test/pty-runner.integration.test.mjs` verifies host diagnostics; service tests verify hosted event sync updates evidence.

7. **Expose evidence and diagnostics through service APIs**: Add imperative read/actions for the dashboard.
   - Files: `src/runtime/service.mjs`
   - Changes:
     - Add `evidence(viewId)`, `diagnostics(viewId, opts)`, `clearDiagnostics(viewId)`, and `retryLastRun(viewId)` or document retry as deferred if prompt recovery is not safe.
     - Update `reconcile()` to append diagnostics when it marks rows failed/stale.
     - Include diagnostic counts/stalled rows in `ptyHealth()` or a new `boardHealth()` method.
   - Acceptance: Service tests can read evidence/diagnostic tails and confirm reconcile emits a diagnostic event.

8. **Add dashboard review/evidence mode**: Give users a control-plane view per selected row.
   - Files: `src/ui/dashboard.ts`, `src/core/rows.mjs`, `src/core/types.mjs`
   - Changes:
     - Add a new mode such as `review` opened with `e` from list/peek/session.
     - Render sections: outcome, plan/approval state, changed files, commands/tests, errors/blockers, latest assistant evidence, log paths, and diagnostics tail.
     - Add row badges/summary hints for `review.ready`, `diagnostics.stalled`, and evidence errors.
     - Add filters such as `review:ready`, `diag:stalled`, and `queued:true` only if they are cheap to implement without disrupting existing `s:<state>` behavior.
   - Acceptance: Dashboard render tests or snapshot-style harness verifies `e` opens the evidence panel and old keys (`space`, `v`, `→`, `r`) still behave.

### Phase 2 — Queued follow-ups and steering state

9. **Implement follow-up queue semantics in the service**: Replace “busy means reply failed” with “busy replies can be queued”.
   - Files: `src/runtime/service.mjs`, `src/core/follow-up-queue.mjs`, `src/core/store.mjs`
   - Changes:
     - Add `queueFollowUp(viewId, text, opts)` and `reply(viewId, text, { delivery })` where delivery is `auto`, `now`, or `queue`.
     - For busy JSON-runner rows, enqueue instead of returning “run already active”.
     - For busy PTY-hosted rows, enqueue by default rather than injecting text into an active turn.
     - For idle rows, preserve existing immediate reply behavior.
     - Update `ViewState.followUps.queuedCount`, `lastQueuedAt`, and `lastQueuedPreview`.
   - Acceptance: Service tests cover idle send, busy queue, empty prompt rejection, and durable queue counts.

10. **Drain queued follow-ups after runs complete**: Ensure queued work advances without requiring manual re-entry where feasible.
   - Files: `runner/job-runner.mjs`, `src/runtime/service.mjs`, `src/index.ts`
   - Changes:
     - JSON runner: after finalizing a run, atomically claim the next queued follow-up and spawn another `job-runner.mjs` against the same session file.
     - PTY-hosted path: when hosted child emits `agent_end`, call a service drain helper that sends the next queued item to the host socket; also attempt drain from dashboard poll/reconcile as a fallback.
     - Append diagnostics for claim/send/failure decisions.
   - Acceptance: Integration tests with fake Pi queue two follow-ups and assert they run in order; hosted service tests verify `agent_end` drains one queued item.

11. **Add durable steering/plan state transitions**: Represent plan request, awaiting approval, approval, and change-request states independently from process liveness.
   - Files: `src/core/steering.mjs`, `src/core/types.mjs`, `src/runtime/service.mjs`, `src/core/events.mjs`
   - Changes:
     - Steering states: `none`, `plan_requested`, `awaiting_approval`, `approved`, `changes_requested`, `executing_approved_plan`.
     - `requestPlan(viewId, text?)` queues or starts a plan-mode prompt.
     - If a plan-mode run exits cleanly, store latest assistant output as `planText`, set `awaiting_approval`, and project row semantic state to `needs_input` with question “Approve this plan?”.
     - `approvePlan(viewId)` queues an execution prompt and moves state to `approved` / `executing_approved_plan`.
     - `requestPlanChanges(viewId, feedback)` queues feedback and moves state to `changes_requested`.
   - Acceptance: Unit tests verify state transitions and `needs_input` projection for awaiting approval.

12. **Define prompt wrappers for steering actions**: Centralize prompt text so plan/approval behavior is consistent.
   - New Files: `src/core/steering-prompts.mjs`
   - Files: `src/runtime/service.mjs`, `runner/job-runner.mjs`, `runner/pty-runner.mjs`
   - Changes:
     - Add prompt builders for plan request, approve/execute, and change request.
     - For plan-mode runs, attempt to use `RunConfig.tools` with a read-only allowlist only after validating Pi tool names; otherwise label the mode as advisory in diagnostics.
     - Include “produce review evidence” instructions in execution prompts so evidence UI has better assistant claims.
   - Acceptance: Prompt builder tests assert stable prompts; diagnostics clearly state whether plan mode is advisory or tool-restricted.

### Phase 3 — Steering-first user experience

13. **Add `/bg` command for current-session backgrounding**: Let users turn the current Pi session into a managed Agent Board row and optionally send a background follow-up.
   - New Files: `src/commands/bg.ts`
   - Files: `src/index.ts`, `src/runtime/service.mjs`, `src/core/store.mjs`, `src/commands/agent-board.ts`
   - Changes:
     - Register `pi.registerCommand("bg", ...)`.
     - Add service method `adoptSession({ sessionFile, cwd, model, thinkingLevel, name, prompt })` that reuses an existing row for the session file or creates a row with `sessionFile` pointing at the current Pi session file.
     - `/bg` with no prompt: adopt current session, mark it idle/backgrounded, open the board with that row selected.
     - `/bg <prompt>`: adopt current session and queue/start the prompt as a follow-up, then open the board.
     - If no current session file is available, fail with a clear diagnostic and notification.
   - Acceptance: Command tests with a fake command context verify adopt-current-session, reuse-existing-row, and prompt queue behavior.

14. **Refactor attach flow for reuse by `/bg` and start-and-attach**: Avoid duplicating attach logic.
   - New Files: `src/commands/attach-flow.ts`
   - Files: `src/commands/agent-board.ts`, `src/commands/bg.ts`
   - Changes: Move `attach`, `openPtyAttach`, `showSwitchingOverlay`, `installBackToDashboard`, and helpers into reusable exports with minimal context types where possible.
   - Acceptance: Existing `/agent-board --attach` behavior remains unchanged; tests or typecheck confirm both commands compile against the shared attach helper.

15. **Add start-and-attach to the launch dialog**: Make starting work and immediately attaching a first-class action.
   - Files: `src/ui/dashboard.ts`, `src/commands/agent-board.ts`, `src/runtime/service.mjs`
   - Changes:
     - Add launch action choice: `Start in background` and `Start & attach`.
     - On `Start & attach`, call `service.dispatch()` and then close the dashboard with `{ action: "attach", viewId, stopFirst: false }` when PTY host mode is available.
     - If dispatch falls back to JSON runner, keep the row on the board and show a warning that live start-and-attach needs PTY; do not interrupt the new run.
     - Optionally persist last launch action in launch prefs without changing existing defaults.
   - Acceptance: Dashboard harness verifies start-and-attach dispatches then requests attach; JSON fallback shows a warning and does not call attach.

16. **Expose plan/approval actions in the dashboard**: Make steering visible and keyboard-driven.
   - Files: `src/ui/dashboard.ts`, `src/core/rows.mjs`, `src/runtime/service.mjs`
   - Changes:
     - Add keys in list/peek/review: `P` request plan, `A` approve plan, `C` request changes, `q`/reply while busy queues follow-up.
     - Render plan state badges in rows and evidence panel.
     - In peek/review, show the current plan text and approval prompt.
     - Protect approval actions when there is no `awaiting_approval` plan with clear notices.
   - Acceptance: UI tests verify invalid approval is rejected, plan request updates state, and approve queues execution.

17. **Make queued follow-ups visible and manageable**: Users should see what will happen next.
   - Files: `src/ui/dashboard.ts`, `src/core/rows.mjs`, `src/runtime/service.mjs`
   - Changes:
     - Show queued count/preview in row summary or badge.
     - Add a queue section in peek/review mode.
     - Add actions to remove the last queued item or clear the queue with confirmation.
   - Acceptance: Service and dashboard tests verify queued count updates, clear queue confirmation works, and queue state survives refresh/reload.

### Phase 4 — Migration, tests, and documentation

18. **Add migration/backcompat normalization**: Ensure old stores load and new fields have defaults.
   - Files: `src/core/store.mjs`, `src/core/types.mjs`, `test/store.test.mjs`
   - Changes:
     - Add normalizers for v1 `ViewState`, `RunStatus`, and missing artifact files.
     - Keep archived rows and preserved session files behavior unchanged.
     - Ensure legacy `AGENT_VIEW_*` env aliases still work where currently supported.
   - Acceptance: Tests create old-style rows without evidence/queue/steering files and verify listing, attach, reply, archive, and mark-done still work.

19. **Expand runner and service tests for the new control planes**: Cover real failure modes with fake Pi.
   - Files: `test/runner.integration.test.mjs`, `test/service.test.mjs`, `test/events.test.mjs`, `test/rows.test.mjs`, `test-support/fake-pi.mjs`
   - New Files: `test/evidence.test.mjs`, `test/diagnostics.test.mjs`, `test/follow-up-queue.test.mjs`, `test/steering.test.mjs`, `test/bg-command.test.mjs`
   - Changes: Add fake modes for `evidence_success`, `tool_error`, `plan_ready`, `provider_stall`, and multi-run queued follow-ups.
   - Acceptance: `npm test` passes with evidence, diagnostics, queue, and steering coverage.

20. **Add a dashboard state-machine harness**: Reduce regression risk in the largest UI file.
   - New Files: `test/dashboard-harness.mjs`, `test/dashboard-steering.test.mjs`, `test/dashboard-evidence.test.mjs`
   - Files: `src/ui/dashboard.ts` only if small testability seams are needed.
   - Changes: Create fake TUI/theme/keybindings/service objects and drive `DashboardComponent.handleInput()` for evidence mode, start-and-attach, queued reply, and approval flows.
   - Acceptance: Tests assert resulting service calls and `DashboardResult` without requiring a real terminal.

21. **Update docs and manual verification**: Make the new workflows testable by humans.
   - Files: `README.md`, `VERIFY.md`, `PRD.md`, `PROGRESS.md`
   - Changes:
     - Document `/bg` syntax and limitations.
     - Document `e` evidence/diagnostics panel, plan/approve/change keys, queued follow-up behavior, and start-and-attach fallback when PTY is unavailable.
     - Add store artifact examples for evidence, queue, steering, and diagnostics.
   - Acceptance: Manual verification includes at least one flow for evidence, stalled diagnostics, `/bg`, start-and-attach, plan approval, and queued follow-ups.

22. **Run final validation and packaging checks**: Keep current quality gates green.
   - Files: no source-specific file; validation task.
   - Changes: Run `npm run typecheck`, `npm test`, and `npm run pack:dry`.
   - Acceptance: All checks pass; package includes new source/test docs only as intended.

## Files to Modify
- `src/core/types.mjs` - add diagnostic, evidence, follow-up queue, steering typedefs and optional state/run fields.
- `src/core/paths.mjs` - add artifact paths for diagnostics, evidence, queue, steering, and per-run evidence.
- `src/core/store.mjs` - add normalized artifact read/write helpers and load row summaries.
- `src/core/atomic.mjs` - add bounded tail/read helpers if not placed in diagnostics module.
- `src/core/events.mjs` - preserve current reducer while adding evidence/usage/stall-compatible updates.
- `src/core/heuristics.mjs` - add command/test/build classification helpers for evidence.
- `src/core/rows.mjs` - render/filter row badges for review ready, stalled diagnostics, queued follow-ups, and approval state.
- `src/runtime/service.mjs` - add evidence/diagnostics APIs, session adoption, queued replies, queue draining, steering actions, and hosted event evidence sync.
- `src/ui/dashboard.ts` - add evidence/review mode, launch start-and-attach action, queue UI, `/bg`-compatible selected row behavior, and plan/approval controls.
- `src/commands/agent-board.ts` - refactor attach flow, handle start-and-attach result, and expose shared helpers.
- `src/index.ts` - register `/bg`, include new status counts, and drain hosted queues on lifecycle events where safe.
- `runner/job-runner.mjs` - persist diagnostics/evidence, detect stalls, and chain queued follow-ups.
- `runner/pty-runner.mjs` - persist host/socket diagnostics and support queue-drain visibility.
- `test-support/fake-pi.mjs` - add fake modes for evidence, plans, stalls, and queue chains.
- `test/*.test.mjs` - update/add coverage for new data models, service behavior, runner integration, rows, and dashboard state machine.
- `README.md`, `PRD.md`, `VERIFY.md`, `PROGRESS.md` - document new scope and workflows.

## New Files
- `src/core/diagnostics.mjs` - diagnostic event append/read/tail and redaction helpers.
- `src/core/evidence.mjs` - evidence snapshot model and event/tool classification reducers.
- `src/core/follow-up-queue.mjs` - durable queue operations with per-view locking.
- `src/core/steering.mjs` - steering state transitions and projection helpers.
- `src/core/steering-prompts.mjs` - prompt builders for plan, approve, and change-request flows.
- `src/core/locks.mjs` - minimal file lock/lease helpers for queue mutation and runner queue claims.
- `src/commands/bg.ts` - `/bg` command implementation.
- `src/commands/attach-flow.ts` - shared attach/open-PTY/switch-session helpers.
- `test/evidence.test.mjs` - pure evidence reducer tests.
- `test/diagnostics.test.mjs` - diagnostic append/tail/redaction tests.
- `test/follow-up-queue.test.mjs` - queue mutation and locking tests.
- `test/steering.test.mjs` - steering state and prompt tests.
- `test/bg-command.test.mjs` - `/bg` command handler tests with fake context.
- `test/dashboard-harness.mjs` - reusable fake TUI/service harness.
- `test/dashboard-steering.test.mjs` - dashboard plan/approval/queue UX tests.
- `test/dashboard-evidence.test.mjs` - dashboard evidence/diagnostics mode tests.

## Dependencies
- Phase 0 tasks must land before UI, service, and runner work because all later work depends on the new artifact schemas and paths.
- Evidence reducers (Task 4) should land before runner/service persistence (Tasks 5-7).
- Queue data model and locking (Tasks 2-3, 9) must land before queue draining in JSON/PTTY paths (Task 10).
- Steering state and prompt builders (Tasks 11-12) must land before dashboard plan/approval controls (Task 16).
- Shared attach refactor (Task 14) should precede `/bg` attach behaviors and start-and-attach handling (Tasks 13 and 15).
- Migration tests (Task 18) should run before docs/verification are finalized.

## Migration / Backcompat
- Treat all new files as optional; missing `evidence.json`, `diagnostics.jsonl`, `queue.json`, and `steering.json` mean default empty states.
- Existing `ViewState.version: 1` and `RunStatus.version: 1` rows must load through normalizers; new writers may use a bumped version only if all readers tolerate v1.
- Existing session files remain in place; archived rows still preserve session files and logs unless a separate explicit cleanup command is added later.
- Existing keybindings remain valid; new keys must not change `space` peek, `v` transcript, `→` attach, `r` reply, `d` done, or `/` filter semantics.
- Existing PTY fallback behavior remains: start-and-attach requires a PTY host; JSON-runner fallback remains background-only unless the run is stopped or finishes.
- Existing worktree-disabled behavior remains unchanged in this scope.

## Risks
- `/bg` semantics are underspecified: adopting the current session is the lowest-change V1, but product should explicitly reject or approve alternatives like forking/copying the transcript.
- `ctx.sessionManager.getSessionFile()` may be unavailable for some sessions; `/bg` needs clear failure messaging.
- Plan mode cannot be guaranteed read-only unless Pi tool allowlist names are validated; until then it is an advisory approval workflow.
- PTY-hosted queue draining depends on hosted child extension lifecycle events; add dashboard/reconcile drain fallback and diagnostics for missed drains.
- Evidence extraction from terminal/assistant output is heuristic; it should be presented as “evidence collected” rather than a guaranteed review verdict.
- Diagnostics and evidence can contain sensitive prompts, paths, command output, and errors; consider retention/redaction defaults before broad release.
- Chaining queued JSON runs from inside `job-runner.mjs` increases runner responsibility; locking and diagnostics are required to avoid double-draining.
- Start-and-attach from the `pi /agent-board` startup path may be limited because startup event contexts are not command contexts; PTY attach may work, `switchSession` fallback may not.

## Acceptance Criteria
- Evidence/diagnostics: pressing `e` on a row shows persisted changed files, commands/tests, errors, final assistant evidence, run/host metadata, and diagnostics tail after reload.
- Diagnostics: provider stalls, runner exits, stale reconciliation, PTY host errors, and queue-drain failures are visible in row badges or the evidence panel.
- `/bg`: from a normal Pi session, `/bg` adopts the current session into Agent Board; `/bg <prompt>` queues or starts a background follow-up against that same session.
- Start-and-attach: dashboard launch can start a PTY-hosted session and immediately attach; JSON fallback warns and leaves the session running in the board.
- Queued follow-ups: replies to busy sessions are queued, visible, durable, and drained in order after the active turn completes.
- Plan/approval: a plan request moves the row to awaiting approval, approval queues execution, change request queues feedback, and all states are visible in row/peek/evidence views.
- Backcompat: old stores without new artifact files load cleanly; existing dispatch, reply, attach, transcript, done, archive, and PTY health flows still pass tests.
- Quality: `npm run typecheck`, `npm test`, and `npm run pack:dry` pass.
