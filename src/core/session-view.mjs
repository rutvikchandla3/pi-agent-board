/**
 * Read and project a managed Pi session file into a simple display model for the
 * dashboard's non-interrupting session view.
 *
 * We show the current active branch only: starting from the last appended entry
 * (the active leaf in normal Pi append semantics), walk parentId links to root,
 * then render messages / visible custom messages / summaries on that branch.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * @typedef {Object} SessionViewItem
 * @property {string} id
 * @property {"user"|"assistant"|"custom"|"note"} role
 * @property {string} label
 * @property {string} text
 * @property {string} timestamp
 * @property {string} entryType
 */

/**
 * @typedef {Object} SessionViewData
 * @property {{ id:string, cwd:string }|null} header
 * @property {SessionViewItem[]} items
 * @property {string|null} error
 */

/**
 * Load and parse one session file.
 * @param {string} sessionFile
 * @returns {SessionViewData}
 */
export function loadSessionView(sessionFile) {
	if (!sessionFile || !existsSync(sessionFile)) {
		return { header: null, items: [], error: "Session file not created yet." };
	}
	try {
		return parseSessionText(readFileSync(sessionFile, "utf8"));
	} catch (err) {
		return {
			header: null,
			items: [],
			error: `Couldn't read session: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Parse session JSONL into a displayable active branch.
 * @param {string} text
 * @returns {SessionViewData}
 */
export function parseSessionText(text) {
	/** @type {{ id:string, cwd:string }|null} */
	let header = null;
	/** @type {any[]} */
	const entries = [];
	/** @type {Map<string, any>} */
	const byId = new Map();

	for (const rawLine of String(text || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session") {
			header = { id: String(entry.id || ""), cwd: String(entry.cwd || "") };
			continue;
		}
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		entries.push(entry);
		byId.set(entry.id, entry);
	}

	if (entries.length === 0) return { header, items: [], error: null };

	const leaf = entries[entries.length - 1];
	const branch = activeBranch(leaf, byId);
	const items = branch.flatMap(displayItemsForEntry);
	return { header, items, error: null };
}

/**
 * Walk from `leaf` to root following parentId pointers.
 * @param {any} leaf
 * @param {Map<string, any>} byId
 * @returns {any[]}
 */
function activeBranch(leaf, byId) {
	/** @type {any[]} */
	const out = [];
	const seen = new Set();
	let cur = leaf;
	while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
		out.push(cur);
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
	}
	out.reverse();
	return out;
}

/**
 * @param {any} entry
 * @returns {SessionViewItem[]}
 */
function displayItemsForEntry(entry) {
	switch (entry?.type) {
		case "message": {
			const role = entry.message?.role;
			const text = contentText(entry.message?.content);
			if (!text) return [];
			if (role === "user") {
				return [{ id: entry.id, role: "user", label: "you", text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
			}
			if (role === "assistant") {
				return [{ id: entry.id, role: "assistant", label: "agent", text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
			}
			return [{ id: entry.id, role: "note", label: String(role || "message"), text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
		}
		case "custom_message": {
			if (entry.display === false) return [];
			const text = contentText(entry.content);
			if (!text) return [];
			return [{
				id: entry.id,
				role: "custom",
				label: String(entry.customType || "context"),
				text,
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}];
		}
		case "branch_summary":
			return [{
				id: entry.id,
				role: "note",
				label: "branch summary",
				text: String(entry.summary || "").trim(),
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}].filter((x) => x.text);
		case "compaction":
			return [{
				id: entry.id,
				role: "note",
				label: "compaction",
				text: String(entry.summary || "").trim(),
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}].filter((x) => x.text);
		default:
			return [];
	}
}

/**
 * Convert Pi message/content blocks to plain text.
 * @param {any} content
 * @returns {string}
 */
function contentText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
