/** Helpers for safely delivering prompts to Pi child processes. */

/**
 * Protect a prompt that is delivered as a positional CLI argument.
 * Pi parses argv before it knows which tokens are prompt text, so a leading `-`
 * would be treated as another flag and abort the run.
 * @param {string} text
 * @returns {string}
 */
export function encodePromptForCliArg(text) {
	const raw = String(text ?? "");
	return /^\s*-/.test(raw) ? ` ${raw}` : raw;
}
