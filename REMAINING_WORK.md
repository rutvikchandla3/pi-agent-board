# Remaining Work — `plan.md` vs commit `99691e1`

Audit basis: `plan.md` (22 tasks, 5 phases) vs commit `99691e1` ("Improve agent board
auto-state grouping"). Validation gate is currently green: `npm run typecheck`,
`npm test` (121/121), `npm run pack:dry` all pass.

**Status:** 7 Full · 11 Partial · 4 Missing. The data-model foundation and most
service/core backends are done; the user-facing surfaces, integration/runner test
scaffolding, and a few reliability features are the gap.

> **Scope note before you start:** the commit's headline feature — automatic
> terminal-state classification (`src/core/auto-state.mjs`, `runner/state-runner.mjs`,
> `AGENT_BOARD_AUTO_STATE*`, `test/auto-state.test.mjs`) and dashboard folder grouping —
> is **not in `plan.md`**. Decide whether to fold it into the plan/PRD or treat it as a
> separate accepted feature. Task 1 (scope-lock docs) was meant to prevent exactly this
> drift and was skipped.

Legend: ❌ Missing · ⚠️ Partial · ✅ already done (listed only where context helps).

---

## Priority 1 — Load-bearing functional gaps

### T16 ❌ Plan/approval actions in the dashboard
Backend exists (`service.requestPlan`/`approvePlan`/`requestPlanChanges`,
`service.mjs:799-822`) but there is **no UI**.
- Add keys in list/peek/review: `P` request plan, `A` approve plan, `C` request changes.
- Add a `q`/reply-while-busy affordance that makes queuing explicit (currently queuing
  happens silently server-side; reply notice still says "Reply sent").
- Render distinct plan-state badges (`plan_requested` / `awaiting_approval` / `approved` /
  `changes_requested`) — today only a generic `π` badge exists (`dashboard.ts:1330`).
- In peek/review, show current `planText` and the "Approve this plan?" prompt.
- Guard `A`/`C` when there is no `awaiting_approval` plan, with a clear notice.
- Files: `src/ui/dashboard.ts`, `src/ui/dashboard-evidence.mjs`, `src/core/rows.mjs`.
- Acceptance: UI test — invalid approval rejected, plan request updates state, approve
  queues execution.

### T5 ⚠️ Provider stall detection (JSON runner)
Entirely absent. `AGENT_BOARD_STALL_MS` does not exist; `diagnostics.summarize` and
`service.ptyHealth` already *count* `stalled`/`provider_stall` but nothing **emits** it.
- Add configurable stall detection (`AGENT_BOARD_STALL_MS`) in `runner/job-runner.mjs`:
  when no assistant/tool event arrives after start, set `ViewState.diagnostics.stalled`
  and emit a "waiting for provider response" diagnostic.
- Also add: a "first event" diagnostic, and summary-model attempt/result diagnostics
  (`maybeModelSummary` currently logs nothing).
- Files: `runner/job-runner.mjs`, `src/core/diagnostics.mjs` (consumer already exists).
- Acceptance: `test/runner.integration.test.mjs` `provider_stall` mode (needs fake-pi
  support — see T19).

### T6 ⚠️ PTY-host diagnostics
`runner/pty-runner.mjs` was **never touched**. The service-side hosted evidence/steering
sync exists (`syncRowEvent`, `service.mjs:475`), but the host process has no audit trail.
- In `pty-runner.mjs`, append host diagnostics for: host start, socket listen, client
  attach/detach, input/resize/interrupt/terminate, child exit, host errors.
- Files: `runner/pty-runner.mjs`.
- Acceptance: `test/pty-runner.integration.test.mjs` verifies host diagnostics; a service
  test asserts hosted sync actually updates `evidence.json` (current tests only assert
  `state.json` fields).

### T17 ⚠️ Queued follow-ups — visibility & management UI
Count badge only (`q<n>`, `dashboard.ts:1330`). Service ops exist
(`service.clearFollowUps:778`, `service.removeLastFollowUp:784`) but no UI wires them.
- Render queued **preview** (already derived in `rows.mjs:139`, not shown).
- Add a queue section in peek/review/evidence.
- Add actions: remove last queued item, clear queue (with confirmation).
- Files: `src/ui/dashboard.ts`, `src/ui/dashboard-evidence.mjs`, `src/core/rows.mjs`.
- Acceptance: tests for queued-count updates, clear-queue confirmation, survives reload.

### T12 ⚠️ Plan-mode tool restriction / advisory diagnostic
Prompt builders exist (`src/core/steering-prompts.mjs`) but plan-mode safety is weaker
than the plan's acceptance criterion.
- Attempt `RunConfig.tools` read-only allowlist after validating Pi tool names; if names
  can't be validated, **emit a diagnostic** stating plan mode is advisory (today it's only
  a hardcoded sentence in the prompt, `steering-prompts.mjs:9`; `tools` is always `null`).
- Wire builders into `runner/pty-runner.mjs` too (currently only service + job-runner).
- Files: `src/core/steering-prompts.mjs`, `src/runtime/service.mjs`,
  `runner/job-runner.mjs`, `runner/pty-runner.mjs`.
- Acceptance: prompt builder tests assert stable prompts; diagnostics clearly state
  advisory vs tool-restricted.

### T7 ⚠️ Service API gaps
- `retryLastRun(viewId)` is **missing and not documented as deferred** — implement, or
  explicitly document it as deferred (plan allows either).
- `reconcile()` appends a diagnostic on the host-exit branch (`service.mjs:930`) but the
  **runner-died branch (`:940-947`) that marks rows failed/stale is silent** — add a
  diagnostic there.
- Files: `src/runtime/service.mjs`.
- Acceptance: service test confirms reconcile emits a diagnostic; tests read the
  evidence/diagnostic tails via the new APIs.

---

## Priority 2 — Surface polish / spec conformance

### T8 ⚠️ Dashboard evidence mode
- Mode is named `evidence`, plan said `review` — rename or consciously accept.
- Panel is **missing the plan/approval-state section** (`dashboard-evidence.mjs`).
- Acceptance test only calls `buildEvidencePanel()` directly; add a test that drives the
  `e` key via `handleInput` and confirms old keys (`space`, `v`, `→`, `r`) still behave
  (depends on T20 harness).

### T14 ❌ Shared attach-flow refactor
`src/commands/attach-flow.ts` was never created; `attach`, `openPtyAttach`,
`showSwitchingOverlay`, `installBackToDashboard` remain private in `agent-board.ts`.
`/bg` reuses attach via `dashboardAttachLoop` (de-facto reuse), so this is a cleanliness
task, not a blocker.
- Move the helpers into `src/commands/attach-flow.ts` as reusable exports.
- Acceptance: `/agent-board --attach` unchanged; both commands compile against the shared
  helper.

### T1 ❌ Scope-lock docs
- Add a "current focus" section to `README.md`, `PRD.md`, `VERIFY.md`: evidence/
  diagnostics + steering-first UX in scope; worktree-first/same-repo safety explicitly
  out of scope. (Note: existing PRD.md text *requires* worktree isolation — reconcile it.)
- Acceptance: docs mention `/bg`, queued follow-ups, evidence/diagnostics, and state no
  worktree policy changes are included.

### T21 ⚠️ Docs & manual verification
Only README was updated, and only for the unplanned auto-state feature.
- Document `/bg` syntax + limits, the `e` evidence/diagnostics panel, plan/approve/change
  keys, queued follow-up behavior, start-and-attach PTY fallback.
- Add store artifact examples (evidence/queue/steering/diagnostics).
- Files: `README.md`, `VERIFY.md`, `PRD.md`, `PROGRESS.md` (last three untouched).

---

## Priority 3 — Test scaffolding (Phase 4)

### T19 ⚠️ fake-pi modes + integration tests
`test-support/fake-pi.mjs` was **not modified** (only `hang`/`slow`/`fail`/
`needs_input`/`completed` exist).
- Add fake modes: `evidence_success`, `tool_error`, `plan_ready`, `provider_stall`, and
  multi-run queued follow-ups. These unblock T5, T10, and runner integration coverage.
- Add `test/bg-command.test.mjs`; touch `test/events.test.mjs` if reducer changes warrant.

### T10 ⚠️ Drain acceptance tests
Drain code is complete (JSON respawn chain `job-runner.mjs:246-270`; hosted
`drainNextFollowUp` `service.mjs:433-472`; reconcile fallback `:951-956`) but untested.
- Integration test: queue two follow-ups, assert in-order execution.
- Hosted service test: `agent_end` drains exactly one queued item to the socket.

### T20 ❌ Dashboard state-machine harness
- Create `test/dashboard-harness.mjs` (fake TUI/theme/keybindings/service) and drive
  `DashboardComponent.handleInput()` — currently `handleInput` is never exercised in tests.
- Add `test/dashboard-steering.test.mjs`; convert/extend `test/dashboard-evidence.test.mjs`
  from a pure-render test to a harness-driven one.
- Covers acceptance for T8, T15, T16, T17.

### T18 ⚠️ Migration test
Normalizers are backcompat-safe, but there's no test for it.
- Add a `test/store.test.mjs` case: create an old-style row with only `meta.json`/
  `state.json` (no evidence/queue/steering files) and verify listing, attach, reply,
  archive, mark-done still work.

### T9 (minor) Add a service-level empty-`reply()` rejection test
Core rejection exists (`enqueueFollowUp` + `reply` line 590); only the service-level
assertion is missing.

---

## Suggested implementation order

1. **T19 fake-pi modes** first — unblocks T5/T10/T20 testing.
2. **T5 stall + T6 host diagnostics** (reliability backend) with their new fake modes.
3. **T16 + T17 dashboard UI** (the steering/queue user surface — biggest product gap).
4. **T20 harness** + T8/T10/T18 tests to lock the above behaviors.
5. **T7, T12** service/safety conformance.
6. **T14** attach-flow refactor (cleanup).
7. **T1, T21** docs last, reflecting final reality + the auto-state scope decision.

## Already complete (no action)
T2, T3 (foundation), T4 (evidence reducer), T9 (queue service semantics), T11 (steering
state machine), T13 (`/bg` command — minus its test), T15 (start-and-attach), T22
(validation gate green).
