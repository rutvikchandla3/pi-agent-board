# Progress Log — Pi Agent View Extension

Living checkpoint log. Newest checkpoint at top. Records what's done, workarounds, and
nuances future agents must know. Pairs with `docs/EXPLORATION.md` (the Pi API gist).

Status legend: ☐ todo · ◐ in progress · ☑ done

---

## Milestone status

- ☑ **M0** scaffold + primitives (paths, types, atomic IO, ids, pid)
- ☑ **M1** detached runner (`job-runner.mjs`) + durable store + dispatch + event reduce
- ☑ **M2** dashboard list + grouping + filters + live poll
- ☑ **M3** peek + reply
- ☑ **M4** attach / attach-while-running confirm / recovery (reconcile) / stop / rename / pin
- ☑ **M5** repo safety + worktree mode (same-repo writer rule wired into dispatch)
- ☑ tests: 45/45 green · typecheck 0 errors · extension loads in real pi
- ⚠️ **Blocked on env:** live end-to-end (real worker producing output) needs pi provider auth
  in this environment; see CP2 + `VERIFY.md`. Code paths validated hermetically.

---

## Checkpoint log

### CP4 — 2026-05-31 — fast non-live attach via warm PTY hosts
- Non-live attach now uses the same Agent View PTY host path as live sessions. `ctx.switchSession`
  remains only as a no-PTY fallback, with a fullscreen switching overlay so the previously
  attached session is not visible during fallback startup.
- Added `ensureHost()` / dashboard prewarm: selected idle/completed sessions are lazily started
  as interactive PTY hosts with `initialPrompt: null`, without mutating row task state. Warm
  attach should be instant; cold attach immediately swaps to the attach surface and retries the
  socket until the host is ready.
- Kept completed hosts warm instead of terminating them immediately. Warm pool defaults:
  `AGENT_VIEW_MAX_WARM_HOSTS=4`, `AGENT_VIEW_WARM_HOST_TTL_MS=600000`.
- Fixed PTY detach flow: `ctrl+]`, `ctrl+g`, or `←` from a live attach returns to the dashboard
  loop instead of revealing the original session where `/agents` was invoked.
- Added internal scrollback controls for PTY attach surfaces: mouse wheel, `pgup` / `pgdn`,
  `home`, `end`. Scrolling uses an agent-view-owned absolute viewport and clamps at top/bottom
  so fast wheel events cannot wrap back to the bottom. Normal arrow keys still pass through.
- Verification: `npm run typecheck` clean; `npm test` 55/55 green.

### CP3 — 2026-05-30 — standalone-ish dashboard UX
- Added a full-screen **session view** inside `/agents`: **v** opens the selected row's
  live transcript from its managed session file without interrupting the worker; **← / <**
  returns to the dashboard. **→ / >** now attaches to the real Pi session, matching the
  primary agent-view navigation expectation. **enter** also attaches. In an attached managed
  session, **←** from an empty input reopens agent view directly using the command-capable
  replacement context (no slash-command text injection).
- Added `src/core/session-view.mjs` to parse managed Pi session JSONL files and project the
  active branch into a readable transcript surface (messages, visible custom messages,
  compactions, branch summaries).
- Changed the main dashboard UX to match the Claude-style screenshot more closely: the bottom
  input is always available, typing there and pressing **Enter** dispatches a new Pi session,
  and **Enter** on an empty input attaches to the selected session.
- Added `--agent-view` via `pi.registerFlag("agent-view")`; on `session_start(reason:"startup")`
  the extension now opens the dashboard **directly** from the startup event with hidden Pi
  header/footer chrome, so users can launch with `pi --agent-view` into a cleaner fullscreen
  surface. Quitting that dashboard exits Pi instead of dropping into a chat session.


### CP2 — 2026-05-30 — full MVP wired (M2–M5) + ⚠️ real-worker hang found
- Built the Pi-coupled layer: `src/runtime/service.mjs` (dispatch/reply/stop/pin/rename/
  archive/reconcile + same-repo worktree safety), `src/ui/dashboard.ts` (one `ctx.ui.custom`
  component: list/peek/reply/dispatch/filter/rename/confirm/help modes, live 700ms poll, scroll),
  `src/commands/agents.ts` (`/agents` command + action loop + attach via `ctx.switchSession`),
  `src/index.ts` (entry: command, footer status, session_start recovery),
  root `index.ts` (re-export for auto-discovery).
- **`npx tsc --noEmit` = 0 errors** against the real Pi `.d.ts` (path-mapped). **45/45 tests pass.**
- **Smoke: `pi --list-models -e src/index.ts` loads the extension cleanly** (factory + all imports
  resolve under pi's jiti, exit 0).
- **⚠️ REAL-WORKER HANG (env auth, not a bug):** running the real `pi` worker through the runner
  (and `pi --mode json -p` directly) **blocks at the provider request** — emits up to the *user*
  `message_end` then nothing (no assistant reply, no `agent_end`, no exit; idle 3% CPU). Cause:
  pi has no working provider auth/network in this non-interactive context (pi auth ≠ Claude
  Code `/login`). The credential-scan probe was (correctly) blocked by the sandbox classifier.
  Extension behaves correctly: row stays `working` until stopped. **To validate live dispatch,
  pi itself must be authed** — see `VERIFY.md`. Hermetic fake-pi tests prove the runner pipeline.
- **Change (user):** default summary model → **`gpt-4o`** (was claude-haiku-4-5). Still ON by
  default, heuristic fallback retained. Needs OpenAI auth or it falls back.
- **UX fix (nuance):** runner now persists the terminal state (heuristic summary) **immediately**
  on worker close, *then* upgrades the summary via the model (15s timeout) and re-persists — so a
  slow/unreachable summary model can't delay a row flipping to `completed`.


### CP0 — 2026-05-30 — recon done, scaffolding started
- Read full Pi API (extensions, tui, sessions, json, session-format) + subagent/plan-mode
  examples + dist type defs. Findings distilled into `docs/EXPLORATION.md` (read that first).
- **Decisions locked for impl** (see EXPLORATION §8): detached `.mjs` runner spawns
  `pi --mode json -p --session <file> "<prompt>"`; dashboard is one `ctx.ui.custom` component;
  heuristics are the default summarizer (model summary opt-in); attach = `ctx.switchSession`.
- **Workaround/nuance:**
  - Node 24 runs `.ts` directly (type-stripping) ⇒ unit tests need no build step; write
    pure-logic modules with only `node:*` imports so `node --test` can run them.
  - **Avoid `typebox`**: MVP has no LLM-facing tool; `/agents` is a command. Store schemas are
    plain TS interfaces (erasable), not typebox — keeps modules node-testable & dep-free.
  - Pi packages aren't in this repo's node_modules; they're resolved by Pi's jiti at runtime.
    For local typecheck only, `tsconfig.json` path-maps `@earendil-works/*` to the global
    install. Runtime needs no install.
  - Verification can't use a TTY/API key here ⇒ integration test runs the real runner against
    a **fake pi** stub (`test-support/fake-pi.mjs`) that prints canned JSON event lines.

---

### CP1 — 2026-05-30 — core brain + runner green (M0+M1)
- Wrote `src/core/*.mjs`: paths, ids, atomic, types, heuristics, derive, events, pid, store,
  repo, worktree, launch, invocation, rows. All pure node, JSDoc-typed.
- Wrote `runner/job-runner.mjs` (detached monitor) + `test-support/fake-pi.mjs` (hermetic
  worker stub) + 7 test files. **`node --test` → 45/45 pass.** Validates dispatch→events→
  status/state→finalize, needs_input/failed/stopped classification, and durable artifacts,
  all without an API key or TTY.
- **Design fix (nuance):** `latestAssistantPreview` now stores the *full* latest assistant text
  (truncated 240) so peek shows real output; `deriveSummary()` condenses it to a first sentence
  (falling back to full text if the 1st sentence is <12 chars, e.g. "Done."). Don't re-conflate.
- **Change per user:** cheap-model summary is now **ON by default** (`DEFAULT_SUMMARY_MODEL=
  claude-haiku-4-5` in the runner), heuristic kept as graceful fallback (no-key/offline/timeout)
  and for state detection. Disable with `AGENT_VIEW_SUMMARY_MODEL=off`; override with a model id.
  Tests set it `off` so the fake worker's stream doesn't get re-summarized.
- **Invocation nuance:** `src/core/invocation.mjs` resolves how to spawn pi (node+cli.js vs
  compiled binary vs `pi` on PATH) — mirrors the subagent example. Runner runs under real `node`.
- **pid nuance:** `pid.json` holds the *runner/monitor* pid (parent polls it for liveness);
  `status.json.pid` holds the *worker* pid. `isAlive` treats EPERM as alive.

## Known risks / open items
- `ctx.ui.custom` full-screen height: drive off `tui.terminal.rows`; verify scrolling math.
- Worktree edge cases (dirty repo, cleanup) — M5; ship strict single-writer rule first.
- Model summarizer spawns a pi process per summary — must throttle; default off.
