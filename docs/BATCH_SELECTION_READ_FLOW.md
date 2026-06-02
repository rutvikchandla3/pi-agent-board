# Batch Selection + Read/Unread Flow

**Status:** Proposed  
**Context:** Pi Agent Board dashboard  
**Created:** 2026-06-02

## Assumption

"Move to done to delete that batch" is treated as a **safe 2-step cleanup flow**:

1. bulk-select sessions,
2. move them to **Done**,
3. optionally delete that same batch from **Done** with a second explicit confirmation.

This keeps "done" non-destructive and makes deletion intentional.

---

## 1. Goals

### A. Multi-session selection
- Let users select multiple rows from the board.
- Let users batch-mark them as **Done**.
- Let users immediately clean up that same batch from the **Done** group.

### B. Read / Unread
- Mark a session as **Read** once the user has actually visited it via attach / transcript-style deep view.
- Show a **subtle unread hint** on rows with unseen activity.
- If new activity happens after a visit, the row becomes **Unread** again.

---

## 2. UX overview

### Normal mode
- Board behaves exactly like today: single active row, peek, attach, done, delete.

### Selection mode
- User enters a temporary **multi-select mode**.
- Selection count appears in header/footer: `3 selected`.
- Rows show a subtle selected marker.
- Actions become batch-oriented:
  - **Mark selected done**
  - **Delete selected** (only from Done, with confirm)
  - **Clear selection**

### Read state
- Rows can be either:
  - **Unread** = new activity since last visit
  - **Read** = user has already visited the latest activity
- Unread should not overpower semantic state; it is a secondary signal.

---

## 3. Multi-session selection flow

## 3.1 Enter selection mode

**Trigger**
- User presses a dedicated shortcut from board list view.
- Suggested shortcut: `m` for **multi-select**.

**Result**
- Footer changes to selection hints.
- Selection starts empty; the current row stays focused but is **not** auto-selected.
- Header shows selection count.

---

## 3.2 Build the selection

While in selection mode:
- `↑ / ↓` moves cursor
- `space` toggles current row in selection
- `a` selects all visible rows in current filter/group
- `u` clears the current selection without leaving selection mode
- `esc` clears selection and exits selection mode

Optional later:
- `A` = select all rows in current state group
- `u` = unselect all

---

## 3.3 Move selected rows to Done

**Trigger**
- User presses `d` while in selection mode.

**Confirmation copy**
- `Mark 5 selected sessions as done? (y/N)`

**Rules**
- Running/live rows are skipped.
- Needs-input / idle / failed / stopped rows may be moved to Done.
- Confirmation should mention skipped rows if any.

**Result**
- Matching rows are moved to `Done`.
- The same rows remain selected.
- Board auto-scrolls/focuses to the `Done` section.
- Toast example: `Moved 5 to Done · skipped 2 live`

This preserves the batch as a temporary working set for cleanup.

---

## 3.4 Delete the same batch from Done

**Trigger**
- With the same batch still selected, user presses `ctrl+x` or a batch delete key.

**Guardrail**
- Deletion is only enabled when all selected rows are already in `Done`.
- If selection includes non-Done rows, show: `Only Done sessions can be batch deleted`.

**Confirmation copy**
- `Delete 5 done sessions? Session files are preserved. (y/N)`

**Result**
- Selected rows are archived from dashboard.
- Selection clears.
- Toast example: `Deleted 5 done sessions`

---

## 4. Read / Unread flow

## 4.1 What counts as Read

A session becomes **Read** when the user intentionally opens that session in a deeper way:
- attach via `enter` / `→`
- transcript/full-session view

**Not read by default:**
- merely highlighting a row
- passive polling updates
- quick list navigation
- optional: peek can remain non-read to preserve signal

---

## 4.2 When a row becomes Unread again

A previously read row becomes **Unread** when new agent-side activity happens after the last visit, for example:
- new assistant message
- new blocker/question
- new tool/result activity that changes the summary
- session re-enters `needs_input`

User-authored actions alone should not create unread state.

---

## 4.3 Recommended subtle hint

Use the **stage icon itself** as the unread signal:
- **Unread:** stronger/heavier variant of that stage icon
- **Read:** lighter/default variant of that stage icon

Examples:
- queued: `○` → `◎`
- needs input: `◇` → `◆`
- done: `✓` → `✔`

Optional secondary treatment:
- unread row title slightly brighter
- read row title normal

Avoid:
- loud badges like `UNREAD`
- full-row highlight
- strong color conflict with semantic states like Failed / Needs input

### Priority of signals
1. semantic state (Running, Needs input, Done, Failed)
2. selection state
3. unread hint

Unread should help scanning, not dominate the board.

---

## 5. State model

## 5.1 Batch selection

Selection can stay **ephemeral UI state** in the dashboard component:
- `selectedIds: Set<string>`
- `selectionMode: boolean`

No persistence needed for V1.

## 5.2 Read state

Recommended durable fields:
- `lastVisitedAt: number | null`
- `lastAgentActivityAt: number | null`

Derived flag:
- `isUnread = lastAgentActivityAt > lastVisitedAt`

This is simpler and more reliable than storing a raw boolean.

---

## 6. Edge cases

### Live rows inside a batch
- Cannot be batch-done or batch-deleted.
- Skip and report counts.

### Mixed-state selection
- Batch done: allowed for inactive non-done rows.
- Batch delete: only allowed if every selected row is already Done.

### New activity during selection
- Keep row selected.
- If it receives new output, unread hint can appear even while selected.

### Re-attaching to a row
- Refresh `lastVisitedAt`.
- Any prior unread marker clears.

### Peek behavior
- Recommend: peek does **not** mark read.
- Reason: peek is triage, attach/transcript is actual visit.

---

## 7. Suggested implementation slices

### Dashboard (`src/ui/dashboard.ts`)
- add selection mode
- add `selectedIds`
- batch confirm flows
- render selected marker + unread marker

### Service (`src/runtime/service.mjs`)
- add `markCompletedMany(viewIds)`
- add `archiveMany(viewIds)`
- add `markVisited(viewId)`

### Store/types (`src/core/types.mjs`, `src/core/store.mjs`)
- add read-tracking timestamps
- expose unread derivation on rows

### Attach / session view entry points
- mark row visited when attach or transcript view opens

---

## 8. Recommended default interaction summary

### Batch
- `m` enter multi-select
- `space` toggle row
- `a` select all visible
- `u` clear selection
- `d` move selected to Done
- `ctrl+x` delete selected Done batch
- `esc` clear/exit

### Read state
- attach / transcript => mark read
- new assistant-side activity => unread again
- unread indicator => subtle left dot/bar

---

## 9. Acceptance criteria

- User can select multiple sessions from the board.
- User can mark that selection Done in one action.
- User can immediately delete that same batch from Done with explicit confirmation.
- A session becomes Read after attach/transcript visit.
- New agent activity turns a previously read row back to Unread.
- Unread is visible through a subtle row hint, not a loud badge.
