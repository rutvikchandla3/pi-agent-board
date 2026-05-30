/**
 * Reduce Pi JSON-mode worker events into an evolving RunStatus.
 *
 * Event vocabulary (verified against dist `agent-session.ts`; see docs/EXPLORATION.md §4):
 *   first line: session header {type:"session",...}
 *   message_start | message_update | message_end   (.message is an AgentMessage)
 *   tool_execution_start {toolCallId,toolName,args}
 *   tool_execution_end {toolCallId,toolName,result,isError}
 *   turn_start | turn_end | agent_start | agent_end
 * NOTE: `tool_result_end` (used by the subagent example) is never emitted — do not rely on it.
 */
import { deriveSummary, finalizeSemanticState } from "./derive.mjs";
import { assistantText, detectNeedsInput, toolPath, toolSummary, truncate } from "./heuristics.mjs";

/** @typedef {import("./types.mjs").RunConfig} RunConfig */
/** @typedef {import("./types.mjs").RunStatus} RunStatus */

const PREVIEW_MAX = 240;

/**
 * Build the initial status for a freshly-launched run.
 * @param {RunConfig} config
 * @param {number|null} pid
 * @param {number} now
 * @returns {RunStatus}
 */
export function createRunStatus(config, pid, now) {
	/** @type {RunStatus} */
	const status = {
		version: 1,
		runId: config.runId,
		viewId: config.viewId,
		pid,
		startedAt: now,
		endedAt: null,
		exitCode: null,
		kind: config.kind,
		prompt: config.prompt,
		model: config.model ?? null,
		semanticState: "queued",
		processState: "alive",
		summary: "Queued",
		lastActivityAt: now,
		currentTool: null,
		latestAssistantPreview: "",
		question: null,
		error: null,
		stopReason: null,
		stoppedByUser: false,
		turns: 0,
		toolCount: 0,
	};
	return status;
}

/**
 * Apply a single worker event to `status` (mutates in place).
 * @param {RunStatus} status
 * @param {any} event
 * @param {number} now
 * @returns {boolean} whether this event produced a user-visible change worth persisting.
 */
export function reduceEvent(status, event, now) {
	if (!event || typeof event !== "object" || typeof event.type !== "string") return false;
	let meaningful = false;

	switch (event.type) {
		case "tool_execution_start": {
			const name = event.toolName ?? event.args?.name ?? "tool";
			const args = event.args ?? {};
			status.currentTool = { name, path: toolPath(args), summary: toolSummary(name, args) };
			status.toolCount += 1;
			status.semanticState = "working";
			status.lastActivityAt = now;
			meaningful = true;
			break;
		}
		case "tool_execution_end": {
			if (event.isError) status.error = status.error ?? `Tool ${event.toolName ?? ""} failed`.trim();
			status.currentTool = null;
			status.semanticState = "working";
			status.lastActivityAt = now;
			meaningful = true;
			break;
		}
		case "message_start": {
			if (event.message?.role === "assistant") {
				status.semanticState = "working";
				status.lastActivityAt = now;
			}
			break;
		}
		case "message_end": {
			const msg = event.message;
			if (msg?.role === "assistant") {
				status.turns += 1;
				if (msg.model && !status.model) status.model = msg.model;
				if (msg.stopReason) status.stopReason = msg.stopReason;
				if (msg.errorMessage) status.error = msg.errorMessage;
				const text = assistantText(msg);
				if (text) {
					// Store the full latest text (truncated) so peek shows meaningful output;
					// deriveSummary() condenses it to a first sentence for the row.
					status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
					const nb = detectNeedsInput(text);
					status.question = nb.question;
				}
				status.semanticState = "working";
				status.lastActivityAt = now;
				meaningful = true;
			}
			break;
		}
		case "agent_start":
		case "turn_start":
		case "turn_end":
			status.lastActivityAt = now;
			break;
		default:
			break;
	}

	if (meaningful) status.summary = deriveSummary(status);
	return meaningful;
}

/**
 * Mark a run finished and compute its terminal state + summary.
 * @param {RunStatus} status
 * @param {{ exitCode:number|null, stoppedByUser?:boolean, openEnded?:boolean }} opts
 * @param {number} now
 * @returns {RunStatus}
 */
export function finalizeRun(status, opts, now) {
	status.endedAt = now;
	status.exitCode = opts.exitCode;
	status.processState = "exited";
	status.pid = null;
	status.stoppedByUser = Boolean(opts.stoppedByUser);
	status.currentTool = null;

	const nb = detectNeedsInput(status.latestAssistantPreview);
	const needsInput = nb.needsInput || Boolean(status.question);
	if (needsInput && !status.question) status.question = nb.question;

	status.semanticState = finalizeSemanticState({
		exitCode: status.exitCode,
		stopReason: status.stopReason,
		stoppedByUser: status.stoppedByUser,
		needsInput,
		openEnded: opts.openEnded,
	});
	status.lastActivityAt = now;
	status.summary = deriveSummary(status);
	return status;
}

/**
 * Project a RunStatus into the row-level ViewState written to `state.json`.
 * @param {RunStatus} status
 * @param {number} now
 * @returns {import("./types.mjs").ViewState}
 */
export function projectViewState(status, now) {
	return {
		version: 1,
		viewId: status.viewId,
		currentRunId: status.runId,
		semanticState: status.semanticState,
		processState: status.processState,
		summary: status.summary,
		lastActivityAt: status.lastActivityAt,
		updatedAt: now,
		needsInput: status.semanticState === "needs_input",
		hasError: status.semanticState === "failed",
		latestAssistantPreview: status.latestAssistantPreview,
		latestTool: status.currentTool ? { name: status.currentTool.name, path: status.currentTool.path } : null,
		question: status.question,
		error: status.error,
	};
}
