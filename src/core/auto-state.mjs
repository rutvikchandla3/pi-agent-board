/**
 * Automatic terminal-state classification for finished agent turns.
 *
 * The dashboard has three user-facing post-run buckets:
 *   - needs_input  → agent is waiting on the user
 *   - idle         → in progress / worth revisiting
 *   - completed    → done
 *
 * This module is pure (no model/network I/O). Runners may feed model JSON into
 * parseAutoStateModelOutput(); otherwise heuristicAutoState() gives a safe fallback.
 */
import { createHash } from "node:crypto";
import { deriveSummary } from "./derive.mjs";
import { detectNeedsInput, firstSentence, splitSentences, truncate } from "./heuristics.mjs";

/** @typedef {import("./types.mjs").SemanticState} SemanticState */
/** @typedef {"needs_input"|"in_progress"|"done"} AutoStateKind */
/** @typedef {"model"|"heuristic"} AutoStateSource */
/** @typedef {"high"|"medium"|"low"} AutoStateConfidence */

const AUTO_STATE_KINDS = new Set(["needs_input", "in_progress", "done"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const DEFAULT_AUTO_STATE_MODEL = "gpt-4o";

/** @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function autoStateEnabled(env = process.env) {
	const raw = env.AGENT_BOARD_AUTO_STATE ?? env.AGENT_VIEW_AUTO_STATE;
	return !isOff(raw);
}

/** @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env] */
export function autoStateModel(env = process.env) {
	const configured = env.AGENT_BOARD_AUTO_STATE_MODEL ?? env.AGENT_VIEW_AUTO_STATE_MODEL;
	if (isOff(configured)) return null;
	return configured || DEFAULT_AUTO_STATE_MODEL;
}

/** @param {string|undefined} value */
function isOff(value) {
	return typeof value === "string" && /^(0|false|off|no)$/i.test(value.trim());
}

/** @param {AutoStateKind} kind @returns {SemanticState} */
export function semanticStateForAutoKind(kind) {
	switch (kind) {
		case "needs_input":
			return "needs_input";
		case "done":
			return "completed";
		default:
			return "idle";
	}
}

/**
 * Prompt used by runners for the cheap classifier pass.
 * @param {string} latestAssistantText
 */
export function buildAutoStatePrompt(latestAssistantText) {
	const text = truncate(String(latestAssistantText || "").trim(), 6000);
	return `Classify the LAST assistant response for a coding-agent dashboard.\n\nChoose exactly one state:\n- needs_input: the assistant asks the user for a decision, clarification, approval, credentials, or is blocked waiting for the user.\n- in_progress: work is partial, next steps remain, verification is pending/failed, or the assistant says it will continue later.\n- done: the requested work is complete, final answer given, no user input required.\n\nReturn ONLY minified JSON with this shape:\n{"state":"needs_input|in_progress|done","confidence":"high|medium|low","reason":"short reason <=18 words","question":"user-facing question or null"}\n\nLast assistant response:\n${text}`;
}

/**
 * Parse and normalize model JSON. Returns null if the response is unusable.
 * @param {string} raw
 * @param {{ latestAssistantText?: string, now?: number, lastAgentActivityAt?: number|null }} [opts]
 */
export function parseAutoStateModelOutput(raw, opts = {}) {
	const obj = extractJsonObject(raw);
	if (!obj) return null;
	const kind = normalizeKind(obj.state ?? obj.kind ?? obj.status);
	if (!kind) return null;
	const confidence = normalizeConfidence(obj.confidence);
	const latest = opts.latestAssistantText ?? "";
	const nb = detectNeedsInput(latest);
	const question = kind === "needs_input" ? cleanQuestion(obj.question) || nb.question || latestQuestion(latest) : null;
	return makeClassification(kind, {
		source: "model",
		confidence,
		reason: cleanReason(obj.reason) || defaultReason(kind),
		question,
		now: opts.now,
		lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
		latestAssistantText: latest,
	});
}

/**
 * Conservative fallback classifier. It should be useful, but never clever enough to
 * overrule strong question/error signals.
 * @param {string} latestAssistantText
 * @param {{ now?: number, lastAgentActivityAt?: number|null }} [opts]
 */
export function heuristicAutoState(latestAssistantText, opts = {}) {
	const text = String(latestAssistantText || "").trim();
	const nb = detectNeedsInput(text);
	if (nb.needsInput) {
		return makeClassification("needs_input", {
			source: "heuristic",
			confidence: "high",
			reason: "Assistant asked for user input",
			question: nb.question,
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}

	const lower = text.toLowerCase();
	const pending = hasPendingSignal(lower);
	const done = hasDoneSignal(lower);
	if (done && !pending) {
		return makeClassification("done", {
			source: "heuristic",
			confidence: hasStrongDoneSignal(lower) ? "high" : "medium",
			reason: "Assistant reported the work is complete",
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}
	if (pending) {
		return makeClassification("in_progress", {
			source: "heuristic",
			confidence: "medium",
			reason: "Assistant mentioned remaining work or pending verification",
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}
	return makeClassification("in_progress", {
		source: "heuristic",
		confidence: "low",
		reason: "No clear completion or input signal",
		now: opts.now,
		lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
		latestAssistantText: text,
	});
}

/**
 * Pick a model classification when valid, otherwise fall back to heuristics.
 * @param {string} modelOutput
 * @param {string} latestAssistantText
 * @param {{ now?: number, lastAgentActivityAt?: number|null }} [opts]
 */
export function autoStateFromModelOrHeuristic(modelOutput, latestAssistantText, opts = {}) {
	return parseAutoStateModelOutput(modelOutput, { latestAssistantText, ...opts }) ?? heuristicAutoState(latestAssistantText, opts);
}

/**
 * Mutate a RunStatus with a classification. Returns true if state/metadata changed.
 * @param {import("./types.mjs").RunStatus} status
 * @param {import("./types.mjs").AutoStateClassification} classification
 * @param {number} [now]
 */
export function applyAutoStateToStatus(status, classification, now = Date.now()) {
	if (!classification || status.processState === "alive") return false;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return false;
	const nextState = semanticStateForAutoKind(classification.kind);
	const before = `${status.semanticState}|${status.question ?? ""}|${status.summary ?? ""}|${status.autoState?.source ?? ""}|${status.autoState?.textHash ?? ""}`;
	status.semanticState = nextState;
	status.autoState = { ...classification, semanticState: nextState, classifiedAt: now };
	if (nextState === "needs_input") {
		status.question = classification.question || detectNeedsInput(status.latestAssistantPreview).question || latestQuestion(status.latestAssistantPreview);
	} else {
		status.question = null;
	}
	status.summary = deriveSummary(status);
	const after = `${status.semanticState}|${status.question ?? ""}|${status.summary ?? ""}|${status.autoState?.source ?? ""}|${status.autoState?.textHash ?? ""}`;
	return before !== after;
}

/**
 * Mutate a ViewState with a classification. Returns true if state/metadata changed.
 * @param {import("./types.mjs").ViewState} state
 * @param {import("./types.mjs").AutoStateClassification} classification
 * @param {number} [now]
 */
export function applyAutoStateToViewState(state, classification, now = Date.now()) {
	if (!classification || state.processState === "alive") return false;
	if (state.semanticState === "failed" || state.semanticState === "stopped") return false;
	const nextState = semanticStateForAutoKind(classification.kind);
	const before = `${state.semanticState}|${state.question ?? ""}|${state.summary ?? ""}|${state.autoState?.source ?? ""}|${state.autoState?.textHash ?? ""}`;
	state.semanticState = nextState;
	state.needsInput = nextState === "needs_input";
	state.hasError = nextState === "failed";
	state.autoState = { ...classification, semanticState: nextState, classifiedAt: now };
	if (nextState === "needs_input") {
		state.question = classification.question || detectNeedsInput(state.latestAssistantPreview).question || latestQuestion(state.latestAssistantPreview);
	} else {
		state.question = null;
	}
	state.error = nextState === "failed" ? state.error : null;
	state.updatedAt = now;
	state.summary = deriveSummary({
		processState: state.processState,
		semanticState: state.semanticState,
		currentTool: state.latestTool,
		question: state.question,
		error: state.error,
		latestAssistantPreview: state.latestAssistantPreview,
	});
	const after = `${state.semanticState}|${state.question ?? ""}|${state.summary ?? ""}|${state.autoState?.source ?? ""}|${state.autoState?.textHash ?? ""}`;
	return before !== after;
}

/**
 * @param {AutoStateKind} kind
 * @param {{ source: AutoStateSource, confidence?: AutoStateConfidence, reason?: string, question?: string|null, now?: number, lastAgentActivityAt?: number|null, latestAssistantText?: string }} opts
 * @returns {import("./types.mjs").AutoStateClassification}
 */
function makeClassification(kind, opts) {
	const now = opts.now ?? Date.now();
	const semanticState = semanticStateForAutoKind(kind);
	return {
		version: 1,
		kind,
		semanticState,
		confidence: opts.confidence ?? "low",
		source: opts.source,
		reason: truncate(String(opts.reason || defaultReason(kind)).replace(/\s+/g, " ").trim(), 120),
		question: opts.question ? truncate(String(opts.question).replace(/\s+/g, " ").trim(), 240) : null,
		classifiedAt: now,
		lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
		textHash: textHash(opts.latestAssistantText ?? ""),
	};
}

/** @param {string} raw */
function extractJsonObject(raw) {
	const text = String(raw || "").trim();
	if (!text) return null;
	const candidates = [text];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced) candidates.unshift(fenced[1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.unshift(text.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** @param {any} value @returns {AutoStateKind|null} */
function normalizeKind(value) {
	const s = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	if (AUTO_STATE_KINDS.has(s)) return /** @type {AutoStateKind} */ (s);
	if (["needsinput", "input", "input_required", "requires_input", "awaiting_input", "blocked", "question"].includes(s)) return "needs_input";
	if (["progress", "ongoing", "continue", "continuing", "partial", "not_done", "todo"].includes(s)) return "in_progress";
	if (["complete", "completed", "finished", "finish", "success", "resolved"].includes(s)) return "done";
	return null;
}

/** @param {any} value @returns {AutoStateConfidence} */
function normalizeConfidence(value) {
	const s = String(value ?? "medium").toLowerCase().trim();
	return CONFIDENCES.has(s) ? /** @type {AutoStateConfidence} */ (s) : "medium";
}

/** @param {any} value */
function cleanReason(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** @param {any} value */
function cleanQuestion(value) {
	const s = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!s || /^null$/i.test(s) || /^none$/i.test(s)) return null;
	return s;
}

/** @param {AutoStateKind} kind */
function defaultReason(kind) {
	switch (kind) {
		case "needs_input":
			return "Assistant is waiting for user input";
		case "done":
			return "Assistant reported completion";
		default:
			return "Assistant appears to have more work remaining";
	}
}

/** @param {string} text */
function latestQuestion(text) {
	const sentences = splitSentences(text);
	return [...sentences].reverse().find((s) => /\?\s*$/.test(s)) ?? null;
}

/** @param {string} lower */
function hasStrongDoneSignal(lower) {
	return /(^|\b)(done|completed|complete|finished|resolved|all set|implemented|shipped)(\b|[.!])/i.test(lower) || /tests? (pass|passed|passing)/i.test(lower);
}

/** @param {string} lower */
function hasDoneSignal(lower) {
	return hasStrongDoneSignal(lower)
		|| /\b(final answer|summary:|i'?ve (fixed|updated|added|implemented)|successfully|ready to go)\b/i.test(lower)
		|| firstSentence(lower).length > 0 && /^done[.!]/i.test(firstSentence(lower));
}

/** @param {string} lower */
function hasPendingSignal(lower) {
	return /\b(todo|next steps?|remaining|still need|need to|not yet|pending|in progress|continue|will continue|i'?ll continue|i will|follow up|not run|couldn'?t run|unable to run|blocked|waiting for)\b/i.test(lower)
		|| /\btests? (fail|failed|failing|pending|not run|weren'?t run|couldn'?t be run)\b/i.test(lower);
}

/** @param {string} text */
function textHash(text) {
	return createHash("sha1").update(String(text || "")).digest("hex").slice(0, 12);
}
