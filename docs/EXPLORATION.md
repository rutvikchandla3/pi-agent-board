# Exploration & Decisions — Pi Agent Board Extension

**For future agents.** This is the distilled gist of the codebase recon done before
implementing `IMPLEMENTATION_PLAN.md`. Read this first; it saves re-deriving the Pi API.

Runtime target: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` (v0.75.5).
`pi` binary is on PATH at `/opt/homebrew/bin/pi` → `dist/cli.js`.

---

## 1. How a Pi extension is loaded & shaped

- An extension is a TS module: `export default function (pi: ExtensionAPI) { ... }`
  (may be `async`; Pi awaits it before `session_start`).
- Auto-discovered from `~/.pi/agent/extensions/*.ts` or `<name>/index.ts` (global) and
  `.pi/extensions/...` (project). `/reload` hot-reloads them. `pi -e ./path.ts` for quick tests.
- Pi's loader (jiti) resolves `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui`, `typebox` **for you at runtime** — you do not bundle them.
  For local typechecking we path-map those to the global install (see `tsconfig.json`).
- Loaded TS runs via jiti. **Detached external processes (our runner) must NOT rely on
  jiti** → the runner is a plain `.mjs` that we spawn with `node`.

## 2. ExtensionAPI surface we actually use

- `pi.registerCommand(name, { description, handler(args, ctx), getArgumentCompletions? })`
  — handler `ctx` is `ExtensionCommandContext` (adds `newSession/fork/switchSession/
  navigateTree/reload/waitForIdle`). Session-switch methods deadlock from event handlers,
  so they exist only on command ctx.
- `pi.registerShortcut(KeyId, { description, handler(ctx) })`.
- `pi.registerFlag(name, { description, type:"boolean"|"string", default })` + `pi.getFlag`.
- `pi.exec(cmd, args, { signal, timeout })` → `{ stdout, stderr, code, killed }`.
- `pi.appendEntry(customType, data)` persists extension state into the session JSONL
  (custom entry, not sent to LLM). Restore by scanning `ctx.sessionManager.getEntries()`.
- `ctx.ui.*`: `select/confirm/input/editor/notify`, `setStatus/setWidget/setFooter`,
  and **`custom<T>(factory, opts?) => Promise<T>`** (the dashboard surface).
- `ctx.switchSession(path, { withSession })` — attach = switch the interactive session to
  a managed session file. `withSession(ctx)` runs **after** the old runtime is torn down;
  only use the fresh `ctx` passed in, never captured old `pi`/`ctx`/`sessionManager`.

### `ctx.ui.custom` (the important one)
```ts
const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) => {
  // return a Component: { render(width): string[]; invalidate(); handleInput?(data) }
  // call tui.requestRender() after state changes to repaint
  // call done(value) to close the surface and resolve the promise
});
```
- It **replaces the editor** with your component until `done()` (full-screen-ish surface).
- It returns a `Promise`, NOT a handle. Live updates: hold a `tui` ref, call
  `tui.requestRender()` from a `setInterval`/file-watch/poll loop. Terminal height =
  `tui.terminal.rows`, width comes in as the `render(width)` arg.
- `{ overlay: true, overlayOptions }` renders a floating modal instead (used for peek/dialogs
  if we want; MVP keeps peek as an internal mode of the dashboard component).

## 3. TUI building blocks (`@earendil-works/pi-tui`)

Components implement `{ render(width:number):string[]; invalidate():void; handleInput?(data):void }`
— each rendered line **must not exceed `width`** (use `truncateToWidth`).
Exports we use: `Text, Box, Container, Spacer, Markdown, SelectList, SettingsList,
matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component`.
From coding-agent: `DynamicBorder, BorderedLoader, getMarkdownTheme, getSettingsListTheme,
keyHint`. Theme: `theme.fg(color, text)`, `theme.bold/italic/strikethrough`.
Key input: `matchesKey(data, Key.up)` etc. After state change in `handleInput`, call
`tui.requestRender()`.

## 4. Sessions & the headless worker (the core mechanism)

- Session files are JSONL trees (`id`/`parentId`); first line is a header
  `{"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"<cwd>"}`.
- **Launching a managed run:**
  `pi --mode json -p --session <file> "<prompt>"`, spawned with `cwd: <repo|worktree>`.
  - `--session <path>` with a path that contains `/` or ends `.jsonl` → `SessionManager.open(path)`.
    If the file **doesn't exist**, Pi creates a fresh session and persists to that **exact path**
    (verified in `dist/core/session-manager.ts` `open()` → `setSessionFile` else-branch).
    The header `cwd` becomes the spawn `cwd`, so always set `cwd` correctly.
  - `--mode json` = one-shot: it `session.subscribe((e)=>stdout(JSON.stringify(e)+"\n"))`,
    runs the single prompt to completion (a full agent loop, many turns/tools), then exits
    **with `agent_end` as the last event** — `worker.on("close")` is the run-finished signal.
  - **⚠️ AUTH/NETWORK CAVEAT (verified 2026-05-30):** the one-shot exits cleanly *only when the
    worker can actually reach the model provider*. With no/blocked pi provider auth (or a
    network/proxy stall), `pi --mode json -p` records `session → agent_start → turn_start →
    message_start(user) → message_end(user)` and then **blocks indefinitely at the provider
    request** (idle, ~3% CPU) — **no assistant reply, no `agent_end`, no process exit**. This is
    a pi/runtime condition, NOT an extension bug. The runner handles it correctly: the row stays
    `working/alive` until the user stops it (`s` in the dashboard → SIGTERM → finalized `stopped`).
    Note: pi's own provider auth is separate from Claude Code's `/login`. Validate with
    `pi --mode json -p --no-session "say hi"` — it must print events ending in `agent_end` and exit.
  - `-p` forces non-interactive. `--model <m>`, `--tools a,b`, `--append-system-prompt <file>`
    are available. `--no-session` = ephemeral (we do NOT use it for managed rows; we want persistence).
- Reply / resume = launch another run against the **same** `--session <file>`; Pi appends to it.

### JSON event vocabulary actually emitted (parse these in the runner)
First line: the session header `{type:"session",...}`. Then per `AgentSessionEvent`:
`agent_start`, `agent_end`, `turn_start`, `turn_end`,
`message_start` / `message_update` / `message_end` (each has `.message`: an AgentMessage),
`tool_execution_start` `{toolCallId,toolName,args}`,
`tool_execution_update` `{...,partialResult}`,
`tool_execution_end` `{toolCallId,toolName,result,isError}`,
`tool_call`, `tool_result`, plus `queue_update`, `compaction_*`, `auto_retry_*`,
`model_select`, `thinking_level_*`, `session_*`.
> NOTE: the subagent example reads `tool_result_end` — that string is **never emitted** (dead
> defensive code). Use `message_end` (role assistant → text/toolCalls/usage/stopReason/errorMessage)
> and `tool_execution_start/end` for live state. `agent_end` ⇒ run finished.

AssistantMessage shape: `{ role:"assistant", content:(TextContent|ThinkingContent|ToolCall)[],
model, usage, stopReason:"stop"|"length"|"toolUse"|"error"|"aborted", errorMessage? }`.
ToolCall content block: `{ type:"toolCall", id, name, arguments }`.

## 5. Architecture chosen (matches plan §3.3) — file-backed detached runner

```
Pi extension (parent, interactive)         runner/job-runner.mjs (detached, 1 per run)
  /agent-board dashboard (ctx.ui.custom)   ─►   spawns: pi --mode json -p --session <file> <prompt>
  store reader/writer                       parses JSON event lines from worker stdout
  launches runner via child_process         writes runs/<runId>/{status.json,events.jsonl,
  polls store files to repaint                stdout.log,stderr.log,pid.json}
                                            updates views/<id>/state.json on progress/exit
```
Why detached `.mjs` runner (not spawn pi directly from the extension, not a daemon):
survives parent `/reload`/exit, durable status, no socket/daemon complexity. Each run is the
durable monitor for one worker.

### Store layout (user-scoped) — `~/.pi/agent/agent-board/`
```
roster.json                      { version, views: [viewId...] }
views/<viewId>/meta.json         stable: id,name,cwd,sessionFile,createdAt,pinned,kind,
                                 worktreeMode,worktreePath,defaultModel,source,archived
views/<viewId>/state.json        derived: currentRunId,semanticState,processState,summary,
                                 needsInput,hasError,latestAssistantPreview,latestTool,lastActivityAt
views/<viewId>/runs/<runId>/status.json   per-run durable snapshot (pid,startedAt,endedAt,
                                 exitCode,semanticState,currentTool,latestAssistantPreview,question,error)
views/<viewId>/runs/<runId>/{events.jsonl,stdout.log,stderr.log,pid.json}
sessions/<viewId>.jsonl          the managed Pi session file (Pi creates/persists it)
```
- One row = one real Pi session file. One run = one detached worker against it.
- Both `state.json` (row, long-lived) and `status.json` (run, single attempt) exist so
  reply/resume/attach stay clean.
- Atomic writes: write tmp + `rename`. Liveness: `pid.json` + `process.kill(pid,0)`.

## 6. State derivation rules (plan §9)

Semantic: `queued`→`working` (alive, once assistant/tool activity); on clean exit
`needs_input` (assistant ends asking) | `completed` | `idle`; on bad exit `failed`;
user-stopped `stopped`. Process: `alive` if pid live else `exited`.
Summary priority: model-summary(opt-in) → active tool (`Editing x`,`Running tests`) →
blocker/question → first sentence of latest assistant → stderr/error → fallback status.
Needs-input heuristic: assistant text ends in `?` or contains `need your input`/
`which option`/`should I`/`please confirm`.

## 7. Safety / worktree (plan §11)

Same-repo parallel **writers** require git worktree isolation (locked decision). MVP:
explicit `worktreeMode:"worktree"` per dispatch → `git worktree add` under
`~/.pi/agent/agent-board/worktrees/<viewId>`; persist `worktreePath`; block a 2nd active
writer in the same repo if not isolated. Delete row ≠ delete data: archive row, keep
session file; worktree removal needs explicit confirm.

## 8. Decisions made for this implementation

1. **Runner is `runner/job-runner.mjs` (plain ESM)**, spawned with `node`. It imports only
   `node:*`. The pi binary it spawns is passed in via run-config (`piBin`, default `"pi"`).
2. **Extension code is TS**, loaded by Pi via jiti. We add `package.json` + `tsconfig.json`
   only for local typecheck/tests (path-mapped to the global pi install); not needed at runtime.
3. **Summaries: cheap model is the DEFAULT** (`DEFAULT_SUMMARY_MODEL = "gpt-4o"` in the runner;
   user choice 2026-05-30), with the **heuristic kept as a graceful fallback** (no API key /
   offline / timeout) and still used for live state detection (needs-input, semantic state).
   Override with `AGENT_BOARD_SUMMARY_MODEL=<model>`, disable with `=off`. The summary call has a
   15s safety timeout and runs *after* the heuristic terminal state is already persisted, so a
   slow/unreachable summary model never stalls the dashboard (row flips to final state at once,
   summary upgrades a few seconds later). gpt-4o needs OpenAI auth; without it → heuristic.
4. **Dashboard = single `ctx.ui.custom` component** owning list + peek + dispatch input as
   internal modes (plan §10.4 recommendation). Live updates via a poll loop calling
   `tui.requestRender()` (store files are the source of truth; cheap to re-read).
5. **Attach = `ctx.switchSession(sessionFile, { withSession })`** from the `/agent-board` command
   handler. If the row's run is alive → confirm interrupt (stop run) then attach (locked decision).
6. **Verification without a TTY/API key:** unit tests for all pure logic + an integration test
   that runs the real `.mjs` runner against a **fake `pi`** stub script emitting canned JSON
   event lines, asserting the durable store artifacts. (`test-support/fake-pi.mjs`.)

## 9. Gotchas

- `ctx.ui.custom` callback's component must return lines ≤ width; always `truncateToWidth`.
- Rebuild themed content on `invalidate()` (theme change) if you pre-bake `theme.fg(...)`.
- Don't import `pi-subagents/src/...` internals (unstable) — reference only.
- Session-switch `withSession` runs post-teardown; capture only plain strings/ids.
- The runner must update `status.json` atomically and frequently but throttled (avoid fs thrash).
- `process.kill(pid, 0)` throws ESRCH if dead, EPERM if alive-but-not-ours → treat EPERM as alive.
