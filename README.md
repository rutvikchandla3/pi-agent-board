# Pi Agent Board

<p align="center">
  <img src="https://raw.githubusercontent.com/rutvikchandla3/pi-agent-board/main/assets/banner.png" alt="Pi Agent Board" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/rutvikchandla3/pi-agent-board/blob/main/assets/demo.mp4"><strong>30s demo</strong></a>
  | <a href="https://pi.dev/packages?name=pi-agent-board">Pi package gallery</a>
  | <a href="https://www.npmjs.com/package/pi-agent-board">npm</a>
</p>

Pi Agent Board is a full-screen TUI dashboard for [Pi](https://github.com/earendil-works/pi-mono). It lets you dispatch, monitor, peek/reply to, attach to, and clean up multiple background Pi sessions from one place.

## Problems It Solves

- Run several Pi tasks at once without losing track of which are queued, running, waiting for input, in progress, done, failed, or stopped.
- Keep real Pi sessions durable and resumable after `/reload`, closing Pi, or restarting the terminal.
- Check the latest output and answer follow-up questions without interrupting a running session.
- Attach to the full interactive Pi session only when hands-on work is needed.
- Manage work across multiple projects in one global board.

## Install

From npm:

```bash
pi install npm:pi-agent-board
pi /agent-board
```

You can also start Pi normally and run `/agent-board`.

Pi Agent Board requires Node 20+ and working Pi provider auth. If rows stay in `Running`, first confirm Pi can complete a one-shot model call:

```bash
pi --mode json -p --no-session "Reply with exactly: DONE"
```

That command should produce an assistant reply and finish with an `agent_end` event.

From a local checkout:

```bash
npm install
pi install "$(pwd)"
pi /agent-board
```

For auto-discovery while developing:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board
pi
```

Remove that symlink when you no longer want Pi to auto-load the checkout. If you installed by path, remove it with `pi remove "$(pwd)"`.

## Use

Open the board with `pi /agent-board` or `/agent-board` inside Pi.

- Type a task in the bottom input, then press `enter`.
- Confirm **Start session**, or adjust `cwd`, model, and thinking level first.
- Watch rows move through `Queued`, `Running`, `Needs input`, `In Progress`, `Done`, `Failed`, and `Stopped`.
- Press `space` to peek at the selected row's summary, blocker, and latest output.
- Press `r` to reply inline without attaching.
- Press `enter`, `right`, or `>` to attach to the real Pi session.
- Press `v` for a read-only live transcript.
- Press `/` to filter by text or state, such as `s:running`.
- Press `ctrl+r` rename, `ctrl+t` pin, `ctrl+s` stop, `d` mark done, `m` multi-select, `ctrl+x` delete/archive, `X` delete inactive rows in the selected state, and `?` for help.

Rows are stored under `~/.pi/agent/agent-board/` by default. Deleting a row archives it from the board; it does not remove the underlying Pi session file.

## Configuration

Useful environment variables:

| Variable | Use |
| --- | --- |
| `AGENT_BOARD_ROOT` | Store location. Defaults to `~/.pi/agent/agent-board/`. |
| `AGENT_BOARD_AUTO_STATE=off` | Disable automatic terminal-state moves. |
| `AGENT_BOARD_AUTO_STATE_MODEL=<model>` | Model for classifying finished turns. Defaults to `gpt-4o`; use `off` for heuristic-only. |
| `AGENT_BOARD_SUMMARY_MODEL=<model>` | Model for short row summaries. Defaults to `gpt-4o`; use `off` to disable. |
| `AGENT_BOARD_TITLE_MODEL=<model>` | Model for generated session titles. Defaults to `openai-codex/gpt-5.5`; use `off` to disable. |
| `AGENT_BOARD_TITLE_THINKING_LEVEL=<level>` | Thinking level for title generation. Defaults to `low`; use `off` to omit it. |
| `AGENT_BOARD_DISABLE_PTY=1` | Disable PTY attach mode. |
| `AGENT_BOARD_FORCE_PTY=1` | Force PTY attach mode. |
| `AGENT_BOARD_ATTACH_MOUSE=0` | Disable attach-view mouse handling and use terminal-native selection. |
| `AGENT_BOARD_WHEEL_LINES=<1-50>` | Lines scrolled per mouse-wheel event in attach view. Defaults to `1`. |

Legacy `AGENT_VIEW_*` variables are still honored for migration.

If the board reports `node-pty unavailable`, press `!` in the dashboard for diagnosis and fix steps.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run pack:dry
```

Run all checks with:

```bash
npm run verify
```

`npm run verify` runs typecheck, tests, and a dry npm pack.

## Publish

Before publishing a new release, bump the package version, run verification, then publish:

```bash
npm run verify
npm version patch
npm publish
```

If the version is already bumped, skip `npm version patch`.

Use `npm version minor` or `npm version major` instead when the release warrants it. After publish, users install with:

```bash
pi install npm:pi-agent-board
```

The Pi package gallery uses the `pi.video` and `pi.image` URLs from `package.json`.
