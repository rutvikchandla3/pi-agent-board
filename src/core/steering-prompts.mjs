/** Prompt builders for steering-first Agent Board workflows. */

/** @param {string} userText */
export function buildPlanRequestPrompt(userText = "") {
	const extra = String(userText || "").trim();
	return [
		"Create an implementation plan only. Do not modify files unless explicitly instructed by the user.",
		"Return: scope, assumptions, proposed steps, validation plan, risks, and open questions.",
		"This Agent Board plan mode is advisory; hard tool restrictions may not be enforced by the runtime yet.",
		extra ? `User request/context: ${extra}` : "Use the current session context and repository state.",
	].join("\n\n");
}

/** @param {string} planText */
export function buildApprovePlanPrompt(planText = "") {
	return [
		"The user approved the plan below. Implement it now.",
		"When finished, summarize changed files, commands/tests run, validation results, and residual risks for the Agent Board evidence panel.",
		"Plan:",
		String(planText || "(no plan text captured)"),
	].join("\n\n");
}

/** @param {string} planText @param {string} feedback */
export function buildPlanChangesPrompt(planText = "", feedback = "") {
	return [
		"Revise the implementation plan based on the user's feedback. Do not implement yet.",
		"Return the revised plan and call out what changed.",
		"Current plan:",
		String(planText || "(no prior plan captured)"),
		"User feedback:",
		String(feedback || "(no feedback supplied)"),
	].join("\n\n");
}
