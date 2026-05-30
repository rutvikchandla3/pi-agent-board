/**
 * High-level store operations over the agent-view layout (see paths.mjs).
 * Roster/meta/state/status read+write, row listing, and view creation/recovery.
 * Used by the extension, the runner, and tests. Pure node, no Pi imports.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { atomicWriteJson, ensureDir, readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";
import { isAlive } from "./pid.mjs";

/** @typedef {import("./types.mjs").Roster} Roster */
/** @typedef {import("./types.mjs").ViewMeta} ViewMeta */
/** @typedef {import("./types.mjs").ViewState} ViewState */
/** @typedef {import("./types.mjs").RunStatus} RunStatus */

const META_VERSION = 1;

// ---- roster ---------------------------------------------------------------

/** @param {string} root @returns {Roster} */
export function readRoster(root) {
	return readJson(P.rosterPath(root), { version: 1, views: [] });
}

/** @param {string} root @param {Roster} roster */
export function writeRoster(root, roster) {
	atomicWriteJson(P.rosterPath(root), roster);
}

/** @param {string} root @param {string} viewId */
export function addToRoster(root, viewId) {
	const roster = readRoster(root);
	if (!roster.views.includes(viewId)) {
		roster.views.push(viewId);
		writeRoster(root, roster);
	}
}

/** @param {string} root @param {string} viewId */
export function removeFromRoster(root, viewId) {
	const roster = readRoster(root);
	const next = roster.views.filter((v) => v !== viewId);
	if (next.length !== roster.views.length) {
		roster.version = roster.version ?? 1;
		writeRoster(root, { version: roster.version, views: next });
	}
}

// ---- meta / state / status ------------------------------------------------

/** @param {string} root @param {string} viewId @returns {ViewMeta|null} */
export function readMeta(root, viewId) {
	return readJson(P.metaPath(root, viewId), /** @type {ViewMeta|null} */ (null));
}

/** @param {string} root @param {ViewMeta} meta */
export function writeMeta(root, meta) {
	meta.updatedAt = Date.now();
	atomicWriteJson(P.metaPath(root, meta.id), meta);
}

/** @param {string} root @param {string} viewId @returns {ViewState|null} */
export function readState(root, viewId) {
	return readJson(P.statePath(root, viewId), /** @type {ViewState|null} */ (null));
}

/** @param {string} root @param {ViewState} state */
export function writeState(root, state) {
	atomicWriteJson(P.statePath(root, state.viewId), state);
}

/** @param {string} root @param {string} viewId @param {string} runId @returns {RunStatus|null} */
export function readStatus(root, viewId, runId) {
	return readJson(P.statusPath(root, viewId, runId), /** @type {RunStatus|null} */ (null));
}

/** @param {string} root @param {RunStatus} status */
export function writeStatus(root, status) {
	atomicWriteJson(P.statusPath(root, status.viewId, status.runId), status);
}

/** @param {string} root @param {string} viewId @param {string} runId @param {number|null} pid */
export function writePid(root, viewId, runId, pid) {
	atomicWriteJson(P.pidPath(root, viewId, runId), { pid, at: Date.now() });
}

/** @param {string} root @param {string} viewId @param {string} runId @returns {number|null} */
export function readPid(root, viewId, runId) {
	return readJson(P.pidPath(root, viewId, runId), { pid: null }).pid ?? null;
}

// ---- listing / loading ----------------------------------------------------

/** @param {string} root @param {string} viewId @returns {string[]} run ids, newest first by mtime. */
export function listRunIds(root, viewId) {
	const dir = P.runsDir(root, viewId);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((name) => {
				try {
					return statSync(P.runDir(root, viewId, name)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort((a, b) => mtime(P.runDir(root, viewId, b)) - mtime(P.runDir(root, viewId, a)));
	} catch {
		return [];
	}
}

/** @param {string} dir */
function mtime(dir) {
	try {
		return statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * A merged dashboard row: meta + derived state. `state` may be null for a never-run row.
 * @typedef {Object} Row
 * @property {ViewMeta} meta
 * @property {ViewState|null} state
 * @property {boolean} alive  Whether the row's current run pid is alive.
 */

/** @param {string} root @param {string} viewId @returns {Row|null} */
export function loadRow(root, viewId) {
	const meta = readMeta(root, viewId);
	if (!meta) return null;
	const state = readState(root, viewId);
	let alive = false;
	if (state?.currentRunId) {
		const pid = readPid(root, viewId, state.currentRunId);
		alive = isAlive(pid);
	}
	return { meta, state, alive };
}

/**
 * Load every non-archived row referenced by the roster.
 * @param {string} root
 * @param {{ includeArchived?: boolean }} [opts]
 * @returns {Row[]}
 */
export function listRows(root, opts = {}) {
	const roster = readRoster(root);
	/** @type {Row[]} */
	const rows = [];
	for (const viewId of roster.views) {
		const row = loadRow(root, viewId);
		if (!row) continue;
		if (row.meta.archived && !opts.includeArchived) continue;
		rows.push(row);
	}
	return rows;
}

// ---- creation -------------------------------------------------------------

/**
 * Create a new managed view (row) and persist meta + roster + an initial queued state.
 * Does not launch anything — the caller launches a run afterward.
 * @param {string} root
 * @param {{
 *   id: string, name: string, cwd: string, repoCwd?: string, repoRoot?: string|null,
 *   worktreeMode?: import("./types.mjs").WorktreeMode, worktreePath?: string|null,
 *   defaultModel?: string|null, writeCapable?: boolean,
 * }} opts
 * @returns {ViewMeta}
 */
export function createView(root, opts) {
	ensureDir(P.sessionsDir(root));
	const now = Date.now();
	/** @type {ViewMeta} */
	const meta = {
		version: META_VERSION,
		id: opts.id,
		name: opts.name,
		cwd: opts.cwd,
		repoCwd: opts.repoCwd ?? opts.cwd,
		repoRoot: opts.repoRoot ?? null,
		sessionFile: P.sessionFilePath(root, opts.id),
		createdAt: now,
		updatedAt: now,
		pinned: false,
		kind: "pi-session",
		defaultModel: opts.defaultModel ?? null,
		worktreeMode: opts.worktreeMode ?? "off",
		worktreePath: opts.worktreePath ?? null,
		writeCapable: opts.writeCapable ?? true,
		archived: false,
		source: "agent-view",
	};
	ensureDir(P.viewDir(root, meta.id));
	writeMeta(root, meta);
	/** @type {ViewState} */
	const state = {
		version: 1,
		viewId: meta.id,
		currentRunId: null,
		semanticState: "queued",
		processState: "exited",
		summary: "Queued",
		lastActivityAt: now,
		updatedAt: now,
		needsInput: false,
		hasError: false,
		latestAssistantPreview: "",
		latestTool: null,
		question: null,
		error: null,
	};
	writeState(root, state);
	addToRoster(root, meta.id);
	return meta;
}
