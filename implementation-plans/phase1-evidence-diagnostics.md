# Implementation Plan

## Goal
Implement Phase 1 evidence and diagnostics collection across JSON runner, foreground/hosted service events, PTY host lifecycle, and a dashboard evidence mode, while leaving worktree/same-repo safety behavior unchanged.

## Tasks
1. **Scope guard: preserve current worktree behavior**
   - File: `src/runtime/service.mjs`, `test/service.test.mjs`
   - Changes: Do not modify `dispatchOpts.worktree` rejection, `worktreeMode: "off"` creation, or the tests that allow concurrent same-repo sessions. Do not edit `src/core/worktree.mjs` for this phase.
   - Acceptance: Existing tests `dispatch rejects explicit worktree requests`, `dispatch allows a second active session in the same repo`, and `dispatch allows a second active session in the same non-git folder` remain unchanged and pass.

2. **Add Phase 1 artifact paths and shared data shapes**
   - File: `src/core/paths.mjs`
   - Changes: Add helpers `diagnosticsPath(root, viewId)`, `viewEvidencePath(root, viewId)`, and `runEvidencePath(root, viewId, runId)` under the existing `views/<id>/` and `views/<id>/runs/<runId>/` layout.
   - File: `src/core/types.mjs`
   - Changes: Add JSDoc typedefs for `DiagnosticEvent`, `DiagnosticSummary`, `EvidenceSnapshot`, `EvidenceSummary`, `EvidenceCommand`, `EvidenceFileChange`, `EvidenceError`, and `EvidenceAssistantClaim`. Add optional `diagnostics` and `review` summaries to `ViewState`; add optional `eventCount`, `lastEventAt`, `usage`, `stallReason`, and `evidenceSummary` to `RunStatus`.
   - File: `src/core/store.mjs`
   - Changes: Initialize `diagnostics` and `review` to empty summaries in `createView()` state creation only if doing so does not break old rows; keep `readState()` tolerant of missing fields.
   - Acceptance: Old stores with only `meta.json` and `state.json` still load, and new path helpers are covered by tests.

3. **Create diagnostics persistence helpers**
   - New File: `src/core/diagnostics.mjs`
   - Changes: Implement `appendDiagnostic(root, viewId, event)`, `readDiagnostics(root, viewId, { limit } = {})`, `clearDiagnostics(root, viewId)`, `emptyDiagnosticSummary()`, `summarizeDiagnostic(summary, event)`, and redaction helpers for args/env/errors. Persist JSONL at `diagnosticsPath`; update `state.diagnostics` with counts, last event, error/warn counts, and `stalled` when events of type `provider_stall`/`provider_stall_resolved` arrive.
   - File: `src/core/atomic.mjs`
   - Changes: Add `readJsonlTail(file, limit)` or an equivalent bounded tail helper used by diagnostics; reuse `atomicWrite()` to clear logs.
   - Acceptance: `test/diagnostics.test.mjs` verifies append, tail limit, clear, redaction, corrupt-line tolerance, and state summary updates.

4. **Create evidence reducer and command/file classification helpers**
   - New File: `src/core/evidence.mjs`
   - Changes: Implement `createEvidenceSnapshot({ viewId, runId, kind, prompt, startedAt, source })`, `readViewEvidence`, `readRunEvidence`, `writeEvidenceSnapshot`, `reduceEvidence(snapshot, event, now)`, `finalizeEvidence(snapshot, status, now)`, `evidenceSummary(snapshot)`, and `writeEvidenceForRunAndView(root, snapshot)`. The reducer should collect changed files from edit/write-style tools, bash commands classified as `test|build|lint|git|install|other`, tool errors, assistant final evidence text, usage totals, event count, and outcome.
   - File: `src/core/heuristics.mjs`
   - Changes: Add/export `classifyCommand(command)`, `commandPreview(command)`, and `toolFileOperation(toolName, args)` while keeping existing helpers compatible.
   - File: `src/core/events.mjs`
   - Changes: Increment `RunStatus.eventCount`/`lastEventAt` in `reduceEvent`; aggregate `message.usage` into `status.usage`; preserve `previousState.review` and `previousState.diagnostics` in `projectViewState()` so runner/service status writes do not erase summaries.
   - Acceptance: `test/evidence.test.mjs` verifies file changes, command/test classification, tool errors, assistant claims, usage aggregation, finalize outcome, and read/write round trips.

5. **Persist evidence and diagnostics from the detached JSON runner**
   - File: `runner/job-runner.mjs`
   - Changes: Import diagnostics/evidence helpers. On runner start, create an evidence snapshot and append diagnostics for `runner_start`, redacted `worker_spawn`, `worker_pid`, `first_event`, malformed JSON, stderr chunks, `worker_error`, `worker_exit`, summary-model attempt/skipped/success/failure, and `runner_exit`. On each parsed JSON event, call both `reduceEvent()` and `reduceEvidence()`, then throttle persistence of `status.json`, `state.json`, `runs/<runId>/evidence.json`, and `views/<id>/evidence.json`. On close/error, call `finalizeRun()` then `finalizeEvidence()` and persist immediately.
   - File: `runner/job-runner.mjs`
   - Changes: Add stall detection using `AGENT_BOARD_STALL_MS` (fallback sensible default, legacy alias optional). If no assistant/tool event occurs after start within the threshold, set `status.stallReason = "waiting_for_provider_response"`, append `provider_stall`, and update state diagnostics. If a provider event later arrives, append `provider_stall_resolved` and clear `stallReason`.
   - Acceptance: `test/runner.integration.test.mjs` verifies successful evidence artifacts, failed/tool-error evidence, stderr diagnostics, and provider-stall diagnostics with a small `AGENT_BOARD_STALL_MS`.

6. **Expose evidence and diagnostics through the service**
   - File: `src/runtime/service.mjs`
   - Changes: Add methods `evidence(viewId)`, `diagnostics(viewId, opts)`, `clearDiagnostics(viewId)`, and either `boardHealth()` or an extension of `ptyHealth()` with diagnostic stalled/error counts. Return artifact paths with `evidence()` so the UI can show log locations.
   - File: `src/runtime/service.mjs`
   - Changes: Append diagnostics from `dispatch`, `reply`, `stop`, `archive`, `ensureHost`, and `reconcile()` for meaningful state transitions and failures. In `reconcile()`, append a diagnostic when a stale row is projected from terminal status or marked failed.
   - Acceptance: `test/service.test.mjs` verifies evidence/diagnostic read APIs, clearing diagnostics, health counts, and reconcile diagnostic emission.

7. **Collect evidence from foreground and hosted Pi lifecycle events**
   - File: `src/runtime/service.mjs`
   - Changes: In `syncRowEvent()`, create/update a view-level evidence snapshot for `input`, `before_agent_start`, `agent_start`, `tool_execution_*`, `message_*`, and `agent_end`. Use `reduceEvidence()` alongside `reduceEvent()`. On `agent_end`, finalize evidence using the foreground status and write `views/<id>/evidence.json`. Append diagnostics for foreground/hosted turn start, end, and reducer errors.
   - File: `src/index.ts`
   - Changes: Keep the existing event subscriptions, but update footer/status counts to include stalled diagnostics if `ptyHealth()`/`boardHealth()` exposes them. Do not add new event types beyond the existing Pi lifecycle hooks.
   - Acceptance: `test/service.test.mjs` verifies `syncForegroundEvent()` and `syncHostedEvent()` update `views/<id>/evidence.json` and preserve normal row state behavior.

8. **Persist PTY host diagnostics**
   - File: `runner/pty-runner.mjs`
   - Changes: Import `appendDiagnostic()`. Append diagnostics for config load/start, stale socket unlink, child spawn success/failure, socket listen, client attach/detach, client protocol errors, input/resize/interrupt/terminate commands, child exit, child error, server error, screen-log write failure, and shutdown. Do not log raw user input; record only byte/character counts and command type.
   - Acceptance: `test/pty-runner.integration.test.mjs` verifies diagnostics contain host start, socket listen, client attach, input, resize, and child exit events while existing socket/output behavior still passes.

9. **Add row summaries, badges, and filters for evidence/diagnostics**
   - File: `src/core/rows.mjs`
   - Changes: Extend `RowView` with `reviewReady`, `evidenceErrorCount`, `diagnosticStalled`, and `diagnosticErrorCount` derived from `row.state?.review` and `row.state?.diagnostics`. Add filter tokens `review:ready`, `diag:stalled`, and `evidence:error` without changing existing `s:<state>` behavior.
   - File: `src/ui/dashboard.ts`
   - Changes: Render compact badges in row prefixes for ready evidence, evidence errors, and stalled diagnostics; include stalled count in the header if available.
   - Acceptance: `test/rows.test.mjs` verifies new rowView fields and filters while all existing row/filter tests remain valid.

10. **Add dashboard evidence mode**
   - File: `src/ui/dashboard.ts`
   - Changes: Add mode `"evidence"`, `evidenceReturnMode`, and `evidenceScrollTop`. Bind `e` from list/peek/session to open the selected row's evidence panel. Bind `esc`/`←` to return, `r` to reply, `v` to transcript, `a`/`→` to attach, and `x` to confirm `clearDiagnostics()`. Update help and hint text to advertise `e evidence`.
   - New File: `src/ui/dashboard-evidence.mjs`
   - Changes: Add pure rendering helpers used by `dashboard.ts`, e.g. `buildEvidencePanel({ row, evidence, diagnostics, paths }, width)` and small formatters for command status, file lists, diagnostic tail, and artifact paths. Keep this file free of Pi TUI imports so it is testable by `node --test`.
   - File: `src/ui/dashboard.ts`
   - Changes: `renderEvidence()` should call `service.evidence(viewId)` and `service.diagnostics(viewId, { limit: 50 })`, then render sections: outcome, changed files, commands/tests, errors/blockers, latest assistant evidence, diagnostics tail, and artifact/log paths.
   - Acceptance: `test/dashboard-evidence.test.mjs` verifies the pure panel renderer includes each section and handles empty evidence/diagnostics. Manual/dashboard smoke check verifies pressing `e` opens the mode and existing keys (`space`, `v`, `→`, `r`) still work.

11. **Expand fake worker modes for evidence and diagnostics tests**
   - File: `test-support/fake-pi.mjs`
   - Changes: Add modes `evidence_success`, `tool_error`, and `provider_stall`. `evidence_success` should emit edit/write and bash test events plus final “tests pass” text. `tool_error` should emit a failed tool result and nonzero exit. `provider_stall` should delay assistant/tool events long enough to trigger `AGENT_BOARD_STALL_MS`, then finish or be safely killable by tests.
   - File: `test-support/fake-pty-pi.mjs`
   - Changes: No behavior change required unless PTY diagnostics tests need an explicit stderr/error branch.
   - Acceptance: New modes are used by integration tests and do not change existing fake modes.

12. **Add and update automated tests**
   - New Files: `test/evidence.test.mjs`, `test/diagnostics.test.mjs`, `test/dashboard-evidence.test.mjs`
   - Changes: Cover pure reducers/helpers and dashboard evidence rendering.
   - Files: `test/events.test.mjs`, `test/store.test.mjs`
   - Changes: Cover event counts/usage and preservation/backcompat of optional `review`/`diagnostics` state fields.
   - Files: `test/runner.integration.test.mjs`, `test/service.test.mjs`, `test/pty-runner.integration.test.mjs`, `test/rows.test.mjs`
   - Changes: Add assertions for runner artifacts, service APIs and hosted/foreground evidence sync, PTY diagnostics, row badges, and filters.
   - Acceptance: `npm test` passes, including all existing tests.

13. **Document and manually verify Phase 1**
   - Files: `README.md`, `VERIFY.md`
   - Changes: Add short documentation for the `e` evidence/diagnostics panel, diagnostic stall indicator, artifact paths, and `x` clear-diagnostics action. Explicitly state this phase does not change worktree isolation or same-repo launch behavior.
   - Acceptance: `VERIFY.md` includes manual checks for JSON-runner evidence, PTY diagnostics, hosted/foreground evidence sync, stalled provider diagnostics, and dashboard evidence mode.

14. **Run final validation**
   - File: no source file
   - Changes: Run `npm run typecheck`, `npm test`, and `npm run pack:dry` after implementation.
   - Acceptance: All validation commands pass.

## Files to Modify
- `src/core/types.mjs` - add diagnostics/evidence typedefs and optional `ViewState`/`RunStatus` summary fields.
- `src/core/paths.mjs` - add diagnostics and evidence artifact path helpers.
- `src/core/atomic.mjs` - add bounded JSONL tail helper used by diagnostics.
- `src/core/heuristics.mjs` - add command and tool/file operation classifiers.
- `src/core/events.mjs` - add event count/usage tracking and preserve optional state summaries in projection.
- `src/core/store.mjs` - initialize optional summaries for new rows while keeping old rows compatible.
- `src/runtime/service.mjs` - add evidence/diagnostics APIs, diagnostic emissions, foreground/hosted evidence sync, and health counts.
- `src/index.ts` - surface stalled diagnostic count in the footer/status if exposed by service health.
- `src/core/rows.mjs` - add row evidence/diagnostic fields and filters.
- `src/ui/dashboard.ts` - add evidence mode, keybindings, row badges, clear-diagnostics action, and help/hints.
- `runner/job-runner.mjs` - persist JSON-runner diagnostics/evidence and provider-stall diagnostics.
- `runner/pty-runner.mjs` - persist PTY host lifecycle/control diagnostics.
- `test-support/fake-pi.mjs` - add fake evidence, tool-error, and provider-stall modes.
- `test/events.test.mjs` - cover event count/usage and state summary preservation.
- `test/store.test.mjs` - cover optional field backcompat/path helpers.
- `test/runner.integration.test.mjs` - cover runner evidence and diagnostics artifacts.
- `test/service.test.mjs` - cover service APIs, reconcile diagnostics, and hosted/foreground evidence sync.
- `test/pty-runner.integration.test.mjs` - cover PTY diagnostics.
- `test/rows.test.mjs` - cover evidence/diagnostic row view fields and filters.
- `README.md` - document evidence/diagnostics mode and non-change to worktree behavior.
- `VERIFY.md` - add manual verification flows for Phase 1.

## New Files
- `src/core/diagnostics.mjs` - JSONL diagnostics append/read/clear, summaries, and redaction.
- `src/core/evidence.mjs` - evidence snapshot reducer, persistence helpers, summaries, and finalization.
- `src/ui/dashboard-evidence.mjs` - pure evidence panel rendering/formatting helper for dashboard and tests.
- `test/diagnostics.test.mjs` - diagnostics helper tests.
- `test/evidence.test.mjs` - evidence reducer and persistence tests.
- `test/dashboard-evidence.test.mjs` - dashboard evidence panel renderer tests.

## Dependencies
- Tasks 2-4 must land before runner, service, PTY, and dashboard integrations because they define shared paths, schemas, and reducers.
- Task 5 depends on Tasks 2-4.
- Tasks 6-8 depend on Tasks 2-4 and can proceed in parallel after the shared helpers exist.
- Tasks 9-10 depend on service APIs and state summaries from Tasks 6-7.
- Task 11 should land before integration tests in Task 12.
- Task 13 should be updated after behavior and keybindings are finalized.
- Task 14 runs last.

## Risks
- `/Users/rutvik/rcode/pi-agents-view/context.md` was requested but is absent; this plan is based on `plan.md` and repository inspection.
- Evidence extraction is heuristic and should be labeled as collected evidence, not a guaranteed review verdict.
- Diagnostics/evidence may include sensitive prompts, file paths, commands, and errors; redact env/secrets and avoid raw PTY input logging.
- Stall detection can false-positive on slow providers; make the threshold configurable and emit a resolved diagnostic when activity resumes.
- Foreground/hosted evidence depends on Pi lifecycle events from the child extension; raw PTY output alone cannot produce structured evidence.
- `projectViewState()` currently rewrites state objects, so preserving `review`/`diagnostics` is required to avoid losing summaries during normal runner/service updates.
- Dashboard component tests cannot easily import `dashboard.ts` under the current `node --test test/*.test.mjs` setup; keep evidence rendering in a pure `.mjs` helper and do a manual smoke test for the `e` key unless a TS test loader is added.
- Avoid any worktree/same-repo safety changes in this phase; do not modify `src/core/worktree.mjs` or the existing worktree-disabled tests.
