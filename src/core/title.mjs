/** Title-generation helpers for session names. */

/** Default cheap model for session titles. Override via $AGENT_BOARD_TITLE_MODEL. */
export const DEFAULT_TITLE_MODEL = "openai-codex/gpt-5.5";

/** Default thinking level for session titles. Override via $AGENT_BOARD_TITLE_THINKING_LEVEL. */
export const DEFAULT_TITLE_THINKING_LEVEL = "low";

/**
 * Prompt for a short session title derived from the user's initial task.
 * @param {string} taskPrompt
 */
export function titlePrompt(taskPrompt) {
	return [
		"Write a concise title for this coding task.",
		"Rules:",
		"- 3 or 4 words max",
		"- plain text only",
		"- no quotes",
		"- no markdown",
		"- describe the task, not the format",
		"",
		`Task: ${String(taskPrompt || "").trim()}`,
	].join("\n");
}

/**
 * Normalize a model-generated title into a compact dashboard label.
 * @param {string|null|undefined} text
 * @param {string} fallback
 * @param {number} [maxWords]
 */
export function normalizeGeneratedTitle(text, fallback, maxWords = 4) {
	const cleaned = String(text || "")
		.replace(/^\s*(title\s*:\s*)?/i, "")
		.replace(/^['"`\-–—•*\s]+|['"`\-–—•*\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	const words = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords);
	const compact = words.join(" ").replace(/[.,;:!?]+$/g, "").trim();
	return compact || fallback;
}
