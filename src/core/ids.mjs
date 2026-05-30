/** ID generation for views and runs. */
import { randomBytes } from "node:crypto";

/** @param {string} prefix @returns {string} e.g. "view_8f3a1c2b". */
export function genId(prefix) {
	return `${prefix}_${randomBytes(5).toString("hex")}`;
}

/** @returns {string} a new view (row) id. */
export const newViewId = () => genId("view");

/** @returns {string} a new run id. */
export const newRunId = () => genId("run");

/**
 * Derive a short, filesystem-safe slug from a free-text task, for display names.
 * @param {string} text
 * @param {number} [maxWords]
 * @returns {string}
 */
export function slugifyTask(text, maxWords = 5) {
	const words = String(text)
		.toLowerCase()
		.replace(/[`'"]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, maxWords);
	const slug = words.join("-");
	return slug || "task";
}
