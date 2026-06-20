/** Review evidence extraction and persistence helpers. */
import { assistantText, classifyCommand, toolFileOperation, truncate } from "./heuristics.mjs";
import { atomicWriteJson, readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";

/** @param {{ viewId:string, runId?:string|null, now?:number, source?:string }} opts @returns {import("./types.mjs").EvidenceSnapshot} */
export function emptyEvidenceSnapshot(opts) {
	const now = opts.now ?? Date.now();
	return {
		version: 1,
		viewId: opts.viewId,
		runId: opts.runId ?? null,
		updatedAt: now,
		outcome: "unknown",
		ready: false,
		summary: "",
		commands: [],
		fileChanges: [],
		errors: [],
		assistantEvidence: [],
		usage: null,
		eventCount: 0,
		source: opts.source ?? "events",
	};
}

/** @param {any} snapshot @param {{ viewId:string, runId?:string|null }} fallback @returns {import("./types.mjs").EvidenceSnapshot} */
export function normalizeEvidenceSnapshot(snapshot, fallback) {
	const base = emptyEvidenceSnapshot({ viewId: fallback.viewId, runId: fallback.runId ?? null });
	if (!snapshot || typeof snapshot !== "object") return base;
	return {
		...base,
		...snapshot,
		viewId: typeof snapshot.viewId === "string" ? snapshot.viewId : base.viewId,
		runId: typeof snapshot.runId === "string" ? snapshot.runId : (snapshot.runId === null ? null : base.runId),
		commands: Array.isArray(snapshot.commands) ? snapshot.commands : [],
		fileChanges: Array.isArray(snapshot.fileChanges) ? snapshot.fileChanges : [],
		errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
		assistantEvidence: Array.isArray(snapshot.assistantEvidence) ? snapshot.assistantEvidence : [],
		usage: snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : null,
	};
}

/** @param {string} root @param {string} viewId */
export function readEvidence(root, viewId) {
	return normalizeEvidenceSnapshot(readJson(P.evidencePath(root, viewId), null), { viewId });
}

/** @param {string} root @param {import("./types.mjs").EvidenceSnapshot} snapshot */
export function writeEvidence(root, snapshot) {
	const normalized = normalizeEvidenceSnapshot(snapshot, { viewId: snapshot.viewId, runId: snapshot.runId ?? null });
	normalized.updatedAt = Date.now();
	atomicWriteJson(P.evidencePath(root, normalized.viewId), normalized);
	return normalized;
}

/** @param {string} root @param {string} viewId @param {string} runId */
export function readRunEvidence(root, viewId, runId) {
	return normalizeEvidenceSnapshot(readJson(P.runEvidencePath(root, viewId, runId), null), { viewId, runId });
}

/** @param {string} root @param {import("./types.mjs").EvidenceSnapshot} snapshot */
export function writeRunEvidence(root, snapshot) {
	const normalized = normalizeEvidenceSnapshot(snapshot, { viewId: snapshot.viewId, runId: snapshot.runId ?? null });
	normalized.updatedAt = Date.now();
	if (normalized.runId) atomicWriteJson(P.runEvidencePath(root, normalized.viewId, normalized.runId), normalized);
	return normalized;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @returns {import("./types.mjs").ReviewSummary} */
export function summarizeEvidence(snapshot) {
	const s = normalizeEvidenceSnapshot(snapshot, { viewId: snapshot?.viewId ?? "" });
	const failedCommandCount = s.commands.filter((c) => c.status === "failed").length;
	const latestAssistantEvidence = s.assistantEvidence[s.assistantEvidence.length - 1]?.text ?? "";
	return {
		ready: Boolean(s.ready),
		outcome: s.outcome ?? "unknown",
		fileChangeCount: s.fileChanges.length,
		commandCount: s.commands.length,
		failedCommandCount,
		errorCount: s.errors.length,
		latestAssistantEvidence: truncate(latestAssistantEvidence, 180),
		updatedAt: s.updatedAt ?? null,
	};
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {Partial<import("./types.mjs").EvidenceCommand>} command */
export function upsertEvidenceCommand(snapshot, command) {
	const id = command.id ?? `cmd_${snapshot.commands.length + 1}`;
	const existing = snapshot.commands.find((c) => c.id === id);
	const commandText = String(command.command || existing?.command || "");
	const next = {
		id,
		at: command.at ?? existing?.at ?? Date.now(),
		command: commandText,
		kind: command.kind ?? existing?.kind ?? classifyCommand(commandText),
		status: command.status ?? existing?.status ?? "unknown",
		exitCode: command.exitCode ?? existing?.exitCode ?? null,
		durationMs: command.durationMs ?? existing?.durationMs ?? null,
		outputPreview: command.outputPreview ?? existing?.outputPreview ?? "",
	};
	if (existing) Object.assign(existing, next);
	else snapshot.commands.push(next);
	snapshot.updatedAt = Date.now();
	return next;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {Partial<import("./types.mjs").EvidenceFileChange>} change */
export function upsertEvidenceFileChange(snapshot, change) {
	const p = String(change.path ?? "").trim();
	if (!p) return null;
	const existing = snapshot.fileChanges.find((f) => f.path === p);
	const now = Date.now();
	if (existing) {
		existing.lastSeenAt = now;
		existing.count = (existing.count ?? 0) + 1;
		if (change.action) existing.action = change.action;
		if (change.toolName) existing.toolName = change.toolName;
		snapshot.updatedAt = now;
		return existing;
	}
	const next = {
		path: p,
		action: change.action ?? "unknown",
		toolName: change.toolName ?? null,
		firstSeenAt: change.firstSeenAt ?? now,
		lastSeenAt: change.lastSeenAt ?? now,
		count: change.count ?? 1,
	};
	snapshot.fileChanges.push(next);
	snapshot.updatedAt = now;
	return next;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {Partial<import("./types.mjs").EvidenceError>} error */
export function recordEvidenceError(snapshot, error) {
	const next = {
		at: error.at ?? Date.now(),
		source: error.source ?? "event",
		message: String(error.message ?? "Unknown error"),
		toolName: error.toolName ?? null,
	};
	snapshot.errors.push(next);
	snapshot.updatedAt = next.at;
	return next;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {string} text @param {{ at?:number }} [opts] */
export function recordAssistantEvidence(snapshot, text, opts = {}) {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return null;
	const next = { at: opts.at ?? Date.now(), text: truncate(cleaned, 12_000) };
	snapshot.assistantEvidence.push(next);
	snapshot.summary = truncate(cleaned, 240);
	snapshot.updatedAt = next.at;
	return next;
}

/** @param {import("./types.mjs").EvidenceSnapshot} base @param {import("./types.mjs").EvidenceSnapshot} incoming */
export function mergeEvidenceSnapshot(base, incoming) {
	for (const c of incoming.commands ?? []) upsertEvidenceCommand(base, c);
	for (const f of incoming.fileChanges ?? []) upsertEvidenceFileChange(base, f);
	for (const e of incoming.errors ?? []) recordEvidenceError(base, e);
	for (const a of incoming.assistantEvidence ?? []) recordAssistantEvidence(base, a.text, { at: a.at });
	base.outcome = incoming.outcome ?? base.outcome;
	base.ready = Boolean(incoming.ready || base.ready);
	base.usage = mergeUsage(base.usage, incoming.usage);
	base.updatedAt = Date.now();
	return base;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {any} event @param {number} now */
export function reduceEvidence(snapshot, event, now = Date.now()) {
	if (!event || typeof event !== "object") return false;
	snapshot.eventCount = (snapshot.eventCount ?? 0) + 1;
	let changed = false;
	if (event.type === "tool_execution_start") {
		const name = event.toolName ?? event.args?.name ?? "tool";
		const args = event.args ?? {};
		if (name === "bash" && typeof args.command === "string") {
			upsertEvidenceCommand(snapshot, { id: event.toolCallId, at: now, command: args.command, kind: classifyCommand(args.command), status: "started" });
			changed = true;
		}
		const fileOp = toolFileOperation(name, args);
		if (fileOp) {
			upsertEvidenceFileChange(snapshot, { path: fileOp.path, action: fileOp.action, toolName: name, firstSeenAt: now, lastSeenAt: now });
			changed = true;
		}
	} else if (event.type === "tool_execution_end") {
		const name = event.toolName ?? "tool";
		if (name === "bash") {
			upsertEvidenceCommand(snapshot, {
				id: event.toolCallId,
				at: now,
				command: event.args?.command ?? "",
				status: event.isError ? "failed" : "passed",
				exitCode: event.isError ? 1 : 0,
				outputPreview: truncate(String(event.result ?? ""), 500),
			});
			changed = true;
		}
		if (event.isError) {
			recordEvidenceError(snapshot, { at: now, source: "tool", toolName: name, message: `Tool ${name} failed` });
			changed = true;
		}
	} else if (event.type === "message_end" && event.message?.role === "assistant") {
		const text = assistantText(event.message);
		if (text) {
			recordAssistantEvidence(snapshot, text, { at: now });
			changed = true;
		}
		snapshot.usage = mergeUsage(snapshot.usage, event.message?.usage ?? event.usage ?? null);
	} else if (event.usage) {
		snapshot.usage = mergeUsage(snapshot.usage, event.usage);
		changed = true;
	}
	if (changed) snapshot.updatedAt = now;
	return changed;
}

/** @param {import("./types.mjs").EvidenceSnapshot} snapshot @param {import("./types.mjs").RunStatus} status @param {number} now */
export function finalizeEvidence(snapshot, status, now = Date.now()) {
	snapshot.outcome = status.semanticState === "idle" ? "ready" : status.semanticState;
	snapshot.ready = status.semanticState === "idle" || status.semanticState === "completed";
	snapshot.usage = mergeUsage(snapshot.usage, status.usage ?? null);
	snapshot.updatedAt = now;
	return snapshot;
}

/** @param {import("./types.mjs").EvidenceUsage|null} a @param {any} b */
function mergeUsage(a, b) {
	if (!b || typeof b !== "object") return a ?? null;
	const current = a ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	const input = Number(b.inputTokens ?? b.input_tokens ?? b.prompt_tokens ?? 0) || 0;
	const output = Number(b.outputTokens ?? b.output_tokens ?? b.completion_tokens ?? 0) || 0;
	const total = Number(b.totalTokens ?? b.total_tokens ?? input + output) || input + output;
	return {
		inputTokens: (current.inputTokens ?? 0) + input,
		outputTokens: (current.outputTokens ?? 0) + output,
		totalTokens: (current.totalTokens ?? 0) + total,
	};
}
