/**
 * AgentViewService — the imperative actions behind the dashboard: dispatch a new
 * background session, reply/resume, stop, pin/rename/archive, and the same-repo write
 * safety rule. Pure node + core modules; the Pi-coupled bits (attach, dialogs) live in
 * the command handler. The pi invocation + runner path are injected (resolved in index.ts).
 */
import { resolve } from "node:path";
import { finalizeRun, projectViewState, reduceEvent } from "../core/events.mjs";
import { newRunId, newViewId, slugifyTask } from "../core/ids.mjs";
import { launchRun } from "../core/launch.mjs";
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
	writeMeta,
	writeState,
} from "../core/store.mjs";
import { addWorktree, removeWorktree, worktreeBranch } from "../core/worktree.mjs";

/** @typedef {import("../core/types.mjs").RunKind} RunKind */

/**
 * @param {{
 *   root: string,
 *   runnerScript: string,
 *   piCommand: string,
 *   piArgsPrefix: string[],
 *   defaultCwd: string,
 *   launch?: typeof launchRun,
 * }} opts
 */
export function createService(opts) {
	const root = opts.root;
	const launch = opts.launch ?? launchRun;

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

		// Reflect "queued/alive" immediately so the dashboard shows it before the runner writes.
		const state = readState(root, meta.id) ?? blankState(meta.id);
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
		return { runId, pid };
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
			(r) => r.alive && r.meta.writeCapable && r.meta.worktreeMode !== "worktree" && r.meta.repoRoot === repoRoot,
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

	return {
		/**
		 * Create a new background session and launch its first run.
		 * Enforces worktree isolation for same-repo parallel writers (locked decision):
		 * if another non-isolated writer is already active in this repo, we require a worktree.
		 * @param {string} text
		 * @param {{ cwd?: string, worktree?: boolean, writeCapable?: boolean }} [dispatchOpts]
		 * @returns {{ ok: boolean, viewId?: string, error?: string, usedWorktree?: boolean }}
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
			launchForView(meta, prompt, "dispatch");
			return { ok: true, viewId: id, usedWorktree: worktreeMode === "worktree" };
		},

		/**
		 * Append a reply to an existing session by launching a new run. Blocks if a run is live.
		 * @param {string} viewId
		 * @param {string} text
		 * @returns {{ ok: boolean, error?: string }}
		 */
		reply(viewId, text) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty reply" };
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.alive) return { ok: false, error: "A run is already active for this session" };
			launchForView(row.meta, prompt, "reply");
			return { ok: true };
		},

		/**
		 * Stop the active run for a view (SIGTERM the runner → it finalizes as `stopped`).
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		stop(viewId) {
			const state = readState(root, viewId);
			if (!state?.currentRunId) return { ok: false, error: "No active run" };
			const pid = readPid(root, viewId, state.currentRunId);
			if (!pid) return { ok: false, error: "No runner pid" };
			killProcess(pid);
			return { ok: true };
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
		 * Soft-delete a row: archive it (removed from the dashboard) but preserve the session
		 * file. Optionally also remove its worktree (requires the caller's explicit confirm).
		 * @param {string} viewId
		 * @param {{ removeWorktree?: boolean }} [archiveOpts]
		 */
		archive(viewId, archiveOpts = {}) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.alive) return { ok: false, error: "Stop the active run before deleting" };
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
				if (row.alive) {
					skipped += 1;
					continue;
				}
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
				return true;
			}

			if (reduceEvent(status, event, now)) {
				status.processState = "alive";
				writeForegroundState(row, status);
				return true;
			}
			return false;
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
