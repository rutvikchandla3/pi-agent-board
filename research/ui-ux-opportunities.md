# UI/UX Opportunities — Pi Agent Board

Review scope: `README.md`, `PRD.md`, `IMPLEMENTATION_PLAN.md`, `PROGRESS.md`, `docs/*`, `src/ui/dashboard.ts`, `src/ui/pty-attach.ts`, `src/core/session-view.mjs`, `src/core/rows.mjs`, `src/runtime/service.mjs`, and relevant tests. Verification run: `npm test` (98/98 passing) and `npm run typecheck` (clean).

## What is already strong

- The core product shape is coherent: a global full-screen board, durable session rows, peek/reply, transcript view, and PTY attach are all represented in README and implementation (`README.md:51-62`, `src/commands/agent-board.ts:48-95`).
- The PTY attach work has thoughtful UX details: loading state, detach chords, scrollback, mouse selection/copy, link opening, and reconnect retry (`src/ui/pty-attach.ts:132-167`, `src/ui/pty-attach.ts:186-223`).
- Read/unread and batch cleanup are implemented in the display model and service, with tests around row glyphs and service batch actions (`src/core/rows.mjs:96-119`, `test/rows.test.mjs:29-73`, `test/service.test.mjs:334-390`).

## High-impact opportunities

### P0 — Reconcile the parallel-safety/worktree UX before users trust the board for coding

**Why it matters:** The product promise is safe parallel coding. Current docs and implementation now permit exactly the scenario the PRD/plan called out as dangerous: two write-capable sessions in the same repo without isolation. This is a trust and data-loss UX issue, not only an architecture issue.

**Evidence:**
- PRD locks the decision that same-repo parallel writer sessions must require worktree isolation (`PRD.md:15-22`) and names safe parallelism as a core principle (`PRD.md:68-70`).
- The implementation plan says same-repo writer sessions should be allowed only in separate worktrees, otherwise the second launch must be blocked (`IMPLEMENTATION_PLAN.md:627-636`).
- README now says Agent Board does not auto-create worktrees and does not block multiple same-repo sessions (`README.md:61-62`).
- `dispatch()` rejects explicit worktree requests and always creates rows with `worktreeMode: "off"` (`src/runtime/service.mjs:385-397`).
- Tests explicitly assert same-repo concurrent dispatch is allowed (`test/service.test.mjs:233-255`).

**Improvement:** Add an explicit launch-time safety model. At minimum: detect an existing active/live same-repo row and show a high-friction warning with choices like `Start read-only`, `Start isolated worktree`, or `Start anyway (unsafe)`. Best UX: default to worktree isolation for write-capable tasks, with clear naming and cleanup affordances.

**Risks/tradeoffs:** Worktrees add git edge cases, cleanup complexity, and startup latency. If the product intentionally chose unsafe parallelism, update the PRD/plan and make the risk explicit in the launch dialog, not only README.

### P0 — Make `(y/N)` confirmations actually default to No

**Why it matters:** Several destructive or disruptive actions advertise `(y/N)`, but pressing Enter confirms Yes. In terminal UIs, `(y/N)` strongly implies Enter is safe/cancel. This can cause accidental deletion/archival, batch cleanup, or interrupt-and-attach.

**Evidence:**
- `handleConfirmKey()` treats `Enter` the same as `y`/`Y` (`src/ui/dashboard.ts:430-447`).
- Prompts use `(y/N)` for mark-done, delete, delete-state, batch delete, and interrupt attach (`src/ui/dashboard.ts:823-842`, `src/ui/dashboard.ts:898-935`, `src/ui/dashboard.ts:991-995`).

**Improvement:** Make only `y`/`Y` confirm. Let `Enter`, `n`, `N`, `Esc`, and any non-confirm key cancel. If Enter-confirm is desired for low-risk actions, change the prompt to `(Y/n)` and reserve it for non-destructive operations.

**Risks/tradeoffs:** Slows power users by one keypress, but aligns with the prompt and reduces accidental loss.

### P0 — Align first-run compose behavior with the README and empty state

**Why it matters:** The README and empty state tell users to type a task, but the current board eats printable input in normal mode and asks users to press `i` first. That creates immediate first-run friction in the primary action of the product.

**Evidence:**
- README says “Dispatch by typing in the bottom input and pressing `enter`” (`README.md:53`).
- Empty state says “Type below and press Enter” (`src/ui/dashboard.ts:1201-1203`).
- In normal/list mode, printable input is not inserted; it only shows “Press i to enter INSERT mode” (`src/ui/dashboard.ts:344-346`).
- The footer placeholder also says “press i to write a prompt” (`src/ui/dashboard.ts:1180`).

**Improvement:** Either restore direct type-to-compose, or make the product explicitly modal everywhere. Best compromise: first printable key in list mode enters insert mode and seeds the draft with that key; keep single-letter shortcuts only when the input is empty and not typing. This preserves fast shortcuts while matching user expectation.

**Risks/tradeoffs:** Direct typing can conflict with one-key shortcuts (`m`, `d`, `v`, etc.). A seeded insert-mode transition plus a visible `[NORMAL]`/`[INSERT]` badge mitigates this.

### P1 — Add a real “start and attach” path

**Why it matters:** The PRD requires dispatch+attach, and this is a common flow: “start this task, then immediately supervise it interactively.” Today, Shift+Enter is documented in-app as newline, not dispatch-and-attach, so the user must launch, wait for the row, then attach separately.

**Evidence:**
- PRD lists `Shift+Enter — dispatch and attach` (`PRD.md:163-170`) and FR4 requires dispatch + attach (`PRD.md:243-248`).
- Dashboard hints say Shift+Enter inserts a newline in insert/reply (`src/ui/dashboard.ts:1129-1130`, `src/ui/dashboard.ts:1407-1408`).
- The dashboard result type only resolves attach for an existing `viewId`; dispatch is handled in-place and does not return an attach action (`src/ui/dashboard.ts:37-38`, `src/ui/dashboard.ts:734-760`).

**Improvement:** Add a launch-dialog secondary action: `Start session` and `Start & attach`. Map a clear key to it (e.g. `ctrl+enter`, `alt+enter`, or a selected button row) rather than overloading Shift+Enter if the editor needs it for multiline prompts.

**Risks/tradeoffs:** Cold PTY startup can be slow; pair this with the existing loading surface so the user gets immediate feedback.

### P1 — Improve global-board scanning with project/model scope and better filters

**Why it matters:** The board is global across projects by default. With multiple repos, rows need stronger context than a basename and short summary; otherwise similarly named repos/tasks become hard to distinguish.

**Evidence:**
- PRD says rows should show cwd/project context and optional model/agent label (`PRD.md:116-126`).
- `rowView()` collapses location to `baseName(repoCwd || cwd)` and does not include model/thinking in the row view (`src/core/rows.mjs:96-119`).
- Free-text filtering searches only name, summary, repoCwd, and cwd (`src/core/rows.mjs:195-204`).
- Row rendering allocates a small folder column and no model/status chips (`src/ui/dashboard.ts:1218-1236`).

**Improvement:** Add scope chips and richer filters: `repo:<name>`, `cwd:<path>`, `m:<model>`, `u:unread`, `p:pinned`; optionally a project-grouping mode. In rows, show a compact model/thinking chip only when it differs from the current/default model.

**Risks/tradeoffs:** More metadata can make rows noisy. Keep the default compact and expose details in peek/header or a density toggle.

### P1 — Make transcript view scalable and easier to navigate

**Why it matters:** Transcript view is one of the safest non-interrupting ways to inspect live work. Current implementation reparses the entire session file and builds/wraps the full active branch on each render, which can become sluggish for long sessions.

**Evidence:**
- `renderSession()` calls `loadSessionView()` during render (`src/ui/dashboard.ts:1282-1289`).
- `loadSessionView()` reads the whole session file synchronously (`src/core/session-view.mjs:33-39`).
- `parseSessionText()` splits and JSON-parses the full file (`src/core/session-view.mjs:53-69`).
- Rendering then iterates every item and wraps text with a very high max (`src/ui/dashboard.ts:1296-1305`).

**Improvement:** Cache by file size/mtime, parse incrementally, and virtualize rendering around the visible window. Add `End/follow live`, `/` search inside transcript, and role filters (`user/agent/tools`) so it is useful beyond short sessions.

**Risks/tradeoffs:** Incremental parsing is more complex because session files are branch trees. A simple mtime cache plus tail-first display would already improve perceived performance.

### P1 — Separate “interrupt agent” from “close hosted Pi”

**Why it matters:** PTY hosts can stay alive after work completes. The current visible stop command treats any live host as stoppable and sends an interrupt, while the service has a separate terminate-host capability that is not exposed in dashboard hints. Users need clear resource control.

**Evidence:**
- Dashboard `ctrl+s` checks `row.hostAlive` and says “Stopping…” (`src/ui/dashboard.ts:810-815`).
- `service.stop()` sends an `interrupt` for any hosted row (`src/runtime/service.mjs:438-446`).
- `terminateHost()` exists separately (`src/runtime/service.mjs:449-453`), while warm-host eviction is hidden behind TTL/max pool settings (`src/runtime/service.mjs:303-325`).
- Footer hints expose `ctrl+s stop` only indirectly through help/manage text and do not distinguish host lifecycle (`src/ui/dashboard.ts:1125-1147`).

**Improvement:** Rename the primary action to `Interrupt` when the agent is busy, and add a separate `Close host` action for idle/completed hosted rows. Surface host count/TTL in the PTY diagnostics or peek.

**Risks/tradeoffs:** More controls add complexity. Contextual labels avoid clutter: `ctrl+s interrupt` for busy, `ctrl+k close host` or a confirm menu for hosted idle rows.

### P1 — Make peek more action-oriented, not just a summary card

**Why it matters:** The PRD’s principle is “dashboard first, transcript second.” Peek should let users decide quickly whether to reply, attach, stop, or mark done. Currently it shows summary, question, latest assistant preview, and error, but not the recent activity timeline or current tool context.

**Evidence:**
- PRD says peek should show current summary, latest meaningful output, current question/blocker, inline reply, and support adjacent navigation (`PRD.md:180-195`).
- Current peek renders summary, optional question, latest assistant preview, optional error, and reply controls (`src/ui/dashboard.ts:1239-1278`).
- Row/state already carries `latestTool`, but peek does not display it (`src/core/rows.mjs:96-119`, `src/ui/dashboard.ts:1239-1278`).

**Improvement:** Add a compact recent timeline: current/last tool, changed file/test command if available, last assistant paragraph, and explicit next action chips (`Reply`, `Attach`, `Mark done`, `Stop`). For `needs_input`, put the question and reply box above the generic summary.

**Risks/tradeoffs:** Requires more event reduction and may duplicate transcript. Keep it capped to 5–8 lines and link to full transcript for detail.

### P2 — Strengthen state semantics and accessibility beyond color/glyph alone

**Why it matters:** The board relies heavily on colored glyphs. Some glyph choices blur semantic state with host liveness; for example a completed hosted row shows the hosted glyph rather than a check mark, so the row can look less “done” at a glance.

**Evidence:**
- `stateGlyph("completed", ..., hostAlive=true)` returns `◍`/`◌`, while non-hosted completed returns `✔`/`✓` (`src/core/rows.mjs:44-54`).
- Row render uses that glyph as the primary left marker (`src/ui/dashboard.ts:1218-1223`).
- Header/row text uses color to communicate stage (`src/ui/dashboard.ts:1218-1236`).

**Improvement:** Keep semantic state primary and host liveness secondary: e.g. `✓` for done plus a small `hosted` chip in peek/header, or a suffix marker. Add an optional high-contrast/text-label mode for terminals where glyphs/colors are ambiguous.

**Risks/tradeoffs:** Text chips consume width. Use them only for selected row/header or in wide terminals.

### P2 — Add a dashboard UI regression harness

**Why it matters:** Most risky UX behavior lives in `DashboardComponent` key handling and rendering. Current tests cover pure rows/session/service/PTY helpers, but there are no dashboard component tests. That leaves regressions like `(y/N)` + Enter-confirm or type-to-compose mismatch easy to miss.

**Evidence:**
- The test suite has row/session/service/PTY tests and passes, but no `test/*dashboard*` file exists.
- Critical behavior is in `DashboardComponent.handleInput()` and related private handlers (`src/ui/dashboard.ts:316-347`, `src/ui/dashboard.ts:430-447`, `src/ui/dashboard.ts:734-760`).

**Improvement:** Add a lightweight fake `TUI`/theme/keybindings harness that instantiates `DashboardComponent`, sends key inputs, and snapshots mode/result/service calls. Start with: direct typing behavior, confirmation default, batch delete guard, launch dialog navigation, and attach/live-host decisions.

**Risks/tradeoffs:** Testing private component state can be brittle. Prefer asserting observable service calls, `done()` results, and rendered hint text.
