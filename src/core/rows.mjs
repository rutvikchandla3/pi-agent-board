/**
 * Pure dashboard logic: turn store Rows into display view-models, group them by
 * semantic state, and filter them. No pi-tui / theme coupling (the dashboard component
 * applies colors); everything here is unit-tested.
 */
import { normalizeGenericStatusText } from "./derive.mjs";
import { baseName, relativeTime } from "./heuristics.mjs";
import { GROUP_LABELS, GROUP_ORDER, SEMANTIC_STATES } from "./types.mjs";

/** @typedef {import("./store.mjs").Row} Row */
/** @typedef {import("./types.mjs").SemanticState} SemanticState */

/**
 * @typedef {Object} RowView
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {string} age
 * @property {string} place
 * @property {string} folderKey
 * @property {string} folderName
 * @property {string} folderPath
 * @property {boolean} pinned
 * @property {SemanticState} state
 * @property {boolean} alive
 * @property {boolean} hostAlive
 * @property {boolean} needsInput
 * @property {boolean} hasError
 * @property {boolean} worktree
 * @property {boolean} unread
 * @property {boolean} reviewReady
 * @property {number} evidenceErrorCount
 * @property {boolean} diagnosticStalled
 * @property {number} diagnosticErrorCount
 * @property {number} followUpCount
 * @property {string|null} followUpPreview
 * @property {string} steeringState
 * @property {number} lastActivityAt
 */

/** @param {Row} row @returns {SemanticState} */
export function rowState(row) {
	return row.state?.semanticState ?? "queued";
}

/**
 * State glyph (plain unicode; the dashboard colors it via theme).
 * @param {SemanticState} state
 * @param {boolean} alive
 * @param {boolean} [hostAlive]
 * @param {boolean} [unread]
 * @returns {string}
 */
export function stateGlyph(state, alive, hostAlive = false, unread = false) {
	switch (state) {
		case "needs_input":
			return unread ? "◆" : "◇";
		case "working":
			return alive ? (unread ? "◉" : "●") : (unread ? "◕" : "◐");
		case "queued":
			return hostAlive ? (unread ? "◍" : "◌") : (unread ? "◎" : "○");
		case "completed":
			return hostAlive ? (unread ? "◍" : "◌") : (unread ? "✔" : "✓");
		case "failed":
			return unread ? "✖" : "✗";
		case "idle":
			return unread ? "●" : "·";
		case "stopped":
			return unread ? "■" : "▪";
		default:
			return "?";
	}
}

/**
 * Theme color name appropriate for a state (consumed by the dashboard).
 * @param {SemanticState} state
 * @returns {string}
 */
export function stateColor(state) {
	switch (state) {
		case "needs_input":
			return "warning";
		case "working":
			return "accent";
		case "queued":
			return "muted";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "idle":
			return "dim";
		case "stopped":
			return "muted";
		default:
			return "text";
	}
}

/**
 * @param {Row} row
 * @param {number} now
 * @returns {RowView}
 */
export function rowView(row, now) {
	const state = rowState(row);
	const summary = oneLine(normalizeGenericStatusText(state, row.state?.summary));
	const lastActivityAt = row.state?.lastActivityAt ?? row.meta.updatedAt ?? row.meta.createdAt;
	const worktree = row.meta.worktreeMode === "worktree";
	const folderPath = row.meta.repoCwd || row.meta.cwd;
	const folderName = baseName(folderPath) + (worktree ? "⌥" : "");
	const folderKey = normalizeFolderKey(folderPath);
	const place = folderName;
	const lastVisitedAt = row.state?.lastVisitedAt ?? null;
	const lastAgentActivityAt = row.state?.lastAgentActivityAt ?? null;
	return {
		id: row.meta.id,
		name: row.meta.name,
		summary,
		age: relativeTime(lastActivityAt, now),
		place,
		folderKey,
		folderName,
		folderPath,
		pinned: Boolean(row.meta.pinned),
		state,
		alive: Boolean(row.alive),
		hostAlive: Boolean(row.hostAlive),
		needsInput: state === "needs_input",
		hasError: state === "failed",
		worktree,
		unread: lastAgentActivityAt !== null && (lastVisitedAt === null || lastAgentActivityAt > lastVisitedAt),
		reviewReady: Boolean(row.state?.review?.ready),
		evidenceErrorCount: row.state?.review?.errorCount ?? 0,
		diagnosticStalled: Boolean(row.state?.diagnostics?.stalled),
		diagnosticErrorCount: row.state?.diagnostics?.errorCount ?? 0,
		followUpCount: row.state?.followUps?.queuedCount ?? 0,
		followUpPreview: row.state?.followUps?.lastQueuedPreview ?? null,
		steeringState: row.state?.steering?.status ?? "none",
		lastActivityAt,
	};
}

/** @param {string} text */
function oneLine(text) {
	return String(text || "").replace(/\s+/g, " ").trim() || "—";
}

/**
 * Group rows by semantic state in GROUP_ORDER. Within a group: pinned first, then most
 * recently active first. Empty groups are omitted.
 * @param {Row[]} rows
 * @param {number} now
 * @returns {Array<{ state: SemanticState, label: string, rows: RowView[] }>}
 */
export function groupRows(rows, now) {
	const views = rows.map((r) => rowView(r, now));
	/** @type {Array<{state: SemanticState, label: string, rows: RowView[]}>} */
	const groups = [];
	for (const state of GROUP_ORDER) {
		const inGroup = sortRowViews(views.filter((v) => v.state === state));
		if (inGroup.length > 0) groups.push({ state, label: GROUP_LABELS[state], rows: inGroup });
	}
	return groups;
}

/**
 * Group rows first by semantic state, then by repo/folder within that state.
 * `showFolders` is true only when a stage spans more than one folder, so a stage backed by
 * a single folder renders as a flat list (no redundant folder header).
 * @param {Row[]} rows
 * @param {number} now
 * @returns {Array<{ state: SemanticState, label: string, rowCount: number, showFolders: boolean, folders: Array<{ key: string, name: string, path: string, rows: RowView[], lastActivityAt: number, pinned: boolean }> }>}
 */
export function groupRowsByFolder(rows, now) {
	const views = rows.map((r) => rowView(r, now));
	const groups = [];
	for (const state of GROUP_ORDER) {
		const inState = views.filter((v) => v.state === state);
		if (inState.length === 0) continue;
		const byFolder = new Map();
		for (const view of inState) {
			const key = view.folderKey;
			const existing = byFolder.get(key);
			if (existing) existing.rows.push(view);
			else byFolder.set(key, { key, name: view.folderName, path: view.folderPath, rows: [view], lastActivityAt: view.lastActivityAt, pinned: view.pinned });
		}
		const folders = [...byFolder.values()].map((folder) => {
			folder.rows = sortRowViews(folder.rows);
			folder.lastActivityAt = Math.max(...folder.rows.map((r) => r.lastActivityAt));
			folder.pinned = folder.rows.some((r) => r.pinned);
			return folder;
		}).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name));
		const showFolders = folders.length > 1;
		groups.push({ state, label: GROUP_LABELS[state], rowCount: inState.length, showFolders, folders });
	}
	return groups;
}

/** @param {RowView[]} views */
function sortRowViews(views) {
	return views.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
}

/** @param {string} path */
function normalizeFolderKey(path) {
	return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/**
 * Parse a filter query into a state filter + free-text terms.
 * Supports `s:<state>` (state prefix) and bare words (AND substring match).
 * @param {string} query
 * @returns {{ states: SemanticState[], terms: string[], reviewReady: boolean, diagStalled: boolean, evidenceError: boolean, queued: boolean, steering: string|null }}
 */
export function parseFilter(query) {
	/** @type {Set<SemanticState>} */
	const states = new Set();
	/** @type {string[]} */
	const terms = [];
	let reviewReady = false;
	let diagStalled = false;
	let evidenceError = false;
	let queued = false;
	let steering = null;
	for (const tok of String(query || "").trim().split(/\s+/).filter(Boolean)) {
		const m = /^s:(.+)$/i.exec(tok);
		if (m) {
			const want = normalizeStateToken(m[1]);
			for (const s of SEMANTIC_STATES) {
				const aliases = [s, GROUP_LABELS[s]];
				if (aliases.some((alias) => matchesStateToken(alias, want))) states.add(s);
			}
		} else if (/^review:ready$/i.test(tok)) {
			reviewReady = true;
		} else if (/^diag:stalled$/i.test(tok)) {
			diagStalled = true;
		} else if (/^evidence:error$/i.test(tok)) {
			evidenceError = true;
		} else if (/^queued:(true|yes|1)$/i.test(tok)) {
			queued = true;
		} else if (/^steer:/i.test(tok)) {
			steering = normalizeStateToken(tok.replace(/^steer:/i, ""));
		} else {
			terms.push(tok.toLowerCase());
		}
	}
	return { states: [...states], terms, reviewReady, diagStalled, evidenceError, queued, steering };
}

/** @param {string} value */
function normalizeStateToken(value) {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** @param {string} alias @param {string} want */
function matchesStateToken(alias, want) {
	const normalized = normalizeStateToken(alias);
	return normalized === want || normalized.startsWith(want);
}

/** @param {string} query @returns {boolean} whether the text is a filter expression. */
export function isFilterQuery(query) {
	return /(^|\s)(s:|review:|diag:|evidence:|queued:|steer:)/i.test(query || "");
}

/**
 * Filter rows by a query string.
 * @param {Row[]} rows
 * @param {string} query
 * @returns {Row[]}
 */
export function filterRows(rows, query) {
	const { states, terms, reviewReady, diagStalled, evidenceError, queued, steering } = parseFilter(query);
	if (states.length === 0 && terms.length === 0 && !reviewReady && !diagStalled && !evidenceError && !queued && !steering) return rows;
	return rows.filter((row) => {
		if (states.length > 0 && !states.includes(rowState(row))) return false;
		if (reviewReady && !row.state?.review?.ready) return false;
		if (diagStalled && !row.state?.diagnostics?.stalled) return false;
		if (evidenceError && (row.state?.review?.errorCount ?? 0) <= 0) return false;
		if (queued && (row.state?.followUps?.queuedCount ?? 0) <= 0) return false;
		if (steering && normalizeStateToken(row.state?.steering?.status ?? "none") !== steering) return false;
		if (terms.length === 0) return true;
		const hay = [row.meta.name, row.state?.summary ?? "", row.meta.repoCwd, row.meta.cwd]
			.join(" ")
			.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}
