/**
 * State-machine + summary derivation. Pure functions over a RunStatus.
 *
 * Semantic-state rules (plan §9.1):
 *   while alive:   queued → working (once assistant/tool activity begins)
 *   clean exit:    needs_input (asked a question) | completed | idle
 *   bad exit:      failed
 *   user stop:     stopped
 * Summary priority (plan §9.3): model → active tool → blocker → first sentence → error → fallback.
 */
import { firstSentence, truncate } from "./heuristics.mjs";

/** @typedef {import("./types.mjs").RunStatus} RunStatus */
/** @typedef {import("./types.mjs").SemanticState} SemanticState */

/**
 * Compute the terminal semantic state for a finished run.
 * @param {{ exitCode:number|null, stopReason:string|null, stoppedByUser:boolean, needsInput:boolean, openEnded?:boolean }} p
 * @returns {SemanticState}
 */
export function finalizeSemanticState({ exitCode, stopReason, stoppedByUser, needsInput, openEnded = false }) {
	if (stoppedByUser) return "stopped";
	const errored = (exitCode != null && exitCode !== 0) || stopReason === "error" || stopReason === "aborted";
	if (errored) return "failed";
	if (needsInput) return "needs_input";
	if (openEnded) return "idle";
	return "completed";
}

/**
 * Fallback status text when no richer summary is available.
 * @param {SemanticState} state
 * @returns {string}
 */
export function fallbackStatusText(state) {
	switch (state) {
		case "queued":
			return "Queued";
		case "working":
			return "Working…";
		case "needs_input":
			return "Needs input";
		case "idle":
			return "Idle";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "stopped":
			return "Stopped";
		default:
			return "Unknown";
	}
}

/**
 * Heuristic summary for a run (no model). Honors the documented priority order.
 * @param {RunStatus} status
 * @param {number} [max] max characters
 * @returns {string}
 */
export function deriveSummary(status, max = 80) {
	const s = status;
	// 2. active tool (only while still working)
	if (s.processState === "alive" && s.currentTool?.name) {
		// currentTool.summary is precomputed by the reducer; fall back to name.
		const ct = /** @type {any} */ (s.currentTool);
		if (typeof ct.summary === "string" && ct.summary) return truncate(ct.summary, max);
		return truncate(ct.name, max);
	}
	// 3. explicit blocker / question
	if (s.semanticState === "needs_input" && s.question) return truncate(s.question, max);
	// 5. error (placed above generic preview for failed runs)
	if (s.semanticState === "failed" && s.error) return truncate(s.error, max);
	// 4. first sentence of latest assistant output (fall back to full text if the first
	// sentence is uninformatively short, e.g. "Done.")
	if (s.latestAssistantPreview) {
		const fs = firstSentence(s.latestAssistantPreview);
		const pick = fs.length >= 12 ? fs : s.latestAssistantPreview;
		return truncate(pick, max);
	}
	if (s.question) return truncate(s.question, max);
	if (s.error) return truncate(s.error, max);
	// 6. fallback status text
	return fallbackStatusText(s.semanticState);
}
