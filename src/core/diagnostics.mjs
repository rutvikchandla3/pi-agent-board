/** Diagnostics JSONL helpers for Agent Board rows. */
import { atomicWrite, appendJsonl, readJsonl, readJsonlTail } from "./atomic.mjs";
import * as P from "./paths.mjs";

const SECRET_KEY_RE = /token|secret|password|authorization|api[_-]?key/i;

/**
 * @param {string} root
 * @param {string} viewId
 * @param {Partial<import("./types.mjs").DiagnosticEvent>} patch
 * @returns {import("./types.mjs").DiagnosticEvent}
 */
export function appendDiagnostic(root, viewId, patch = {}) {
	const event = normalizeDiagnostic(viewId, patch);
	appendJsonl(P.diagnosticsPath(root, viewId), event);
	return event;
}

/** @param {string} root @param {string} viewId @returns {import("./types.mjs").DiagnosticEvent[]} */
export function readDiagnostics(root, viewId) {
	return readJsonl(P.diagnosticsPath(root, viewId)).map((e) => normalizeDiagnostic(viewId, e));
}

/**
 * @param {string} root
 * @param {string} viewId
 * @param {{ limit?: number }} [opts]
 * @returns {import("./types.mjs").DiagnosticEvent[]}
 */
export function tailDiagnostics(root, viewId, opts = {}) {
	return readJsonlTail(P.diagnosticsPath(root, viewId), opts.limit ?? 50).map((e) => normalizeDiagnostic(viewId, e));
}

/** @param {string} root @param {string} viewId */
export function clearDiagnostics(root, viewId) {
	atomicWrite(P.diagnosticsPath(root, viewId), "");
	return { ok: true };
}

/** @returns {import("./types.mjs").DiagnosticSummary} */
export function emptyDiagnosticSummary() {
	return {
		count: 0,
		warningCount: 0,
		errorCount: 0,
		lastAt: null,
		lastLevel: null,
		lastCode: null,
		lastMessage: null,
		stalled: false,
		stallReason: null,
	};
}

/** @param {import("./types.mjs").DiagnosticEvent[]} events @returns {import("./types.mjs").DiagnosticSummary} */
export function summarizeDiagnostics(events) {
	const summary = emptyDiagnosticSummary();
	for (const event of events ?? []) {
		summary.count += 1;
		if (event.level === "warn") summary.warningCount += 1;
		if (event.level === "error") summary.errorCount += 1;
		summary.lastAt = event.at ?? summary.lastAt;
		summary.lastLevel = event.level ?? summary.lastLevel;
		summary.lastCode = event.code ?? summary.lastCode;
		summary.lastMessage = event.message ?? summary.lastMessage;
		if (event.code === "provider_stall" || event.code === "stalled") {
			summary.stalled = true;
			summary.stallReason = String(event.details?.reason ?? event.message ?? "stalled");
		}
		if (event.code === "provider_stall_resolved" || event.code === "stall_resolved") {
			summary.stalled = false;
			summary.stallReason = null;
		}
	}
	return summary;
}

/** @param {string} root @param {string} viewId */
export function readDiagnosticSummary(root, viewId) {
	return summarizeDiagnostics(readDiagnostics(root, viewId));
}

/** @param {string} viewId @param {any} patch @returns {import("./types.mjs").DiagnosticEvent} */
export function normalizeDiagnostic(viewId, patch = {}) {
	const level = ["info", "warn", "error"].includes(patch.level) ? patch.level : "info";
	const code = typeof patch.code === "string" && patch.code ? patch.code : "event";
	return {
		version: 1,
		at: Number.isFinite(patch.at) ? patch.at : Date.now(),
		viewId,
		runId: typeof patch.runId === "string" ? patch.runId : null,
		source: typeof patch.source === "string" && patch.source ? patch.source : "service",
		level,
		code,
		message: typeof patch.message === "string" && patch.message ? patch.message : code,
		details: redactDiagnosticDetails(patch.details ?? {}),
	};
}

/** @param {any} value @returns {any} */
export function redactDiagnosticDetails(value) {
	if (Array.isArray(value)) return value.map((v) => redactDiagnosticDetails(v));
	if (!value || typeof value !== "object") return value;
	const out = {};
	for (const [key, val] of Object.entries(value)) {
		out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redactDiagnosticDetails(val);
	}
	return out;
}
