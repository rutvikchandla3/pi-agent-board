/** Durable steering / plan-approval state helpers. */
import { atomicWriteJson, readJson } from "./atomic.mjs";
import { truncate } from "./heuristics.mjs";
import * as P from "./paths.mjs";

const STATES = new Set(["none", "plan_requested", "awaiting_approval", "approved", "changes_requested", "executing_approved_plan"]);

/** @param {string} viewId @param {number} [now] @returns {import("./types.mjs").SteeringState} */
export function emptySteeringState(viewId, now = Date.now()) {
	return {
		version: 1,
		viewId,
		status: "none",
		updatedAt: now,
		planText: "",
		planRunId: null,
		approvedAt: null,
		changeRequest: null,
		executionRunId: null,
		history: [],
	};
}

/** @param {string} root @param {string} viewId */
export function readSteering(root, viewId) {
	return normalizeSteering(readJson(P.steeringPath(root, viewId), null), viewId);
}

/** @param {string} root @param {import("./types.mjs").SteeringState} state */
export function writeSteering(root, state) {
	const normalized = normalizeSteering(state, state.viewId);
	normalized.updatedAt = Date.now();
	atomicWriteJson(P.steeringPath(root, normalized.viewId), normalized);
	return normalized;
}

/** @param {import("./types.mjs").SteeringState} state @returns {import("./types.mjs").SteeringSummary} */
export function summarizeSteering(state) {
	const s = normalizeSteering(state, state?.viewId ?? "");
	return {
		status: s.status,
		awaitingApproval: s.status === "awaiting_approval",
		planPreview: s.planText ? truncate(s.planText.replace(/\s+/g, " ").trim(), 180) : null,
		updatedAt: s.updatedAt ?? null,
		question: s.status === "awaiting_approval" ? "Approve this plan?" : null,
	};
}

/** @param {string} root @param {string} viewId @param {{ runId?: string|null, note?: string }} [opts] */
export function requestPlan(root, viewId, opts = {}) {
	const state = readSteering(root, viewId);
	transition(state, "plan_requested", "request_plan", opts.runId ?? null, opts.note ?? null);
	state.planRunId = opts.runId ?? state.planRunId ?? null;
	return writeSteering(root, state);
}

/** @param {string} root @param {string} viewId @param {{ runId?: string|null, planText: string, note?: string }} opts */
export function recordPlanReady(root, viewId, opts) {
	const state = readSteering(root, viewId);
	state.planText = String(opts.planText || "").trim();
	state.planRunId = opts.runId ?? state.planRunId ?? null;
	transition(state, "awaiting_approval", "plan_ready", opts.runId ?? null, opts.note ?? null);
	return writeSteering(root, state);
}

/** @param {string} root @param {string} viewId @param {{ runId?: string|null, note?: string }} [opts] */
export function approvePlan(root, viewId, opts = {}) {
	const state = readSteering(root, viewId);
	if (state.status !== "awaiting_approval") return { ok: false, error: "No plan is awaiting approval", state };
	state.approvedAt = Date.now();
	state.executionRunId = opts.runId ?? null;
	transition(state, "approved", "approve_plan", opts.runId ?? null, opts.note ?? null);
	const saved = writeSteering(root, state);
	return { ok: true, state: saved };
}

/** @param {string} root @param {string} viewId @param {string} feedback @param {{ runId?: string|null }} [opts] */
export function requestPlanChanges(root, viewId, feedback, opts = {}) {
	const clean = String(feedback || "").trim();
	if (!clean) return { ok: false, error: "Empty change request", state: readSteering(root, viewId) };
	const state = readSteering(root, viewId);
	state.changeRequest = clean;
	transition(state, "changes_requested", "request_plan_changes", opts.runId ?? null, clean);
	const saved = writeSteering(root, state);
	return { ok: true, state: saved };
}

/** @param {string} root @param {string} viewId @param {{ runId?: string|null }} [opts] */
export function markExecutingApprovedPlan(root, viewId, opts = {}) {
	const state = readSteering(root, viewId);
	state.executionRunId = opts.runId ?? state.executionRunId ?? null;
	transition(state, "executing_approved_plan", "execute_approved_plan", opts.runId ?? null, null);
	return writeSteering(root, state);
}

/** @param {string} root @param {string} viewId @param {{ note?: string }} [opts] */
export function resetSteering(root, viewId, opts = {}) {
	const state = readSteering(root, viewId);
	transition(state, "none", "reset", null, opts.note ?? null);
	state.planText = "";
	state.planRunId = null;
	state.approvedAt = null;
	state.changeRequest = null;
	state.executionRunId = null;
	return writeSteering(root, state);
}

/** @param {any} state @param {string} viewId @returns {import("./types.mjs").SteeringState} */
function normalizeSteering(state, viewId) {
	const base = emptySteeringState(viewId || state?.viewId || "");
	if (!state || typeof state !== "object") return base;
	return {
		...base,
		...state,
		viewId: typeof state.viewId === "string" ? state.viewId : base.viewId,
		status: STATES.has(state.status) ? state.status : "none",
		planText: typeof state.planText === "string" ? state.planText : "",
		planRunId: typeof state.planRunId === "string" ? state.planRunId : null,
		approvedAt: Number.isFinite(state.approvedAt) ? state.approvedAt : null,
		changeRequest: typeof state.changeRequest === "string" ? state.changeRequest : null,
		executionRunId: typeof state.executionRunId === "string" ? state.executionRunId : null,
		history: Array.isArray(state.history) ? state.history : [],
	};
}

/** @param {import("./types.mjs").SteeringState} state @param {import("./types.mjs").SteeringModeState} to @param {string} action @param {string|null} runId @param {string|null} note */
function transition(state, to, action, runId, note) {
	const now = Date.now();
	const from = state.status;
	state.status = to;
	state.updatedAt = now;
	state.history.push({ at: now, from, to, action, runId, note: note ? truncate(note, 240) : null });
}
