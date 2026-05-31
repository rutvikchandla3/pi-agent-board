/**
 * AgentViewService — the imperative actions behind the dashboard: dispatch a new
 * background session, reply/resume, stop, pin/rename/archive, and the same-repo write
 * safety rule. Pure node + core modules; the Pi-coupled bits (attach, dialogs) live in
 * the command handler. The pi invocation + runner path are injected (resolved in index.ts).
 */
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { finalizeRun, projectViewState, reduceEvent } from "../core/events.mjs";
import { firstSentence, truncate } from "../core/heuristics.mjs";
import { newRunId, newViewId, slugifyTask } from "../core/ids.mjs";
import { launchHost as launchHostProcess, launchRun } from "../core/launch.mjs";
import { gitRepoRoot } from "../core/repo.mjs";
import { killProcess } from "../core/pid.mjs";
import * as P from "../core/paths.mjs";
import {
	createView,
	listRows,
	loadRow,
	readPid,
	readState,
	readStatus,
	writeHostPid,
	writeMeta,
	writeState,
} from "../core/store.mjs";
import { addWorktree, removeWorktree, worktreeBranch } from "../core/worktree.mjs";

/** @typedef {import("../core/types.mjs").RunKind} RunKind */

/**
 * @param {{
 *   root: string,
 *   runnerScript: string,
 *   ptyRunnerScript?: string,
 *   piCommand: string,
 *   piArgsPrefix: string[],
 *   defaultCwd: string,
 *   launch?: typeof launchRun,
 *   launchHost?: typeof launchHostProcess,
 * }} opts
 */
export function createService(opts) {
	const root = opts.root;
	const launch = opts.launch ?? launchRun;
	const launchHostImpl = opts.launchHost ?? launchHostProcess;
	const ptyRunnerScript = opts.ptyRunnerScript ?? opts.runnerScript;

	/**
	 * Launch a run (dispatch or reply) against an existing view, updating its state to queued.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string} prompt
	 * @param {RunKind} kind
	 * @returns {{ runId: string, pid: number|null }}
	 */
	function launchForView(meta, prompt, kind) {
		const runId = newRunId();
		/** @type {import("../core/types.mjs").RunConfig} */
		const config = {
			root,
			viewId: meta.id,
			runId,
			kind,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			prompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			tools: null,
		};
		const { pid } = launch(root, config, { runnerScript: opts.runnerScript });
		markQueued(meta.id, runId);
		return { runId, pid };
	}

	/**
	 * Launch a durable interactive PTY host for a view.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string|null} initialPrompt
	 * @returns {{ pid: number|null }}
	 */
	function launchHost(meta, initialPrompt, launchOpts = {}) {
		/** @type {import("../core/types.mjs").HostConfig} */
		const config = {
			root,
			viewId: meta.id,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			initialPrompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			tools: null,
			env: {},
			cols: Number(process.env.COLUMNS || 120),
			rows: Number(process.env.LINES || 36),
		};
		const { pid } = launchHostImpl(root, config, { runnerScript: ptyRunnerScript });
		writeHostPid(root, meta.id, pid);
		if (launchOpts.markQueued !== false) markQueued(meta.id, null);
		return { pid, socketPath: P.controlSocketPath(root, meta.id) };
	}

	/** @param {string} viewId @param {string|null} runId */
	function markQueued(viewId, runId) {
		const state = readState(root, viewId) ?? blankState(viewId);
		state.currentRunId = runId;
		state.semanticState = "queued";
		state.processState = "alive";
		state.summary = "Queued";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.error = null;
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/** @param {string} viewId @returns {import("../core/types.mjs").ViewState} */
	function blankState(viewId) {
		return {
			version: 1,
			viewId,
			currentRunId: null,
			semanticState: "queued",
			processState: "exited",
			summary: "Queued",
			lastActivityAt: Date.now(),
			updatedAt: Date.now(),
			needsInput: false,
			hasError: false,
			latestAssistantPreview: "",
			latestTool: null,
			question: null,
			error: null,
		};
	}

	/**
	 * Rows that are actively running a writer in the given repo (for the safety rule).
	 * @param {string|null} repoRoot
	 * @returns {import("../core/store.mjs").Row[]}
	 */
	function activeWritersInRepo(repoRoot) {
		if (!repoRoot) return [];
		return listRows(root).filter(
			(r) => isAgentBusy(r) && r.meta.writeCapable && r.meta.worktreeMode !== "worktree" && r.meta.repoRoot === repoRoot,
		);
	}

	/** @param {string} a @param {string} b */
	function samePath(a, b) {
		return resolve(a) === resolve(b);
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @returns {import("../core/types.mjs").RunStatus}
	 */
	function statusFromRow(row) {
		const now = Date.now();
		const s = row.state ?? blankState(row.meta.id);
		return {
			version: 1,
			runId: s.currentRunId ?? "foreground",
			viewId: row.meta.id,
			pid: null,
			startedAt: s.lastActivityAt ?? now,
			endedAt: null,
			exitCode: null,
			kind: "reply",
			prompt: "",
			model: row.meta.defaultModel ?? null,
			semanticState: s.semanticState,
			processState: s.processState,
			summary: s.summary,
			lastActivityAt: s.lastActivityAt,
			currentTool: s.latestTool ? { name: s.latestTool.name, path: s.latestTool.path, summary: s.summary } : null,
			latestAssistantPreview: s.latestAssistantPreview,
			question: s.question,
			error: s.error,
			stopReason: null,
			stoppedByUser: false,
			turns: 0,
			toolCount: 0,
		};
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @param {import("../core/types.mjs").RunStatus} status
	 */
	function writeForegroundState(row, status) {
		const projected = projectViewState(status, Date.now());
		// Foreground turns are driven by the interactive Pi process, not a detached
		// runner, so keep currentRunId null. This prevents reconcile()/stop() from
		// treating a foreground turn as a managed background runner pid.
		projected.currentRunId = null;
		writeState(root, projected);
	}

	/** @param {string} sessionFile */
	function rowForSession(sessionFile) {
		return listRows(root).find((r) => samePath(r.meta.sessionFile, sessionFile)) ?? null;
	}

	/**
	 * Keep a small warm pool of idle PTY hosts for fast session switching.
	 * Busy hosts and attached hosts are never evicted.
	 * @param {{ keepViewId?: string|null }} [pruneOpts]
	 */
	function pruneWarmHosts(pruneOpts = {}) {
		const maxWarm = envInt("AGENT_VIEW_MAX_WARM_HOSTS", 4, 0, 50);
		const ttlMs = envInt("AGENT_VIEW_WARM_HOST_TTL_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
		if (maxWarm === 0 && ttlMs === 0) return;
		const now = Date.now();
		const idleHosts = listRows(root)
			.filter((r) => r.meta.id !== pruneOpts.keepViewId)
			.filter((r) => r.hostAlive && !isAgentBusy(r) && (r.host?.attachedClients ?? 0) === 0);

		for (const row of idleHosts) {
			const idleSince = row.state?.lastActivityAt ?? row.host?.startedAt ?? row.meta.updatedAt;
			if (ttlMs > 0 && now - idleSince > ttlMs) sendHostMessage(row, { type: "terminate" });
		}

		const survivors = idleHosts
			.filter((r) => {
				const idleSince = r.state?.lastActivityAt ?? r.host?.startedAt ?? r.meta.updatedAt;
				return !(ttlMs > 0 && now - idleSince > ttlMs);
			})
			.sort((a, b) => (a.state?.lastActivityAt ?? a.host?.startedAt ?? 0) - (b.state?.lastActivityAt ?? b.host?.startedAt ?? 0));
		const excess = Math.max(0, survivors.length - maxWarm);
		for (const row of survivors.slice(0, excess)) sendHostMessage(row, { type: "terminate" });
	}

	/** @param {import("../core/store.mjs").Row} row @param {any} event */
	function syncRowEvent(row, event) {
		const now = Date.now();
		const status = statusFromRow(row);

		if (event.type === "input" || event.type === "before_agent_start" || event.type === "agent_start") {
			status.semanticState = "working";
			status.processState = "alive";
			status.currentTool = null;
			status.question = null;
			status.error = null;
			status.summary = "Working…";
			status.lastActivityAt = now;
			writeForegroundState(row, status);
			return true;
		}

		if (event.type === "agent_end") {
			finalizeRun(status, { exitCode: 0 }, now);
			writeForegroundState(row, status);
			pruneWarmHosts({ keepViewId: row.meta.id });
			return true;
		}

		if (reduceEvent(status, event, now)) {
			status.processState = "alive";
			writeForegroundState(row, status);
			return true;
		}
		return false;
	}

	return {
		root,
		/**
		 * Create a new background session and launch its first run.
		 * Enforces worktree isolation for same-repo parallel writers (locked decision):
		 * if another non-isolated writer is already active in this repo, we require a worktree.
		 * @param {string} text
		 * @param {{ cwd?: string, worktree?: boolean, writeCapable?: boolean }} [dispatchOpts]
		 * @returns {{ ok: boolean, viewId?: string, error?: string, usedWorktree?: boolean, hostMode?: "pty"|"json-runner", fallbackReason?: string }}
		 */
		dispatch(text, dispatchOpts = {}) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty task" };

			const cwd = dispatchOpts.cwd ?? opts.defaultCwd;
			const writeCapable = dispatchOpts.writeCapable ?? true;
			const repoRoot = gitRepoRoot(cwd);

			let worktree = Boolean(dispatchOpts.worktree);
			if (writeCapable && !worktree && activeWritersInRepo(repoRoot).length > 0) {
				if (!repoRoot) {
					return {
						ok: false,
						error: "Another writer is active here and this isn't a git repo — can't isolate. Stop it first.",
					};
				}
				worktree = true; // force isolation per the locked same-repo rule
			}

			const id = newViewId();
			let runCwd = cwd;
			/** @type {import("../core/types.mjs").WorktreeMode} */
			let worktreeMode = "off";
			let worktreePathValue = null;

			if (worktree && repoRoot) {
				const wt = P.worktreePath(root, id);
				const res = addWorktree(repoRoot, wt, worktreeBranch(id));
				if (!res.ok) return { ok: false, error: `Worktree failed: ${res.error}` };
				runCwd = wt;
				worktreeMode = "worktree";
				worktreePathValue = wt;
			}

			const meta = createView(root, {
				id,
				name: slugifyTask(prompt),
				cwd: runCwd,
				repoCwd: cwd,
				repoRoot,
				worktreeMode,
				worktreePath: worktreePathValue,
				writeCapable,
			});
			const pty = ptyHostAvailability();
			if (pty.ok) launchHost(meta, prompt);
			else launchForView(meta, prompt, "dispatch");
			return {
				ok: true,
				viewId: id,
				usedWorktree: worktreeMode === "worktree",
				hostMode: pty.ok ? "pty" : "json-runner",
				fallbackReason: pty.ok ? undefined : pty.reason,
			};
		},

		/**
		 * Append a reply to an existing session by launching a new run. Blocks if a run is live.
		 * @param {string} viewId
		 * @param {string} text
		 * @returns {{ ok: boolean, error?: string, hostMode?: "pty"|"json-runner", fallbackReason?: string }}
		 */
		reply(viewId, text) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty reply" };
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.hostAlive) return sendHostMessage(row, { type: "input", data: `${prompt}\r` });
			if (row.alive) return { ok: false, error: "A run is already active for this session" };
			const pty = ptyHostAvailability();
			if (pty.ok) launchHost(row.meta, prompt);
			else launchForView(row.meta, prompt, "reply");
			return { ok: true, hostMode: pty.ok ? "pty" : "json-runner", fallbackReason: pty.ok ? undefined : pty.reason };
		},

		/**
		 * Stop the active run for a view (SIGTERM the runner → it finalizes as `stopped`).
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		stop(viewId) {
			const row = loadRow(root, viewId);
			if (row?.hostAlive) return sendHostMessage(row, { type: "interrupt" });
			const state = readState(root, viewId);
			if (!state?.currentRunId) return { ok: false, error: "No active run" };
			const pid = readPid(root, viewId, state.currentRunId);
			if (!pid) return { ok: false, error: "No runner pid" };
			killProcess(pid);
			return { ok: true };
		},

		/** @param {string} viewId */
		terminateHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row?.hostAlive) return { ok: false, error: "No live host" };
			return sendHostMessage(row, { type: "terminate" });
		},

		/**
		 * Ensure there is an interactive PTY host for this session. Used for fast attach
		 * and dashboard prewarm. Starting an idle host must not alter task state.
		 * @param {string} viewId
		 * @returns {{ ok: boolean, socketPath?: string, started?: boolean, error?: string, fallbackReason?: string }}
		 */
		ensureHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.hostAlive && row.host?.socketPath) return { ok: true, socketPath: row.host.socketPath, started: false };

			const pty = ptyHostAvailability();
			if (!pty.ok) return { ok: false, error: "PTY unavailable", fallbackReason: pty.reason };
			if (isAgentBusy(row)) return { ok: false, error: "A non-live background run is active for this session" };
			if (!existsSync(row.meta.sessionFile)) return { ok: false, error: "Session file isn't ready yet" };

			const launched = launchHost(row.meta, null, { markQueued: false });
			pruneWarmHosts({ keepViewId: viewId });
			return { ok: true, socketPath: launched.socketPath, started: true };
		},

		/** @param {string} viewId */
		prewarmHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row || isAgentBusy(row)) return { ok: false, error: row ? "Session is busy" : "Unknown session" };
			return this.ensureHost(viewId);
		},

		/** @param {string} viewId */
		attachTarget(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { kind: "missing" };
			if (row.hostAlive && row.host?.socketPath) {
				return { kind: "pty", socketPath: row.host.socketPath, sessionFile: row.meta.sessionFile };
			}
			return { kind: "session", sessionFile: row.meta.sessionFile };
		},

		/** @param {string} viewId @param {boolean} pinned */
		setPinned(viewId, pinned) {
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.pinned = pinned;
			writeMeta(root, meta);
			return { ok: true };
		},

		/** @param {string} viewId @param {string} name */
		rename(viewId, name) {
			const clean = String(name || "").trim();
			if (!clean) return { ok: false, error: "Empty name" };
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.name = clean;
			writeMeta(root, meta);
			return { ok: true };
		},

		/**
		 * Explicitly mark an inactive session as done. Successful runs settle as
		 * `idle` until the user reviews and confirms this action from the dashboard.
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		markCompleted(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (isAgentBusy(row)) return { ok: false, error: "Wait for the active run to finish before marking done" };
			const state = row.state ?? blankState(viewId);
			state.semanticState = "completed";
			state.processState = "exited";
			state.needsInput = false;
			state.hasError = false;
			state.question = null;
			state.error = null;
			state.summary = completionSummary(state);
			state.lastActivityAt = Date.now();
			state.updatedAt = Date.now();
			writeState(root, state);
			return { ok: true };
		},

		/**
		 * Soft-delete a row: archive it (removed from the dashboard) but preserve the session
		 * file. Optionally also remove its worktree (requires the caller's explicit confirm).
		 * @param {string} viewId
		 * @param {{ removeWorktree?: boolean }} [archiveOpts]
		 */
		archive(viewId, archiveOpts = {}) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
			if (row.alive && row.state?.currentRunId) {
				const pid = readPid(root, viewId, row.state.currentRunId);
				if (pid) killProcess(pid);
			}
			if (isAgentBusy(row)) {
				const state = row.state ?? blankState(viewId);
				state.semanticState = "stopped";
				state.processState = "exited";
				state.needsInput = false;
				state.hasError = false;
				state.question = null;
				state.summary = "Stopped";
				state.lastActivityAt = Date.now();
				state.updatedAt = Date.now();
				writeState(root, state);
			}
			if (archiveOpts.removeWorktree && row.meta.worktreeMode === "worktree" && row.meta.worktreePath && row.meta.repoRoot) {
				removeWorktree(row.meta.repoRoot, row.meta.worktreePath);
				row.meta.worktreePath = null;
				row.meta.worktreeMode = "off";
			}
			row.meta.archived = true;
			writeMeta(root, row.meta);
			return { ok: true };
		},

		/**
		 * Archive every non-live visible row in a semantic state. Live rows are skipped
		 * so bulk cleanup cannot accidentally kill work.
		 * @param {import("../core/types.mjs").SemanticState} state
		 * @returns {{ ok: boolean, archived: number, skipped: number, error?: string }}
		 */
		archiveByState(state) {
			let archived = 0;
			let skipped = 0;
			for (const row of listRows(root)) {
				if (row.state?.semanticState !== state) continue;
				if (isAgentBusy(row)) {
					skipped += 1;
					continue;
				}
				if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
				row.meta.archived = true;
				writeMeta(root, row.meta);
				archived += 1;
			}
			return { ok: true, archived, skipped };
		},

		/**
		 * Recovery: reconcile rows whose runner died without finalizing (e.g. machine crash
		 * or the runner was killed). If a terminal status exists, project it; otherwise mark
		 * the row failed/stale. Safe to call on every dashboard open and on session_start.
		 * @returns {number} number of rows reconciled.
		 */
		reconcile() {
			const now = Date.now();
			let fixed = 0;
			for (const row of listRows(root)) {
				const s = row.state;
				if (!s?.currentRunId) continue;
				const looksActive = s.processState === "alive" || s.semanticState === "queued" || s.semanticState === "working";
				if (!looksActive || row.alive) continue;
				const status = readStatus(root, row.meta.id, s.currentRunId);
				if (status?.endedAt) {
					writeState(root, projectViewState(status, now));
				} else {
					s.semanticState = "failed";
					s.processState = "exited";
					s.hasError = true;
					s.needsInput = false;
					s.error = s.error ?? "Runner exited unexpectedly";
					s.summary = "Failed (runner exited)";
					s.updatedAt = now;
					writeState(root, s);
				}
				fixed += 1;
			}
			return fixed;
		},

		/**
		 * Mirror lifecycle/events from a managed session that is currently attached in
		 * the foreground. Without this, a row that was completed/needs_input can keep
		 * looking stale after the user types a follow-up in the real Pi session.
		 * @param {string|undefined} sessionFile
		 * @param {any} event
		 * @returns {boolean} whether a managed row was updated
		 */
		syncForegroundEvent(sessionFile, event) {
			if (!sessionFile || !event?.type) return false;
			const row = rowForSession(sessionFile);
			if (!row) return false;
			return syncRowEvent(row, event);
		},

		/** @param {string|undefined} viewId @param {any} event */
		syncHostedEvent(viewId, event) {
			if (!viewId || !event?.type) return false;
			const row = loadRow(root, viewId);
			if (!row) return false;
			return syncRowEvent(row, event);
		},

		/** @returns {import("../core/store.mjs").Row[]} all visible rows. */
		rows() {
			return listRows(root);
		},

		/** @param {string} viewId @returns {import("../core/store.mjs").Row|null} */
		row(viewId) {
			return loadRow(root, viewId);
		},
	};
}

/** @param {import("../core/store.mjs").Row} row */
function isAgentBusy(row) {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working"));
}

/** @param {import("../core/types.mjs").ViewState} state */
function completionSummary(state) {
	const generic = new Set(["", "Queued", "Working…", "Idle", "Needs input", "Completed", "Done"]);
	if (!generic.has(state.summary?.trim?.() ?? "")) return compactSummary(state.summary);
	return "Done";
}

/** @param {string} text */
function compactSummary(text) {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return "Done";
	const first = firstSentence(cleaned);
	return truncate(first.length >= 12 ? first : cleaned, 80);
}

/**
 * Send a one-shot JSONL command to a live host socket.
 * @param {import("../core/store.mjs").Row} row
 * @param {Record<string, unknown>} message
 * @returns {{ ok: boolean, error?: string }}
 */
function sendHostMessage(row, message) {
	const socketPath = row.host?.socketPath;
	if (!socketPath) return { ok: false, error: "No host socket" };
	try {
		const socket = createConnection(socketPath);
		socket.on("connect", () => {
			socket.write(JSON.stringify(message) + "\n");
			socket.end();
		});
		socket.on("error", () => {});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

let cachedPtySupport;
const requireForPty = createRequire(import.meta.url);

function ptyHostAvailability() {
	if (process.env.AGENT_VIEW_DISABLE_PTY === "1") return { ok: false, reason: "AGENT_VIEW_DISABLE_PTY=1" };
	if (process.env.AGENT_VIEW_FORCE_PTY === "1") return { ok: true };
	return ptySpawnSupported();
}

function envInt(name, fallback, min, max) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function ptySpawnSupported() {
	if (cachedPtySupport !== undefined) return cachedPtySupport;
	try {
		ensureNodePtySpawnHelperExecutable();
		const pty = requireForPty("node-pty");
		const proc = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
			name: "xterm-256color",
			cols: 20,
			rows: 5,
			cwd: process.cwd(),
			env: process.env,
		});
		proc.kill?.();
		cachedPtySupport = { ok: true };
	} catch (err) {
		cachedPtySupport = { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	return cachedPtySupport;
}

function ensureNodePtySpawnHelperExecutable() {
	try {
		const pkg = requireForPty.resolve("node-pty/package.json");
		const root = pkg.slice(0, -"package.json".length);
		for (const rel of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, "build/Release/spawn-helper"]) {
			const helper = root + rel;
			if (existsSync(helper)) chmodSync(helper, 0o755);
		}
	} catch {
		/* node-pty optional/unavailable */
	}
}
