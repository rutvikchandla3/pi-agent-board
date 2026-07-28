# Implementation Plan

## Goal
Implement Phase 2/3 steering-first workflows: durable queued follow-ups, plan/approval steering actions, `/bg`, reusable attach flow, and start-and-attach, without changing worktree or same-repo safety behavior.

## Non-Goals
- Do **not** modify worktree isolation, same-repo writer policy, or `src/core/worktree.mjs` behavior.
- Do **not** add automatic worktrees or same-repo launch blocking.
- Do **not** depend on Phase 1 evidence/diagnostics modules; queue/steering should work independently.

## Tasks
1. **Add queue and steering schema/path foundations**: Extend persisted state without breaking old stores.
   - File: `src/core/types.mjs`
   - Changes: Add JSDoc typedefs/constants for `FollowUpKind` (`reply`, `plan_request`, `plan_approval`, `plan_change`), `FollowUpStatus`, `FollowUpItem`, `FollowUpQueue`, `FollowUpSummary`, `SteeringModeState` (`none`, `plan_requested`, `awaiting_approval`, `approved`, `changes_requested`, `executing_approved_plan`), `SteeringState`, and `SteeringSummary`. Extend `RunKind` to include `plan`, `plan_change`, and `plan_approval`. Add optional `ViewState.followUps` and `ViewState.steering` summaries.
   - File: `src/core/paths.mjs`
   - Changes: Add `queuePath(root, viewId)`, `steeringPath(root, viewId)`, and `viewLockPath(root, viewId, name)` helpers.
   - File: `src/core/ids.mjs`
   - Changes: Add `newFollowUpId()` returning `follow_<hex>`.
   - File: `src/core/store.mjs`
   - Changes: Normalize `readState()` results with default `followUps` and `steering` summaries; preserve missing legacy fields. Add optional `sessionFile` support to `createView(root, opts)` for `/bg` adoption while keeping the default `sessions/<viewId>.jsonl` path for normal dispatch.
   - Acceptance: Existing store tests still pass; new tests prove old `state.json` files without `followUps`/`steering` load with safe defaults. No worktree-related tests or behavior change.

2. **Implement durable follow-up queue operations**: Provide atomic queue mutation with a per-view lock.
   - New File: `src/core/locks.mjs`
   - Changes: Implement `withFileLock(lockPath, fn, opts?)` using atomic `mkdirSync` lock directories plus stale-lock cleanup; keep it dependency-free and testable.
   - New File: `src/core/follow-up-queue.mjs`
   - Changes: Implement `readFollowUpQueue`, `writeFollowUpQueue`, `enqueueFollowUp`, `claimNextFollowUp`, `completeFollowUp`, `releaseFollowUp`, `removeLastFollowUp`, `clearFollowUps`, `summarizeFollowUps`, and `syncFollowUpSummary(root, viewId)`. Queue items should store `id`, `viewId`, `kind`, `text`, `createdAt`, `status`, `attempts`, `claimedAt`, `completedAt`, and `lastError`.
   - File: `src/core/store.mjs`
   - Changes: Ensure queue summary updates can be written into `state.followUps` without requiring row recreation.
   - Acceptance: `test/follow-up-queue.test.mjs` covers enqueue, claim, complete, release, remove-last, clear, lock protection, and state summary updates.

3. **Implement steering state and prompt builders**: Centralize plan/approval transitions and prompt text.
   - New File: `src/core/steering.mjs`
   - Changes: Implement `readSteering`, `writeSteering`, `defaultSteering`, `setSteeringState`, `requestPlanState`, `finishPlanRun`, `approvePlanState`, `requestPlanChangesState`, `finishApprovedExecution`, and `syncSteeringSummary(root, viewId)`. `finishPlanRun` must set `awaiting_approval`, persist `planText`, and project the row to `needs_input` with question `Approve this plan?`.
   - New File: `src/core/steering-prompts.mjs`
   - Changes: Implement `buildPlanRequestPrompt`, `buildApprovePlanPrompt`, and `buildPlanChangesPrompt`. Prompts should clearly say plan mode is advisory/read-only unless a future Pi tool allowlist is validated.
   - File: `src/core/events.mjs`
   - Changes: Make `projectViewState(status, now, previousState)` preserve `previousState.followUps` and `previousState.steering` so runner/service projections do not erase queue or steering summaries.
   - Acceptance: `test/steering.test.mjs` covers state transitions, prompt output, and `needs_input` projection for awaiting approval.

4. **Refactor service launch helpers for reusable run starts and adoption**: Add primitives used by reply, queue drain, steering, `/bg`, and start-and-attach.
   - File: `src/runtime/service.mjs`
   - Changes: Refactor internal `launchForView(meta, prompt, kind)` to accept extended `RunKind`. Add a small `startPromptForView(meta, prompt, kind)` helper that chooses PTY host vs JSON runner using current PTY availability. Update `launchHost(meta, initialPrompt, launchOpts)` to write an initial `host.json` with `state: "starting"`, `socketPath`, and `runnerPid` immediately after spawn so attach can open the PTY loading surface before the socket exists.
   - File: `src/runtime/service.mjs`
   - Changes: Add `adoptSession({ sessionFile, cwd, model, thinkingLevel, name })`. It should reuse an existing row for the same session path (including archived rows, unarchiving if needed), or create a new row with `createView(..., { sessionFile })`, `worktreeMode: "off"`, `worktreePath: null`, and an `idle`/`exited` backgrounded state.
   - Acceptance: Service tests cover normal dispatch unchanged, `adoptSession` new row, `adoptSession` reuse, archived-row unarchive, and immediate starting-host `attachTarget` metadata. Existing worktree rejection/allows-same-repo tests remain unchanged.

5. **Add queued reply semantics and drain behavior in the service**: Busy replies become durable follow-ups by default.
   - File: `src/runtime/service.mjs`
   - Changes: Change `reply(viewId, text)` to `reply(viewId, text, opts = {})` where `opts.delivery` is `auto`, `now`, or `queue` and `opts.kind` defaults to `reply`. Empty prompts still reject. `auto` should queue when `isAgentBusy(row)` is true; idle rows keep immediate behavior. Busy PTY-hosted rows must queue by default instead of injecting into an active turn. `now` may preserve current direct-host behavior for explicit callers.
   - File: `src/runtime/service.mjs`
   - Changes: Add public `queueFollowUp(viewId, text, opts?)`, `clearFollowUps(viewId)`, `removeLastFollowUp(viewId)`, and `drainNextFollowUp(viewId, opts?)`. `drainNextFollowUp` should claim one pending item, map its `kind` to a run kind/prompt, send it to a live idle PTY host or start a new PTY/JSON run, then complete or release the item.
   - File: `src/runtime/service.mjs`
   - Changes: Call `drainNextFollowUp` from `reconcile()` for idle rows with pending queue items as a fallback.
   - Acceptance: Service tests cover idle immediate reply, busy JSON queue, busy PTY queue, forced `delivery: "now"`, queue summary durability, clear/remove-last, and fallback drain from reconcile.

6. **Add steering service actions**: Expose plan request, approval, and change-request actions.
   - File: `src/runtime/service.mjs`
   - Changes: Add public `steering(viewId)`, `requestPlan(viewId, text?)`, `approvePlan(viewId)`, and `requestPlanChanges(viewId, feedback)`. `requestPlan` should set `plan_requested` and queue/start a `plan` run. `approvePlan` should require `awaiting_approval`, set `approved`, then queue/start a `plan_approval` run and move to `executing_approved_plan` when actually launched. `requestPlanChanges` should require non-empty feedback, set `changes_requested`, and queue/start a revised `plan_change` run.
   - File: `src/runtime/service.mjs`
   - Changes: In hosted `syncRowEvent`, after `agent_end`, if steering is `plan_requested` or `changes_requested`, call `finishPlanRun` with the latest assistant preview; if steering is `executing_approved_plan`, call `finishApprovedExecution`. Then attempt one queued-follow-up drain.
   - Acceptance: Service tests cover invalid approval rejection, plan request while idle starts a plan run, plan request while busy queues, plan completion projects `needs_input`, approval queues/starts execution, and change request returns to awaiting approval after completion.

7. **Drain queued follow-ups and finalize plan runs from JSON runner**: Make queued JSON work advance without dashboard involvement.
   - File: `runner/job-runner.mjs`
   - Changes: Import queue, steering, `newRunId`, and `launchRun`. After a terminal status is persisted and model summary finishes, handle steering finalization for `config.kind === "plan"` or `"plan_change"`, and `finishApprovedExecution` for `config.kind === "plan_approval"`.
   - File: `runner/job-runner.mjs`
   - Changes: Add `drainQueuedFollowUp(config, status)` that only drains after clean, non-stopped completion. It should claim one pending queue item, create a new run config against the same session/cwd/model/thinking/tools, launch another detached `job-runner.mjs` via `launchRun`, complete the queue item on successful launch, and release it on launch failure.
   - File: `runner/job-runner.mjs`
   - Changes: Do not drain after failed or stopped runs; leave queue items visible for user action.
   - Acceptance: Runner integration tests with fake Pi queue multiple follow-ups and observe run order; plan-mode fake run writes `steering.json` and projects the row to awaiting approval.

8. **Refactor attach flow for reuse and support starting PTY hosts**: Move attach code out of `/agent-board` while preserving behavior.
   - New File: `src/commands/attach-flow.ts`
   - Changes: Move `AttachOutcome`, `dashboardAttachLoop`, `attach`, `openPtyAttach`, `showSwitchingOverlay`, `installBackToDashboard`, `currentViewId`, and `samePath` here. Accept an `openDashboard` callback to avoid circular imports with `agent-board.ts`.
   - New File: `src/commands/attach-flow-core.mjs`
   - Changes: Add pure helpers such as `currentViewIdForSession(rows, sessionFile)` and `classifyAttachTarget(row, target, stopFirst)` so start-and-attach edge cases can be unit-tested without importing TS/TUI code.
   - File: `src/commands/agent-board.ts`
   - Changes: Keep `openDashboard` in this file, import `attach` and `dashboardAttachLoop` from `attach-flow.ts`, and pass `openDashboard` into the attach loop. Remove the moved private attach helpers.
   - File: `src/runtime/service.mjs`
   - Changes: Update `attachTarget(viewId)` to return `kind: "pty"` when `host.json` is `starting` or `alive` and has a socket path. In `attach`, classify PTY targets before blocking on `row.alive && !row.hostAlive`, so start-and-attach can open the PTY loading surface immediately.
   - Acceptance: Existing `/agent-board --attach <id>` behavior is unchanged; `test/attach-flow-core.test.mjs` covers current session detection and starting-host PTY classification; typecheck covers the TS refactor.

9. **Add `/bg` command backed by session adoption**: Let the current Pi session become a managed board row.
   - New File: `src/commands/bg.ts`
   - Changes: Register `pi.registerCommand("bg", ...)`. The handler should require UI, read `ctx.sessionManager.getSessionFile()`, call `service.adoptSession`, optionally call `service.reply(viewId, args, { delivery: "auto" })`, then open the dashboard/attach loop with the adopted row selected.
   - New File: `src/commands/bg-core.mjs`
   - Changes: Add pure helpers for parsing `/bg` args, deriving a model ref from `ctx.model`, and building adoption inputs from a command context so tests do not need to import TS.
   - File: `src/index.ts`
   - Changes: Import and register `registerBgCommand(pi, opts)` with the same root/runner/PTY/title/pi invocation settings and `getThinkingLevel` used by `/agent-board`.
   - Acceptance: `test/bg-command.test.mjs` covers no session file error, adoption without prompt, adoption with prompt causing a reply/queue, and existing-row reuse via fake service/context helpers.

10. **Add start-and-attach launch action**: Dispatch a new PTY session and immediately attach when possible.
   - New File: `src/ui/dashboard-actions.mjs`
   - Changes: Add pure helper `launchResultAction(result, launchAction, prompt)` that returns either a notice/stay-on-board action or `DashboardResult { action: "attach", viewId, stopFirst: false }`. It must attach only when `launchAction === "attach"` and `result.hostMode === "pty"`; JSON fallback should warn and leave the row running on the board.
   - File: `src/ui/dashboard.ts`
   - Changes: Extend `LaunchState` with `action: "background" | "attach"`. Render two choices, `Start in background` and `Start & attach`, defaulting to background. Add left/right or enter behavior on the launch action field. On submit, use `launchResultAction`; if it returns attach, close the dashboard with that result.
   - File: `src/commands/agent-board.ts`
   - Changes: No special-case beyond existing attach loop; it should receive the attach result and call the refactored `attach`.
   - File: `src/index.ts`
   - Changes: In startup `pi /agent-board` path, if the dashboard returns attach, keep the existing command-context limitation but update the notification to explain that the row was started and live attach requires `/agent-board` from a normal session.
   - Acceptance: `test/dashboard-actions.test.mjs` covers background launch, PTY start-and-attach, JSON fallback warning/no attach, and dispatch error. Typecheck covers dashboard wiring.

11. **Expose queue and steering controls in dashboard UI**: Make queued work and plan approval visible and keyboard-driven.
   - File: `src/core/rows.mjs`
   - Changes: Extend `RowView` with `followUpCount`, `followUpPreview`, and `steeringState` from `row.state.followUps`/`row.state.steering`. Add filter support for `queued:true` and `steer:<state>` without changing existing `s:<state>` parsing.
   - File: `src/ui/dashboard.ts`
   - Changes: Add keys in list/peek/session modes: `P` request plan, `A` approve plan, `C` request changes, `q` alias for reply/queue. Add `planChanges` text mode for collecting change feedback. Add queue management keys in peek, e.g. `Z` remove last queued item and `Q` clear queue with confirmation.
   - File: `src/ui/dashboard.ts`
   - Changes: Render queue count/preview and steering badge in rows. In peek, render a `Queued follow-ups` section and a `Plan / steering` section using `service.steering(viewId)` for full plan text when available. Reject invalid approval/change actions with clear notices.
   - Acceptance: Row tests cover queue/steering badges and filters. Service tests cover action results. Manual/typecheck validation confirms old keys (`space`, `v`, `→`, `r`, `d`, `/`) still work.

12. **Update extension status and hosted event flow**: Surface queued work in lightweight chrome and trigger hosted drains.
   - File: `src/index.ts`
   - Changes: Register `/bg`. In `updateStatus`, include total queued follow-up count in the footer status when non-zero, without showing status from hosted children. Keep existing working/needs counts.
   - File: `src/index.ts`
   - Changes: No new event subscriptions are needed; existing `agent_end` subscription should call `service.syncHostedEvent`, and service handles hosted steering/queue drain.
   - Acceptance: Status update test or service-level assertion confirms queued count is derived from `state.followUps`; hosted child path remains suppressed by `isHostedChild`.

13. **Expand fake Pi support for queue and steering tests**: Make runner integration deterministic.
   - File: `test-support/fake-pi.mjs`
   - Changes: Add modes `plan_ready`, `plan_change_ready`, and `queued_success`. Add optional `FAKE_PI_PROMPT_LOG` support that appends each prompt so tests can assert follow-up order. Preserve existing modes.
   - File: `test-support/fake-pty-pi.mjs`
   - Changes: No required change unless hosted queue tests need a deterministic `agent_end`; prefer service-level hosted event tests over changing the PTY fake.
   - Acceptance: Existing runner tests still pass; new queue/plan integration tests can assert order and steering output without network/provider access.

14. **Add and update tests**: Cover core, service, runner, and command seams.
   - New File: `test/follow-up-queue.test.mjs`
   - Changes: Queue CRUD, lock behavior, summary sync.
   - New File: `test/steering.test.mjs`
   - Changes: Steering transitions, prompt builders, row projection.
   - New File: `test/attach-flow-core.test.mjs`
   - Changes: Pure attach classification, especially starting PTY host before socket exists.
   - New File: `test/bg-command.test.mjs`
   - Changes: Pure `/bg` command helper tests with fake context/service.
   - New File: `test/dashboard-actions.test.mjs`
   - Changes: Pure start-and-attach dispatch result handling.
   - File: `test/service.test.mjs`
   - Changes: Add adopt session, queue reply/drain, steering action, hosted `agent_end` drain, and no-worktree-regression assertions.
   - File: `test/runner.integration.test.mjs`
   - Changes: Add queued JSON run chaining and plan finalization tests.
   - File: `test/events.test.mjs`
   - Changes: Add projection-preserves-queue/steering summaries test.
   - File: `test/rows.test.mjs`
   - Changes: Add queue/steering row view and filters tests.
   - Acceptance: `npm run typecheck`, `npm test`, and `npm run pack:dry` pass.

## Files to Modify
- `src/core/types.mjs` - add queue/steering typedefs, extended run kinds, and optional `ViewState` summaries.
- `src/core/paths.mjs` - add queue, steering, and lock paths.
- `src/core/ids.mjs` - add follow-up ID generator.
- `src/core/store.mjs` - normalize legacy state defaults and support adopting an external session file in `createView`.
- `src/core/events.mjs` - preserve queue/steering summaries when projecting run status to row state.
- `src/core/rows.mjs` - expose queue/steering row badges and filters.
- `src/runtime/service.mjs` - add adoption, queued reply/drain, steering actions, starting-host status writes, and hosted drain/finalization.
- `runner/job-runner.mjs` - finalize plan runs and chain queued JSON follow-ups after clean completion.
- `src/commands/agent-board.ts` - use shared attach-flow exports and keep `openDashboard` as the dashboard factory.
- `src/ui/dashboard.ts` - add start-and-attach launch action, queue visibility/actions, and steering keyboard/UI flows.
- `src/index.ts` - register `/bg`, update startup attach warning, and include queued follow-ups in status counts.
- `test-support/fake-pi.mjs` - add prompt logging and plan/queue modes.
- `test/service.test.mjs` - add service coverage for adoption, queues, steering, hosted drain, and no worktree regressions.
- `test/runner.integration.test.mjs` - add queued follow-up chaining and plan finalization integration tests.
- `test/events.test.mjs` - verify projected state preserves queue/steering summaries.
- `test/rows.test.mjs` - verify row badges and filters for queued follow-ups and steering.

## New Files
- `src/core/locks.mjs` - dependency-free per-view lock helper for queue mutations.
- `src/core/follow-up-queue.mjs` - durable follow-up queue operations and state summary sync.
- `src/core/steering.mjs` - durable steering state transitions and row-state projection.
- `src/core/steering-prompts.mjs` - plan, approval, and change-request prompt builders.
- `src/commands/attach-flow.ts` - shared attach/dashboard-loop/PTTY attach implementation.
- `src/commands/attach-flow-core.mjs` - pure attach-decision helpers for tests.
- `src/commands/bg.ts` - `/bg` command registration and command handler wiring.
- `src/commands/bg-core.mjs` - pure `/bg` parsing/adoption helpers for tests.
- `src/ui/dashboard-actions.mjs` - pure dashboard action helpers for start-and-attach result handling.
- `test/follow-up-queue.test.mjs` - queue persistence and locking tests.
- `test/steering.test.mjs` - steering state and prompt tests.
- `test/attach-flow-core.test.mjs` - attach decision tests.
- `test/bg-command.test.mjs` - `/bg` helper tests.
- `test/dashboard-actions.test.mjs` - start-and-attach helper tests.

## Dependencies
- Task 1 must land before Tasks 2-7 and 11 because all queue/steering code depends on the new fields and paths.
- Task 2 must land before service queued reply/drain (Task 5) and runner queue chaining (Task 7).
- Task 3 must land before steering service actions (Task 6), runner plan finalization (Task 7), and dashboard steering controls (Task 11).
- Task 4 should land before start-and-attach (Task 10) because attach needs `host.json` in `starting` state.
- Task 8 should land before `/bg` (Task 9) and start-and-attach (Task 10) so both use the shared attach loop.
- Task 13 should land before the new runner integration tests in Task 14.

## Risks
- `/Users/rutvik/rcode/pi-agents-view/context.md` was not present during planning; this plan is based on `plan.md` and repo inspection.
- `/bg` V1 adopts the current session file; it does not fork/copy the transcript or truly terminate the invoking foreground session. Product should confirm this is acceptable.
- Plan mode is advisory/read-only by prompt only. Do not claim hard no-edit enforcement unless Pi tool allowlist names are validated later.
- Queue draining can double-send if locking is wrong; use `claimNextFollowUp` under lock and complete/release explicitly.
- Hosted PTY drain depends on child extension `agent_end` events; `reconcile()` fallback is required for missed drains.
- Start-and-attach works cleanly from `/agent-board` command context. The startup `pi /agent-board` event path still cannot call `ctx.switchSession`; keep a clear warning there.
- Runtime tests cannot import TS command/dashboard files directly under the current `node --test test/*.test.mjs` setup, so command/UI behavior should expose small `.mjs` pure helper seams plus rely on `npm run typecheck` for TS wiring.
- Do not modify `src/core/worktree.mjs`, same-repo dispatch rules, or existing worktree-related tests while implementing this slice.
