# Implementation Plan

## Goal
Establish the Phase 0 durable data-model and storage helpers for diagnostics, review evidence, follow-up queues, and steering state without changing any worktree or safe-parallel-coding behavior.

## Tasks
1. **Add the foundation tests first**: Create focused failing tests for the new artifact paths, defaults, summaries, and helper APIs before implementation.
   - File: `test/diagnostics.test.mjs`
   - Changes: Add tests for appending diagnostic JSONL events, reading all events, bounded tail reads, summary counts, corrupt-line tolerance, and redaction of obvious secret keys in `details`.
   - Acceptance: Tests cover missing-file defaults and two appended events with `tailDiagnostics(root, viewId, { limit: 1 })` returning only the newest event.
   - File: `test/evidence.test.mjs`
   - Changes: Add tests for `emptyEvidenceSnapshot`, view-level evidence read/write, run-level evidence read/write, summary derivation, and helper upserts for commands/file changes/errors/assistant evidence.
   - Acceptance: Tests prove missing `evidence.json` defaults to an empty snapshot and `runs/<runId>/evidence.json` round-trips independently.
   - File: `test/follow-up-queue.test.mjs`
   - Changes: Add tests for default empty queue, enqueue validation/trimming, FIFO claim, complete/fail transitions, durable summary counts, and lock cleanup.
   - Acceptance: Empty follow-up text is rejected; two queued items claim in creation order.
   - File: `test/steering.test.mjs`
   - Changes: Add tests for default steering state, plan-request/plan-ready/approve/change-request/executing transitions, history entries, and summary projection.
   - Acceptance: `recordPlanReady` produces `awaiting_approval` with a non-empty `planPreview` and approval question.
   - File: `test/store.test.mjs`
   - Changes: Add tests that old rows with only `meta.json`/`state.json` still load, and rows with new artifact files expose compact summaries on `loadRow(...).state`.
   - Acceptance: Existing store tests still pass unchanged except for any intentional additions; no test asserts or changes worktree behavior.

2. **Extend shared typedefs with minimal schemas**: Add JSDoc-only schema definitions and optional summary fields.
   - File: `src/core/types.mjs`
   - Changes: Add typedefs for:
     - `DiagnosticEvent`: `{ version, at, viewId, runId, source, level, code, message, details }` where `level` is `"info"|"warn"|"error"` and `source` is `"runner"|"host"|"service"|"queue"|"steering"|"evidence"|"store"`.
     - `DiagnosticSummary`: `{ count, warningCount, errorCount, lastAt, lastLevel, lastCode, lastMessage, stalled, stallReason }`.
     - `EvidenceSnapshot`: `{ version, viewId, runId, updatedAt, outcome, ready, summary, commands, fileChanges, errors, assistantEvidence, usage }` where `outcome` is `"unknown"|"in_progress"|"ready"|"needs_input"|"failed"|"stopped"`.
     - `EvidenceCommand`: `{ id, at, command, kind, status, exitCode, durationMs, outputPreview }` where `kind` is `"test"|"build"|"lint"|"git"|"install"|"other"` and `status` is `"started"|"passed"|"failed"|"unknown"`.
     - `EvidenceFileChange`: `{ path, action, toolName, firstSeenAt, lastSeenAt, count }` where `action` is `"edited"|"written"|"deleted"|"unknown"`.
     - `EvidenceError`, `EvidenceAssistantClaim`, `EvidenceUsage`, and `ReviewSummary` with only count/preview fields needed by row summaries.
     - `FollowUpItem`: `{ id, seq, text, createdAt, updatedAt, status, source, delivery, runId, claimedAt, completedAt, attempts, error }`.
     - `FollowUpQueue`: `{ version, viewId, nextSeq, updatedAt, items }` and `FollowUpSummary`: `{ queuedCount, claimedCount, lastQueuedAt, lastQueuedPreview }`.
     - `SteeringState`: `{ version, viewId, status, updatedAt, planText, planRunId, approvedAt, changeRequest, executionRunId, history }` where `status` is `"none"|"plan_requested"|"awaiting_approval"|"approved"|"changes_requested"|"executing_approved_plan"`.
     - `SteeringSummary`: `{ status, awaitingApproval, planPreview, updatedAt, question }`.
   - Changes: Add optional properties to `ViewState`: `review?: ReviewSummary`, `diagnostics?: DiagnosticSummary`, `followUps?: FollowUpSummary`, `steering?: SteeringSummary`.
   - Changes: Add optional properties to `RunStatus`: `eventCount?: number`, `lastEventAt?: number|null`, `usage?: EvidenceUsage|null`, `stallReason?: string|null`, `evidenceSummary?: ReviewSummary|null`.
   - Acceptance: `npm run typecheck` still passes; these are optional schemas and do not require old JSON files to contain new fields.

3. **Add artifact paths and low-level storage primitives**: Define the new durable files without changing existing store layout.
   - File: `src/core/paths.mjs`
   - Changes: Add helpers:
     - `diagnosticsPath(root, viewId)` -> `views/<id>/diagnostics.jsonl`
     - `evidencePath(root, viewId)` -> `views/<id>/evidence.json`
     - `followUpQueuePath(root, viewId)` -> `views/<id>/queue.json`
     - `steeringPath(root, viewId)` -> `views/<id>/steering.json`
     - `runEvidencePath(root, viewId, runId)` -> `views/<id>/runs/<runId>/evidence.json`
     - `viewLockPath(root, viewId, name)` -> `views/<id>/<name>.lock`
   - File: `src/core/atomic.mjs`
   - Changes: Add `appendJsonl(file, value)` that JSON-stringifies one object and appends a newline using existing `appendLine`.
   - Changes: Add `readJsonlTail(file, limit)` that reuses `readJsonl(file)`, skips corrupt lines, and returns the newest `limit` entries when `limit > 0`.
   - New File: `src/core/locks.mjs`
   - Changes: Add synchronous lock helpers `withFileLockSync(lockPath, fn, opts?)` and `withViewLockSync(root, viewId, name, fn, opts?)` using exclusive lock-file creation, owner metadata, stale-lock replacement, and guaranteed cleanup in `finally`.
   - Acceptance: Path tests assert exact filenames; lock tests prove the lock file is removed after success and after thrown errors.

4. **Implement diagnostics storage helpers**: Add append/read/tail/summary APIs over `diagnostics.jsonl`.
   - New File: `src/core/diagnostics.mjs`
   - Changes: Export `appendDiagnostic(root, viewId, patch)`, `readDiagnostics(root, viewId)`, `tailDiagnostics(root, viewId, opts?)`, `clearDiagnostics(root, viewId)`, `summarizeDiagnostics(events)`, `readDiagnosticSummary(root, viewId)`, and `redactDiagnosticDetails(value)`.
   - Changes: `appendDiagnostic` should fill defaults for `version: 1`, `at: Date.now()`, `viewId`, `runId: null`, `level: "info"`, `source: "service"`, `code: "event"`, `message: code`, and redacted `details: {}`.
   - Changes: Redact keys matching `/token|secret|password|authorization|api[_-]?key/i` in nested `details` values.
   - Acceptance: Diagnostics tests pass; missing diagnostics file returns `[]` and a zero-count summary.

5. **Implement evidence snapshot helpers**: Add durable view-level and run-level evidence storage, but do not wire event extraction yet.
   - New File: `src/core/evidence.mjs`
   - Changes: Export `emptyEvidenceSnapshot({ viewId, runId?, now? })`, `normalizeEvidenceSnapshot(snapshot, fallback)`, `readEvidence(root, viewId)`, `writeEvidence(root, snapshot)`, `readRunEvidence(root, viewId, runId)`, `writeRunEvidence(root, snapshot)`, `summarizeEvidence(snapshot)`, `upsertEvidenceCommand(snapshot, command)`, `upsertEvidenceFileChange(snapshot, change)`, `recordEvidenceError(snapshot, error)`, `recordAssistantEvidence(snapshot, text, opts?)`, and `mergeEvidenceSnapshot(base, incoming)`.
   - Changes: Keep helpers pure/synchronous and path-based; no imports from runner/service/UI.
   - Changes: Summaries should expose only compact counts/previews: `ready`, `outcome`, `fileChangeCount`, `commandCount`, `failedCommandCount`, `errorCount`, `latestAssistantEvidence`, and `updatedAt`.
   - Acceptance: Evidence tests pass and prove view evidence and per-run evidence do not overwrite each other.

6. **Implement durable follow-up queue helpers**: Add queue mutation APIs with per-view locking and FIFO semantics.
   - New File: `src/core/follow-up-queue.mjs`
   - Changes: Export `emptyFollowUpQueue(viewId, now?)`, `readFollowUpQueue(root, viewId)`, `writeFollowUpQueue(root, queue)`, `summarizeFollowUpQueue(queue)`, `enqueueFollowUp(root, viewId, text, opts?)`, `claimNextFollowUp(root, viewId, opts?)`, `completeFollowUp(root, viewId, itemId, opts?)`, `failFollowUp(root, viewId, itemId, error, opts?)`, and `clearQueuedFollowUps(root, viewId)`.
   - Changes: Queue mutations must run under `withViewLockSync(root, viewId, "queue", ...)` to avoid lost updates.
   - Changes: Use statuses `"queued"|"claimed"|"completed"|"failed"|"cancelled"`; do not spawn runs or inject replies in Phase 0.
   - Acceptance: Follow-up queue tests pass; queue files survive process reload through `readFollowUpQueue`.

7. **Implement steering state helpers**: Add durable plan/approval state storage and transition helpers without launching work.
   - New File: `src/core/steering.mjs`
   - Changes: Export `emptySteeringState(viewId, now?)`, `readSteering(root, viewId)`, `writeSteering(root, state)`, `summarizeSteering(state)`, `requestPlan(root, viewId, opts?)`, `recordPlanReady(root, viewId, opts)`, `approvePlan(root, viewId, opts?)`, `requestPlanChanges(root, viewId, feedback, opts?)`, `markExecutingApprovedPlan(root, viewId, opts?)`, and `resetSteering(root, viewId, opts?)`.
   - Changes: Each transition should append a compact history item `{ at, from, to, action, runId, note }` and update `updatedAt`.
   - Changes: `summarizeSteering` should set `awaitingApproval: true` and `question: "Approve this plan?"` only when status is `"awaiting_approval"`.
   - Acceptance: Steering tests pass; helpers only write `steering.json` and do not modify `state.json` or queues.

8. **Wire artifact summaries into row loading**: Make rows expose compact summaries while keeping artifact files optional.
   - File: `src/core/store.mjs`
   - Changes: Import summary readers from `diagnostics.mjs`, `evidence.mjs`, `follow-up-queue.mjs`, and `steering.mjs`.
   - Changes: Add `readViewArtifactSummaries(root, viewId)` returning `{ review, diagnostics, followUps, steering }` with default empty summaries when files are missing/corrupt.
   - Changes: Update the `Row` typedef to include optional top-level `review`, `diagnostics`, `followUps`, and `steering` summaries.
   - Changes: Update `loadRow(root, viewId)` to clone `state` and attach `state.review`, `state.diagnostics`, `state.followUps`, and `state.steering`; also expose the same summaries as top-level row properties for future UI use.
   - Changes: Do not make `createView` create any of the new artifact files; they should remain lazy/optional for backcompat.
   - Acceptance: Old stores with only `meta.json`/`state.json` load cleanly; `listRows(root)` works with and without new artifacts.

9. **Initialize new run-status fields without changing reducers**: Make new runs self-describing while deferring evidence/diagnostic event reduction to Phase 1.
   - File: `src/core/events.mjs`
   - Changes: In `createRunStatus`, initialize `eventCount: 0`, `lastEventAt: null`, `usage: null`, `stallReason: null`, and `evidenceSummary: null`.
   - Changes: Do not change `reduceEvent`, `finalizeRun`, or worktree/safety behavior in this phase.
   - File: `test/events.test.mjs`
   - Changes: Add assertions for the new `createRunStatus` defaults only.
   - Acceptance: Existing event reducer tests remain green; no evidence extraction is attempted yet.

10. **Validate Phase 0 and explicitly preserve worktree behavior**: Run the existing and new checks after implementation.
   - File: no source file; validation task.
   - Changes: Run `npm test`, `npm run typecheck`, and optionally `npm run pack:dry`.
   - Acceptance: All tests pass, including existing service tests for disabled worktree requests and same-repo concurrent dispatch. No changes are made to `src/core/worktree.mjs`, worktree path helpers beyond untouched existing helpers, or service safe-parallel/worktree policy.

## Files to Modify
- `src/core/types.mjs` - add diagnostic, evidence, follow-up queue, steering, summary, and optional run/view typedef fields.
- `src/core/paths.mjs` - add path helpers for `diagnostics.jsonl`, `evidence.json`, `queue.json`, `steering.json`, run evidence, and view lock files.
- `src/core/atomic.mjs` - add JSONL append and bounded tail helpers.
- `src/core/store.mjs` - load compact artifact summaries for rows while preserving old store compatibility.
- `src/core/events.mjs` - initialize new optional `RunStatus` fields in `createRunStatus` only.
- `test/store.test.mjs` - add backcompat and row-summary loading tests.
- `test/events.test.mjs` - add default-field assertions for new run status fields.

## New Files
- `src/core/locks.mjs` - synchronous per-file/per-view lock helpers for queue-safe mutation.
- `src/core/diagnostics.mjs` - diagnostic event JSONL append/read/tail/summary/redaction helpers.
- `src/core/evidence.mjs` - evidence snapshot defaults, read/write, summary, and mutation helpers.
- `src/core/follow-up-queue.mjs` - durable FIFO follow-up queue read/write/mutation helpers.
- `src/core/steering.mjs` - durable steering state defaults, summaries, and transition helpers.
- `test/diagnostics.test.mjs` - diagnostics storage and redaction tests.
- `test/evidence.test.mjs` - evidence snapshot storage and summary tests.
- `test/follow-up-queue.test.mjs` - queue mutation, FIFO, and locking tests.
- `test/steering.test.mjs` - steering state transition and summary tests.

## Dependencies
- Task 1 should be written first so implementation is test-driven.
- Task 2 must land before Tasks 4-8 so helper modules can reference the shared typedef names.
- Task 3 must land before Tasks 4-8 because every helper module depends on the new paths; Task 6 also depends on `locks.mjs`.
- Tasks 4-7 can be implemented in parallel after paths/types/locks exist because they should not import each other.
- Task 8 depends on Tasks 4-7 because `store.mjs` imports their summary readers.
- Task 9 can happen after Task 2 and is independent of artifact helper implementations.
- Task 10 depends on all implementation tasks.

## Risks
- `/Users/rutvik/rcode/pi-agents-view/context.md` was not present during planning; this plan is based on `plan.md` and the inspected repository. If that file contains additional constraints, re-run planning after adding it.
- Avoid persisting computed row summaries back into `state.json`; prefer attaching summaries in `loadRow` to prevent stale `review`/`diagnostics`/`followUps`/`steering` fields.
- Diagnostic/evidence details can contain sensitive prompt text, paths, or provider errors; Phase 0 includes basic key redaction, but downstream writers must still avoid storing secrets.
- The lock helper is a local filesystem advisory lock; it is suitable for the current file-backed store but should be re-evaluated if the store is placed on unusual network filesystems.
- Do not add event evidence extraction, queue draining, service reply queuing, dashboard UI, `/bg`, prompt wrappers, or stall detection in Phase 0; those belong to later phases.
- Explicitly avoid worktree safety changes: do not edit `src/core/worktree.mjs` or alter `src/runtime/service.mjs` dispatch/reply policy for worktrees in this phase.
