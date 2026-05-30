# Manual Verification

Steps you can run yourself to check the extension. Grouped from "no auth needed" to
"needs pi provider auth". Commands assume you're in the repo root.

---

## 0. Static checks (no auth, fast)

```bash
npm install          # dev deps: typescript, @types/node
npm run typecheck    # expect: 0 errors
npm test             # expect: tests 45 / pass 45 / fail 0
```

`npm test` includes a hermetic integration test that runs the **real detached runner** against
a fake pi worker (`test-support/fake-pi.mjs`) — it proves dispatch → events → status/state →
finalize (completed / needs_input / failed / stopped) without any model/network.

## 1. Does the extension load in pi? (no auth)

```bash
pi --list-models -e "$(pwd)/src/index.ts"
```
Expect a normal model table and **exit 0** (the extension factory ran without throwing). If you
see an error mentioning `index.ts` / jiti / a missing import, that's a load problem.

## 2. CRITICAL: can pi reach a model at all? (needs pi auth)

This is the thing that was blocked in the dev sandbox. The background worker is just
`pi --mode json -p --session <file> "<prompt>"`, so first confirm a plain one-shot works:

```bash
# Should print a JSON event stream that ENDS WITH a line of type "agent_end", then exit
# within a few seconds. Watch for an "assistant" message_end before agent_end.
pi --mode json -p --no-session "Reply with exactly: DONE" | tail -n 20
```
- ✅ **Healthy:** you see `...message_end (assistant)...`, then `agent_end`, and the command exits.
- ❌ **Hang:** it prints up to a `message_end` for the **user** message then sits idle (no
  assistant reply, never exits). That means pi has no working provider auth / network here.
  Fix pi's auth first:
  ```bash
  pi            # then run /login inside pi, or set the provider key pi expects, e.g.
  # export ANTHROPIC_API_KEY=...   (or OPENAI_API_KEY=... for gpt-4o summaries)
  ```
  Re-run the one-shot above until it ends in `agent_end`. The dashboard cannot show live results
  until this works — it's a pi setup step, independent of this extension.

## 3. Install the extension for normal use

Symlink the repo into pi's global extensions dir (auto-discovered via the top-level `index.ts`):
```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/agent-view
```
Or add its path under `extensions` in `~/.pi/agent/settings.json`. Then start pi normally:
```bash
pi
```

## 4. Drive the dashboard

Inside pi:
1. Type `/agents` (or press **Ctrl+G**) → the full-screen dashboard opens.
2. Press **n**, type a task (e.g. `list the files in this repo and summarize the README`), Enter.
   - A row appears and moves `Queued → Working → Completed` (needs step 2 healthy).
3. **space** = peek (summary, blocker, latest output); in peek **r** = reply, **a** = attach.
4. **enter** on a row = attach to that full session (confirms first if it's still running).
   You're now in the real Pi session; run `/agents` again to return.
5. Other keys: **/** filter (`s:working`, or free text), **r** rename, **p** pin, **s** stop,
   **x** delete (archives the row, keeps the session file), **?** help, **q** quit.

## 5. Inspect the durable store on disk

```bash
ls -R ~/.pi/agent/agent-view
cat ~/.pi/agent/agent-view/roster.json
cat ~/.pi/agent/agent-view/views/*/state.json
cat ~/.pi/agent/agent-view/views/*/runs/*/status.json
# raw worker event stream for a run:
cat ~/.pi/agent/agent-view/views/*/runs/*/events.jsonl
```

## 6. Recovery / persistence

- Start a dispatch, then quit pi (or `/reload`). Re-open pi and `/agents` — the row is still
  there with its last state (rehydrated from disk). If a run's runner died without finishing,
  the dashboard reconciles it to `failed (runner exited)` on open.

## 7. Same-repo write safety (worktree)

- Dispatch one writer task in a git repo, then (while it's running) dispatch a second in the
  **same repo**. The second is auto-isolated into its own git worktree (under
  `~/.pi/agent/agent-view/worktrees/<viewId>`) so the two can't clobber each other. In dispatch
  mode you can also press **Tab** to force a worktree.

## 8. Summary model

Default summary model is **gpt-4o** (override `AGENT_VIEW_SUMMARY_MODEL=<model>`, disable with
`AGENT_VIEW_SUMMARY_MODEL=off`). It needs OpenAI auth; without it the row keeps its heuristic
summary (e.g. the first sentence of the agent's last message or the active tool).
