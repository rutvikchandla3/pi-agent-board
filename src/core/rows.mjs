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
 * @property {boolean} pinned
 * @property {SemanticState} state
 * @property {boolean} alive
 * @property {boolean} hostAlive
 * @property {boolean} needsInput
 * @property {boolean} hasError
 * @property {boolean} worktree
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
 * @returns {string}
 */
export function stateGlyph(state, alive, hostAlive = false) {
	switch (state) {
		case "needs_input":
			return "◆";
		case "working":
			return alive ? "●" : "◐";
		case "queued":
			return hostAlive ? "◌" : "○";
		case "completed":
			return hostAlive ? "◌" : "✓";
		case "failed":
			return "✗";
		case "idle":
			return "·";
		case "stopped":
			return "■";
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
	const place = baseName(row.meta.repoCwd || row.meta.cwd) + (worktree ? "⌥" : "");
	return {
		id: row.meta.id,
		name: row.meta.name,
		summary,
		age: relativeTime(lastActivityAt, now),
		place,
		pinned: Boolean(row.meta.pinned),
		state,
		alive: Boolean(row.alive),
		hostAlive: Boolean(row.hostAlive),
		needsInput: state === "needs_input",
		hasError: state === "failed",
		worktree,
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
		const inGroup = views
			.filter((v) => v.state === state)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
		if (inGroup.length > 0) groups.push({ state, label: GROUP_LABELS[state], rows: inGroup });
	}
	return groups;
}

/**
 * Parse a filter query into a state filter + free-text terms.
 * Supports `s:<state>` (state prefix) and bare words (AND substring match).
 * @param {string} query
 * @returns {{ states: SemanticState[], terms: string[] }}
 */
export function parseFilter(query) {
	/** @type {Set<SemanticState>} */
	const states = new Set();
	/** @type {string[]} */
	const terms = [];
	for (const tok of String(query || "").trim().split(/\s+/).filter(Boolean)) {
		const m = /^s:(.+)$/i.exec(tok);
		if (m) {
			const want = normalizeStateToken(m[1]);
			for (const s of SEMANTIC_STATES) {
				const aliases = [s, GROUP_LABELS[s]];
				if (aliases.some((alias) => matchesStateToken(alias, want))) states.add(s);
			}
		} else {
			terms.push(tok.toLowerCase());
		}
	}
	return { states: [...states], terms };
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
	return /(^|\s)s:/i.test(query || "");
}

/**
 * Filter rows by a query string.
 * @param {Row[]} rows
 * @param {string} query
 * @returns {Row[]}
 */
export function filterRows(rows, query) {
	const { states, terms } = parseFilter(query);
	if (states.length === 0 && terms.length === 0) return rows;
	return rows.filter((row) => {
		if (states.length > 0 && !states.includes(rowState(row))) return false;
		if (terms.length === 0) return true;
		const hay = [row.meta.name, row.state?.summary ?? "", row.meta.repoCwd, row.meta.cwd]
			.join(" ")
			.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}
