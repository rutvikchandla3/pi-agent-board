# Functional / reliability opportunities for Pi Agent Board

Reviewed sources: `IMPLEMENTATION_PLAN.md` (the requested `plan.md` path was not present), `progress.md`, `PRD.md`, `README.md`, `VERIFY.md`, `src/core`, `src/runtime`, `src/commands`, `src/ui`, `runner`, and `test`.

Validation run during review:

- `npm run typecheck` — passed.
- `npm test` — passed, 98/98 tests.

## Correct / strong foundation

- The repo has a clear file-backed architecture aligned with the implementation plan: detached runners, persisted store, dashboard polling, and resumable rows (`IMPLEMENTATION_PLAN.md:86-95`).
- Core store writes use temp-file + rename for JSON snapshots, which avoids half-written JSON reads (`src/core/atomic.mjs:28-42`).
- The test suite covers the reducer, row projection, runner integration with fake Pi, PTY socket protocol, PTY input/render helpers, store basics, and service actions; current checks are green.
- The PTY attach path includes meaningful UX and diagnostics: node-pty probing, fallback messaging, stale host counts, scrollback, link/copy support, and warm hosts (`src/runtime/service.mjs:677-695`, `src/ui/pty-attach.ts:145-158`).

## Highest-impact opportunities

### 1. Restore the same-repo writer safety contract

**Evidence**

- The PRD/plan lock same-repo writer safety as an MVP/product decision: “same-repo parallel writer sessions must require worktree isolation” (`PRD.md:13-23`) and “Same-repo parallel writer sessions require worktree isolation” (`IMPLEMENTATION_PLAN.md:46-56`).
- Current implementation explicitly disables worktree mode and always records `worktreeMode: "off"` (`src/runtime/service.mjs:360-405`).
- Tests now assert that explicit worktree requests are rejected and that two active sessions in the same repo are allowed (`test/service.test.mjs:233-255`).
- README documents the relaxed behavior: “does not auto-create worktrees and does not block ... same repo” (`README.md:61-62`).

**Impact**

This is the most direct safety gap: parallel coding agents can silently edit the same files in the same checkout, violating the product’s “safe parallelism” principle (`PRD.md:68-70`). Failures here are expensive: lost user work, confusing diffs, and hard-to-debug agent conflicts.

**Improvement**

Add an explicit writer policy before launch/reply:

- Track active write-capable sessions by `repoRoot`.
- If another write-capable session is active in the same repo, either block with a clear message or offer worktree isolation.
- Re-enable and test `src/core/worktree.mjs`; distinguish read-only tasks from write-capable tasks.
- Keep README/VERIFY aligned with the chosen policy.

### 2. Add per-session locking and transactional store updates

**Evidence**

- FR1 says each row maps to “zero or one live worker processes at a time” (`PRD.md:216-223`).
- `reply()` checks `row.alive` and then launches, but there is no atomic lock around that check/launch (`src/runtime/service.mjs:420-430`).
- `launchForView()` creates a new run and updates state without acquiring a per-view lock (`src/runtime/service.mjs:67-86`).
- Roster updates are read-modify-write without locking (`src/core/store.mjs:33-38`).
- Foreground/runner state projection preserves fields by reading the previous state immediately before writing, but a concurrent writer can still clobber fields such as `lastVisitedAt` (`runner/job-runner.mjs:69-73`, `src/runtime/service.mjs:284-290`).

**Impact**

Two dashboards, a hosted child, or two quick replies can launch concurrent workers against the same session file. Lost updates can also drop rows from the roster or erase visit/unread metadata. Atomic file writes prevent partial files, but they do not prevent stale read-modify-write overwrites.

**Improvement**

Introduce lightweight file locks or lease files:

- Per-view run lock: `views/<id>/run.lock` with owner pid, createdAt, heartbeat, stale recovery.
- Roster lock or append-only roster event log with compaction.
- Field-level merge helpers for state updates, especially `lastVisitedAt` and unread timestamps.
- Tests that spawn parallel `reply()`/`dispatch()` calls and assert only one worker per view and no lost roster entries.

### 3. Make PTY-hosted sessions self-finalizing even when child extension events fail

**Evidence**

- PTY dispatch launches a host and calls `markQueued(meta.id, null)`, leaving `currentRunId` null and `processState: "alive"` (`src/runtime/service.mjs:95-115`, `src/runtime/service.mjs:144-157`).
- `loadRow()` treats `state.processState === "alive"` as alive even with no current run pid (`src/core/store.mjs:174-186`).
- `reconcile()` skips rows with no `currentRunId` (`src/runtime/service.mjs:623-630`).
- `pty-runner` updates only `host.json` on normal child exit; it does not update the row `state.json` unless the hosted Pi child extension emitted/synced lifecycle events (`runner/pty-runner.mjs:124-129`).
- The PTY integration test validates host state and screen log only, not row semantic state finalization (`test/pty-runner.integration.test.mjs:52-73`).

**Impact**

If the hosted child extension is not loaded, crashes, or Pi changes event behavior, a PTY-launched row can remain `queued/alive` forever after the child exits. Because `currentRunId` is null, recovery will not fix it. This affects the default path when node-pty is available.

**Improvement**

Make `pty-runner` a lifecycle backstop:

- On normal child exit, if row state is still `queued`/`working` + `processState: alive`, finalize to `idle`/`failed`/`stopped` based on exit code and whether `stopping` was true.
- Persist a hosted-run id even for PTY launches, or teach `reconcile()` to handle host-backed active state with null `currentRunId`.
- Add tests where the fake PTY Pi never loads the extension and assert row state still exits correctly.

### 4. Harden host control messages with acknowledgements, timeouts, and stale-host cleanup

**Evidence**

- `sendHostMessage()` returns `{ ok: true }` immediately after scheduling a socket connection and swallows async socket errors (`src/runtime/service.mjs:730-740`).
- `reply()` sends input to a live host through that fire-and-forget path (`src/runtime/service.mjs:420-430`).
- `stop()` sends `interrupt` to hosted rows through the same fire-and-forget path (`src/runtime/service.mjs:438-445`).
- `attachTarget()` treats `hostAlive + socketPath` as attachable (`src/runtime/service.mjs:484-491`), while `hostAlive` is based on host state + pid, not socket existence or heartbeat freshness (`src/core/store.mjs:183-185`).

**Impact**

Replies, stops, and archives can be reported as successful even if the socket connect fails or the host is stale. Users can lose a reply with no feedback, and attach can get stuck on a dead socket path.

**Improvement**

Make the socket protocol request/response based:

- Include `requestId` and require `{type:"ack", requestId}` from `pty-runner`.
- Return a Promise with a short timeout for reply/stop/archive/terminate.
- If connect/ack fails, mark `host.json` stale and fall back to JSON runner or relaunch host.
- Consider `lastSeenAt` TTL and `existsSync(socketPath)` in `hostAlive`.

### 5. Improve JSON-runner “working” state and provider-hang handling

**Evidence**

- VERIFY documents a real failure mode where Pi JSON mode can hang after the user message when provider auth/network is broken (`VERIFY.md:34-48`).
- The reducer currently does not move the run to `working` on `agent_start`, `turn_start`, or user message events; it only updates `lastActivityAt` for start/end events (`src/core/events.mjs:118-122`).
- The JSON runner finalizes only on worker `close` (`runner/job-runner.mjs:148-158`).

**Impact**

In the known auth/network hang path, a row can remain visually `queued` rather than `running/stalled`, and it can remain there indefinitely unless the user manually stops it. This weakens observability exactly when users most need a diagnosis.

**Improvement**

- Treat `agent_start` / `turn_start` as `working` in `reduceEvent()`.
- Persist periodic runner heartbeats and a `stalled`/diagnostic field when no assistant/tool activity occurs for a configurable duration.
- Surface a row-level hint such as “waiting for provider response; verify `pi --mode json ...`” using the guidance already in `VERIFY.md`.
- Add reducer/runner tests for the documented `session → agent_start → turn_start → user message_end → hang` sequence.

### 6. Make stop/terminate semantics reliable and distinct from interrupt

**Evidence**

- README advertises `ctrl+s` as “stop” (`README.md:59`).
- For hosted rows, `service.stop()` sends `{ type: "interrupt" }`, not `terminate` (`src/runtime/service.mjs:438-445`).
- `pty-runner` implements `interrupt` by writing Escape to the child (`runner/pty-runner.mjs:181-183`).
- `killProcess()` says it terminates a process tree, but it signals only one pid (`src/core/pid.mjs:20-42`).

**Impact**

A user action labeled stop may only send Escape to the child TUI and may not stop the active agent turn. For JSON runners, killing only the monitor pid relies on the runner’s signal handler; if the monitor is wedged or child processes outlive Pi, work can continue hidden.

**Improvement**

- Separate commands: `interrupt current turn` vs `terminate host/session`.
- For stop, persist a stop intent, send graceful signal, then force the worker/host process group.
- Spawn workers/hosts in their own process group where supported and kill negative pids on POSIX.
- Update row state to `stopping`/`stopped` deterministically if termination succeeds.

### 7. Add first-class observability and audit trails

**Evidence**

- Several important paths catch and suppress errors: status update/reconcile (`src/index.ts:46-63`), foreground sync (`src/index.ts:83-91`), title generation (`src/runtime/service.mjs:124-141`), and host socket errors (`src/runtime/service.mjs:733-740`).
- Existing durable artifacts are useful but scattered: `events.jsonl`, `status.json`, stdout/stderr logs, `host.json`, `screen.log` (`src/core/paths.mjs:31-56`).

**Impact**

When a user sees a stuck row, lost reply, stale host, title failure, or provider hang, there is no single diagnostic trail explaining what happened. Silent catches protect the UI but reduce supportability.

**Improvement**

- Add per-view `audit.jsonl` or `diagnostics.jsonl` for service actions, launch decisions, socket failures, reconciliation changes, and suppressed exceptions.
- Add row-visible “last error / last action” metadata separate from semantic `error`.
- Add `agent-board doctor`/dashboard diagnostics view that checks provider one-shot health, PTY health, stale hosts, store permissions, and runner reachability.

### 8. Throttle title and summary model subprocesses

**Evidence**

- Job summaries are model-backed by default unless `AGENT_BOARD_SUMMARY_MODEL=off`; each terminal run can spawn another Pi process with a 15s timeout (`runner/job-runner.mjs:170-194`).
- Every dispatch queues detached title generation (`src/runtime/service.mjs:402-405`), and title generation also spawns a Pi one-shot with a 15s timeout (`runner/title-runner.mjs:25-35`).
- PRD says model summaries are a later improvement “with throttling” (`PRD.md:286-295`).

**Impact**

A batch of sessions can double or triple provider calls, hit rate limits, add cost, and create noisy failure modes when auth is partially configured. This is especially risky because summary/title work is auxiliary.

**Improvement**

- Add a bounded queue and concurrency limit for summary/title jobs.
- Prefer heuristic summaries by default until provider health is confirmed, or cache a global provider-health failure cooldown.
- Record title/summary attempts in diagnostics so users know why generated names did not appear.

### 9. Add retention, log rotation, and streaming readers

**Evidence**

- PTY output is appended unbounded to `screen.log` (`runner/pty-runner.mjs:118-123`).
- Attach replay reads the whole `screen.log` into memory and then slices the last 100k chars (`src/ui/pty-attach.ts:789-794`).
- Session transcript view reads the entire session file synchronously (`src/core/session-view.mjs:33-39`).
- JSON runner stdout/stderr/events are append-only (`runner/job-runner.mjs:88-120`).

**Impact**

Long-lived sessions and warm hosts can grow logs indefinitely, slow dashboard/attach, and fill disk under `~/.pi/agent/agent-board`. Synchronous full-file reads can make the TUI janky for large transcripts.

**Improvement**

- Rotate `screen.log`, stdout, stderr, and events by size/age.
- Implement “tail last N bytes” instead of `readFileSync(...).slice(-100_000)`.
- Stream or index session JSONL for transcript view; cap rendered items and expose “open full file” separately.
- Add cleanup/retention settings for archived rows.

### 10. Lock down terminal escape and click-to-open safety

**Evidence**

- Live PTY output forwards OSC52 clipboard writes by default unless `AGENT_BOARD_FORWARD_OSC52=0` (`src/ui/pty-attach.ts:770-776`, `src/ui/pty-attach.ts:908-912`).
- It also forwards image/file passthrough sequences by default unless `AGENT_BOARD_FORWARD_IMAGES=0` (`src/ui/pty-attach.ts:777-781`).
- OSC8 links from terminal output are opened via platform opener after only control-character sanitization (`src/ui/pty-attach.ts:869-885`, `src/ui/pty-attach.ts:1017-1026`, `src/ui/pty-attach.ts:1128-1130`).

**Impact**

Agent-controlled terminal output can write to the user clipboard or encourage/trigger opening arbitrary OSC8 targets. These features are useful but should be treated as privileged terminal passthrough.

**Improvement**

- Make OSC52/image forwarding opt-in, or prompt/allowlist per session.
- Restrict click-to-open to `http:`/`https:` by default; show confirmation for other schemes.
- On Windows, avoid `cmd /c start` for untrusted targets or strongly quote/validate the target.
- Add tests for disallowed schemes and OSC52 read/write behavior.

### 11. Protect store and control sockets with explicit permissions/auth

**Evidence**

- Default store root is under `~/.pi/agent/agent-board` (`src/core/paths.mjs:11-16`).
- `ensureDir()` creates directories with default process umask, not explicit `0700` (`src/core/atomic.mjs:18-21`).
- The PTY control socket accepts any local connector and handles input/resize/interrupt/terminate without an auth token (`runner/pty-runner.mjs:136-195`).

**Impact**

On multi-user systems or permissive umasks, local users/processes could inspect prompts/transcripts/logs or inject commands into a live session socket.

**Improvement**

- Create root/view/run directories with `0700` and files with `0600` where possible.
- Include a random per-host token in `host-config.json`; require it in the socket `hello` before accepting control messages.
- Consider placing sockets in a private runtime dir and/or chmodding socket files after listen.

### 12. Make node-pty a graceful optional capability at install time

**Evidence**

- Runtime has extensive node-pty fallback/diagnostics, but `node-pty` is a hard dependency in `package.json` (`package.json:75-77`).
- README promises non-live fallback and diagnostics when node-pty is unavailable (`README.md:45-47`, `README.md:75-80`).

**Impact**

If native `node-pty` install/build fails for a user’s platform, package installation can fail before the runtime fallback can help. This undermines the fallback design.

**Improvement**

- Move `node-pty` to `optionalDependencies` if Pi/npm packaging supports it.
- Ensure all imports of `node-pty` are dynamic/guarded.
- Keep `@xterm/headless` as normal dependency if attach rendering requires it, but allow JSON-runner mode without node-pty.

### 13. Align README/VERIFY with current keybindings and state model

**Evidence**

- README/VERIFY say users can type a task in the bottom input and press Enter (`README.md:51-53`, `VERIFY.md:75-78`). Current normal-mode printable input is rejected with a notice to press `i` first (`src/ui/dashboard.ts:316-348`), and the hints now advertise `i insert` (`src/ui/dashboard.ts:1144-1147`).
- VERIFY says `→`/`>` opens the non-interrupting live session view (`VERIFY.md:79-81`), while code maps `→`/`>` to attach and `v` to transcript/session view (`src/ui/dashboard.ts:316-323`, `src/ui/dashboard.ts:961-966`).
- VERIFY says a row moves `Queued → Running → Done` (`VERIFY.md:75-78`), while successful runner completion finalizes to `idle` until the user marks done (`src/core/derive.mjs:33-39`, `src/runtime/service.mjs:528-535`).

**Impact**

Manual verification can produce false failures, and first-time users may think dispatch is broken if typing does not enter the prompt. Docs drift also obscures which behavior is intended.

**Improvement**

- Update README/VERIFY for the current normal/insert-mode UX, or restore always-type dispatch behavior if that is still desired.
- Make the state transition docs say `Queued → Running → In Progress` unless `d` marks Done.
- Add a small dashboard smoke test around normal-mode printable input, `i` insert, `v`, and `→` mappings.

### 14. Expand reliability tests around the real failure modes

**Evidence**

- Existing tests are green and useful, but some risky paths are not exercised: PTY row finalization fallback (`test/pty-runner.integration.test.mjs:52-73`), launch option resolution (no `resolveLaunchContext` references in `test/`), concurrent store updates, stale sockets, and provider-hang sequences.
- Current service tests explicitly encode the relaxed same-repo behavior (`test/service.test.mjs:233-255`).

**Impact**

The highest-risk lifecycle and safety regressions can slip through because the suite is strongest on pure reducers/helpers and happy-path fake runners.

**Improvement**

Add targeted tests for:

- Provider/auth hang event sequence and stalled-row diagnosis.
- PTY child exits without hosted extension events.
- Socket command connect failure / missing ack / stale socket cleanup.
- Concurrent `reply()` and `dispatch()` from two service instances.
- Worktree isolation/blocking policy.
- Launch dialog model/thinking scoped settings.
- Store permission mode and token-authenticated socket control.

## Extensibility direction

The current service chooses between PTY host and JSON runner inline (`src/runtime/service.mjs:402-404`), while the original architecture is described as a detached JSON runner model (`IMPLEMENTATION_PLAN.md:86-95`). To keep future `/bg`, daemon mode, remote runners, or worktree runners manageable, consider extracting an execution-backend interface:

- `startRun(view, prompt, opts) -> RunHandle`
- `sendInput(handle, text) -> ack`
- `interrupt(handle) -> ack`
- `terminate(handle) -> ack`
- `observe(handle) -> status/events`
- `recover(view) -> status`

Then implement `JsonRunnerBackend` and `PtyHostBackend` behind the same lifecycle contract. This would also make state finalization, locking, observability, and tests consistent across execution modes.
