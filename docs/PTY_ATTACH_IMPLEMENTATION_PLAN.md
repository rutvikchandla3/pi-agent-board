# Implementation Plan: PTY-backed Live Attach

**Status:** Proposed / spike-ready  
**Goal:** make attaching to a live agent-board row feel like attaching to the same normal Pi session, without interrupting the running work.  
**Created:** 2026-05-31

## 1. Decision

The previous `SessionClient`/RPC idea is clean, but it will not be 1:1 with normal Pi unless we reimplement or refactor a lot of interactive Pi UI behavior.

For a 1:1 user experience, invert the design:

> A background row should be hosted by a real interactive Pi process running inside a PTY. Attach should connect the user to that live PTY, not recreate Pi UI over RPC.

Current MVP keeps a detached one-shot JSON worker:

```text
Dashboard
  └─ job-runner.mjs
      └─ pi --mode json -p --session <file> <prompt>
          ├─ emits JSON events
          ├─ writes session file
          └─ exits after the prompt finishes
```

Target live-attach model:

```text
Dashboard
  └─ pty-runner.mjs
      ├─ control.sock
      ├─ host.json
      └─ PTY
          └─ pi --session <file> <initial prompt>
              ├─ real interactive Pi TUI
              ├─ real slash commands/keybindings/extensions
              ├─ writes same session file
              └─ stays alive until explicitly closed
```

## 2. Critical exploration findings

### Existing code that helps

- `src/runtime/service.mjs` already owns dispatch/reply/stop/archive and same-repo worktree safety.
- `runner/job-runner.mjs` already demonstrates detached durable process ownership.
- Store layout under `~/.pi/agent/agent-board/` is sound: `views/<id>/meta.json`, `state.json`, per-run artifacts, session file per row.
- `src/index.ts` already mirrors foreground session events into managed row state via `service.syncForegroundEvent(...)`.
- `src/commands/agent-board.ts` already owns attach and back-to-dashboard behavior.
- `src/ui/dashboard.ts` already has list/peek/reply/session modes and can add a new attach mode/result.

### Important mismatch in current state model

`Row.alive` currently means “the current managed run pid is alive” and is also overloaded for foreground mirrored activity.

For PTY hosting we need two separate concepts:

1. **host liveness** — is the interactive Pi PTY process alive and attachable?
2. **agent activity** — is the agent currently processing/streaming/tooling?

A PTY-hosted row can be:

```text
host: alive
agent activity: idle/completed/needs_input
```

That should still be directly attachable without fallback resume.

### Biggest technical caveat

Pi extension `ctx.ui.custom()` renders line-based components. It does **not** expose a documented raw terminal takeover API.

Therefore there are three implementation options:

| Option | Description | 1:1 fidelity | Fits extension-only? | Recommendation |
|---|---|---:|---:|---|
| A | PTY + terminal emulator component (`xterm-headless` style) | high, not perfect | yes | try first |
| B | Pi core raw terminal takeover API | highest | requires Pi core change | later if needed |
| C | standalone/tmux-like external agent-board CLI | highest | separate CLI, not pure `/agent-board` | fallback |

This plan attempts **Option A** first because it preserves the extension flow and avoids rebuilding the agent protocol/UI. It runs real Pi, captures its PTY output, and renders a virtual terminal buffer inside `ctx.ui.custom()`.

## 3. Target architecture

```text
              ┌──────────────────────────────┐
              │ Parent Pi / /agent-board dashboard │
              └──────────────┬───────────────┘
                             │ dispatch
                             ▼
┌────────────────────────────────────────────────────────────┐
│ pty-runner.mjs                                              │
│                                                            │
│  host.json         durable host status                      │
│  control.sock      IPC for attach/input/resize/stop         │
│  screen.log        optional raw PTY output log              │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ PTY                                                  │   │
│  │  └─ pi --session <managed.jsonl> <initial prompt>     │   │
│  │      └─ real Pi interactive TUI                       │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                             ▲
                             │ child extension events write row state
                             │ AGENT_BOARD_ROOT / AGENT_BOARD_VIEW_ID
                             │
              ┌──────────────┴───────────────┐
              │ agent-board extension in child │
              │ mirrors agent/tool/message    │
              │ events to state.json          │
              └──────────────────────────────┘
```

Attach path:

```text
User presses Enter on live row
  ├─ if host socket alive:
  │    open PtyAttachComponent
  │    connect to control.sock
  │    replay PTY snapshot/log into virtual terminal
  │    forward keyboard input to PTY
  │    intercept detach chord only
  │
  └─ else:
       fallback to existing ctx.switchSession(sessionFile)
```

## 4. Store/data model changes

### 4.1 Add host status file

New path helpers in `src/core/paths.mjs`:

```js
hostPath(root, viewId)       // views/<viewId>/host.json
controlSocketPath(root,id)   // views/<viewId>/control.sock
screenLogPath(root,id)       // views/<viewId>/screen.log
```

New shape in `src/core/types.mjs`:

```ts
type HostMode = "json-runner" | "pty";
type HostState = "starting" | "alive" | "exited" | "failed";

interface HostStatus {
  version: 1;
  viewId: string;
  mode: HostMode;
  runnerPid: number | null;
  childPid: number | null;
  socketPath: string | null;
  state: HostState;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: string | null;
  cols: number;
  rows: number;
  attachedClients: number;
}
```

### 4.2 Extend `Row`

In `src/core/store.mjs`, `loadRow()` should return:

```ts
interface Row {
  meta: ViewMeta;
  state: ViewState | null;
  alive: boolean;      // current agent activity/run alive, legacy-compatible
  hostAlive: boolean;  // PTY host/socket alive and attachable
  host: HostStatus | null;
}
```

Dashboard row labels should distinguish:

```text
● working       agent active
◌ hosted        Pi process alive but idle
✓ completed     completed, host may still be alive
```

## 5. Runner changes

### 5.1 Keep current JSON runner as fallback

Do not delete `runner/job-runner.mjs`. Keep it for:

- tests,
- non-PTY fallback,
- environments where `node-pty` cannot install,
- comparison/debugging.

### 5.2 Add `runner/pty-runner.mjs`

Responsibilities:

1. read `HostConfig` from JSON file,
2. create/remove stale socket,
3. spawn real interactive Pi in a PTY,
4. write `host.json`,
5. expose control socket,
6. append raw PTY output to `screen.log`,
7. broadcast output to attached clients,
8. accept input/resize/stop commands,
9. finalize host status on exit.

Proposed host config:

```ts
interface HostConfig {
  root: string;
  viewId: string;
  sessionFile: string;
  cwd: string;
  initialPrompt: string | null;
  piCommand: string;
  piArgsPrefix: string[];
  model: string | null;
  tools: string | null;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
```

Spawn args:

```js
const args = [
  ...piArgsPrefix,
  "--session", sessionFile,
];
if (model) args.push("--model", model);
if (tools) args.push("--tools", tools);
if (initialPrompt) args.push(initialPrompt);
```

Environment injected into child Pi:

```text
AGENT_BOARD_ROOT=<root>
AGENT_BOARD_VIEW_ID=<viewId>
AGENT_BOARD_CHILD=1
AGENT_BOARD_HOSTED=pty
```

`AGENT_BOARD_CHILD=1` lets the extension avoid dashboard-first startup behavior and any recursive agent-board UI side effects inside hosted children.

### 5.3 Control socket protocol

Use JSONL messages over a Unix socket.

Client → runner:

```json
{"type":"hello","clientId":"...","wantOutput":true}
{"type":"input","data":"raw terminal bytes"}
{"type":"resize","cols":120,"rows":36}
{"type":"detach","clientId":"..."}
{"type":"interrupt"}
{"type":"terminate"}
{"type":"get_status"}
```

Runner → client:

```json
{"type":"hello","status":{...}}
{"type":"output","data":"raw terminal bytes"}
{"type":"status","status":{...}}
{"type":"exit","exitCode":0}
{"type":"error","message":"..."}
```

For attach, the parent sends raw input bytes through `input`. The only intercepted key should be the detach chord.

Recommended detach chord for spike: `ctrl+]`, because it is already an editor jump key but less commonly needed than arrows/escape/enter. Make it configurable later.

## 6. Attach UI design

### 6.1 Option A: virtual terminal component

Add `src/ui/pty-attach.ts`:

```ts
export class PtyAttachComponent implements Component {
  // connects to control.sock
  // feeds output into terminal emulator buffer
  // renders buffer lines via ctx.ui.custom
  // forwards input to socket
  // sends resize from tui.terminal rows/cols
  // done({ action: "detached" }) on detach chord
}
```

Potential dependency choices:

- `node-pty` for PTY creation in runner,
- `xterm-headless` or equivalent for terminal emulation in attach component.

If adding dependencies, update `package.json` `dependencies`, not `devDependencies`, because Pi package installs use production deps.

Expected fidelity:

- normal Pi input behavior: high, because real Pi receives real terminal bytes,
- normal Pi visual behavior: high for text UI,
- possible gaps: inline images, OSC hyperlinks, exact hardware cursor/IME, mouse support.

### 6.2 Option B: raw takeover API if Option A is insufficient

If virtual rendering cannot meet expectations, propose a Pi core API:

```ts
ctx.ui.rawTerminalSession(async ({ input, output, resize, restore }) => {
  // parent TUI suspends rendering
  // extension proxies bytes to/from child PTY
});
```

This would give true terminal proxy behavior, but requires Pi core work outside this extension.

## 7. Extension changes

### 7.1 `src/index.ts`

Current extension mirrors events for any managed foreground session. Adjust it for hosted child processes:

- if `process.env.AGENT_BOARD_CHILD === "1"`, skip `--agent-board` dashboard auto-open handling,
- still register event listeners,
- when `AGENT_BOARD_VIEW_ID` is present, mirror events directly to that row,
- keep footer status disabled/no-op in child to avoid confusing nested hosted Pi.

Potential helper:

```ts
const hostedViewId = process.env.AGENT_BOARD_VIEW_ID;
const isHostedChild = process.env.AGENT_BOARD_CHILD === "1";
```

### 7.2 `src/runtime/service.mjs`

Add methods:

```js
launchHost(meta, initialPrompt)
ensureHost(viewId)
attachTarget(viewId) // { kind: "pty", socketPath } | { kind: "session", sessionFile }
stopActivity(viewId) // sends interrupt to socket if hosted, else current stop
terminateHost(viewId)
injectReply(viewId, text) // if host alive, paste/submit into PTY; else fallback launch one-shot/host
```

Dispatch flow becomes:

```text
createView
launchHost(meta, prompt)
state = queued/working once child extension events arrive
```

Reply flow:

```text
if hostAlive:
  send text + Enter to PTY
else:
  launchHost(existingMeta, text) or existing JSON reply fallback
```

Stop flow needs two actions:

- **interrupt active agent**: send Escape or RPC-like interrupt if available,
- **kill hosted Pi**: terminate PTY runner and child process.

Existing `ctrl+s stop` should initially mean “interrupt/stop active work”; add a separate confirm for killing host if needed.

### 7.3 `src/commands/agent-board.ts`

Change attach decision:

```ts
if (row.hostAlive) {
  openPtyAttach(ctx, row)
} else if (row.alive) {
  existing confirm interrupt + switchSession fallback
} else {
  ctx.switchSession(row.meta.sessionFile, ...)
}
```

`openPtyAttach` should return to the dashboard without switching sessions.

### 7.4 `src/ui/dashboard.ts`

Update row rendering:

- show host-alive indicator,
- attach hint says `enter attach live` when `hostAlive`,
- running row no longer always asks “Interrupt and attach?” if host socket exists,
- session read-only view remains useful as non-interrupting transcript.

## 8. Worktree/safety implications

Existing same-repo writer worktree isolation remains valid.

PTY-hosted sessions make the isolation rule more important because hosts can stay alive after task completion. Active writer detection should consider:

```text
hostAlive && writeCapable && worktreeMode !== "worktree"
```

However, an idle hosted process may not be writing. For MVP, be conservative:

- if another non-worktree host is alive in the same repo, force worktree for new write-capable dispatch,
- later refine by checking `state.semanticState === "working"`.

## 9. Testing plan

### 9.1 Unit tests

Add tests for:

- host path helpers,
- host status read/write,
- `loadRow().hostAlive`,
- service attach target selection,
- hosted vs fallback reply behavior,
- child event mirroring does not mark idle host as dead.

### 9.2 Runner integration tests

Add fake interactive child script:

```text
test-support/fake-pty-pi.mjs
```

It should:

- write recognizable ANSI output,
- accept stdin,
- echo prompts,
- simulate busy/idle states through environment or marker files,
- exit on a command.

Test `pty-runner.mjs`:

- creates socket and host.json,
- broadcasts PTY output,
- forwards input,
- handles resize,
- finalizes on child exit,
- kills child on terminate.

### 9.3 Attach component tests

Keep most logic pure:

- socket client parser,
- terminal buffer projection,
- detach chord interception,
- resize event generation.

Manual verification is required for final TUI fidelity.

## 10. Phased implementation

### Phase 0 — feasibility spike

Goal: prove or disprove extension-only PTY attach.

Tasks:

1. Add temporary `node-pty` experiment script outside app flow.
2. Spawn `pi --session <tmp.jsonl> "say hi"` inside PTY.
3. Verify Pi runs initial prompt and remains interactive afterward.
4. Build tiny `ctx.ui.custom` component that renders a fake ANSI stream through a terminal emulator.
5. Confirm parent Pi TUI can render the virtual terminal without corrupting its own screen.
6. Confirm child extension can mirror events via `AGENT_BOARD_ROOT/VIEW_ID`.

Exit criteria:

- Can attach, see live Pi UI, type into it, detach, and keep child alive.

If this fails due to public TUI limitations, switch to Option B/C instead of forcing a bad clone.

### Phase 1 — host store + service plumbing

- Add `HostStatus` types/path helpers/store functions.
- Extend `Row` with `host`/`hostAlive`.
- Add service methods for host launch/status/terminate.
- Keep legacy JSON runner as fallback.

### Phase 2 — PTY runner

- Add `runner/pty-runner.mjs`.
- Add socket protocol.
- Add fake PTY integration tests.
- Persist `host.json` and `screen.log`.

### Phase 3 — child event mirroring

- Modify `src/index.ts` for hosted child env vars.
- Make `syncForegroundEvent` or new `syncHostedEvent` update row activity without confusing host liveness.
- Verify state transitions: queued → working → completed/needs_input while host remains alive.

### Phase 4 — live attach component

- Add socket client.
- Add virtual terminal renderer.
- Intercept detach chord.
- Forward all other input bytes.
- Handle resize.
- Integrate into `/agent-board` attach flow.

### Phase 5 — reply/stop behavior

- Reply to host by injecting text + Enter into PTY.
- Stop active work by sending Escape first.
- Add terminate-host confirm if needed.
- Preserve existing fallback for dead hosts.

### Phase 6 — hardening/polish

- stale socket cleanup,
- host TTL or user-visible “close host” command,
- dependency install docs,
- dashboard indicators,
- worktree cleanup with live hosts,
- manual verification matrix.

## 11. Acceptance criteria

MVP live attach is accepted when:

1. Dispatch creates a real managed session and launches an interactive hosted Pi.
2. Dashboard shows the row working via child extension event mirroring.
3. Pressing attach while work is live opens the hosted session without interrupting it.
4. User can type normally into the attached Pi session.
5. Slash commands like `/session`, `/model`, `/tree` are handled by the child Pi, not reimplemented by agent-board.
6. Detach returns to dashboard and child Pi keeps running.
7. Reattach returns to the same live child Pi process.
8. If the host dies, attach falls back to `ctx.switchSession(sessionFile)`.
9. Existing tests pass; new host tests cover runner/socket/store behavior.

## 12. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| `ctx.ui.custom` cannot faithfully render child terminal output | high | Phase 0 spike; fallback to Pi core raw takeover API or standalone CLI |
| `node-pty` native install friction | medium | keep JSON runner fallback; document dependency; consider tmux fallback |
| child Pi extension recursion | medium | `AGENT_BOARD_CHILD=1`; skip dashboard auto-open/footer in child |
| host liveness conflated with agent activity | high | add `host.json`; separate `hostAlive` from `row.alive` |
| worktree safety too conservative with idle hosts | low/medium | conservative MVP, later refine with activity state |
| detach chord conflicts with Pi keybindings | low | configurable later; start with `ctrl+]` |
| terminal images/OSC links not perfect in virtual renderer | medium | document limitation; raw takeover/core API if needed |

## 13. Confidence

- **PTY-hosted process + socket + status mirroring:** high, ~80–85%.
- **Extension-only virtual-terminal attach:** medium, ~60–70% until Phase 0 proves TUI fidelity.
- **True raw 1:1 terminal attach:** high conceptually, but likely needs Pi core or standalone CLI support.

## 14. Recommended next step

Do **Phase 0 only** first. Do not refactor the whole service until we prove that a parent Pi extension can render and drive a child Pi PTY well enough inside `ctx.ui.custom()`.

If Phase 0 passes, proceed with phases 1–6. If it fails, stop and design either:

1. a small Pi core raw-terminal takeover API, or
2. a standalone `pi-agent-board` CLI that owns the terminal like tmux.
