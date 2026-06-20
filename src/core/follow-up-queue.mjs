/** Durable FIFO follow-up queue helpers. */
import { atomicWriteJson, readJson } from "./atomic.mjs";
import { newFollowUpId } from "./ids.mjs";
import { truncate } from "./heuristics.mjs";
import { withViewLockSync } from "./locks.mjs";
import * as P from "./paths.mjs";

/** @param {string} viewId @param {number} [now] @returns {import("./types.mjs").FollowUpQueue} */
export function emptyFollowUpQueue(viewId, now = Date.now()) {
	return { version: 1, viewId, nextSeq: 1, updatedAt: now, items: [] };
}

/** @param {string} root @param {string} viewId */
export function readFollowUpQueue(root, viewId) {
	return normalizeQueue(readJson(P.followUpQueuePath(root, viewId), null), viewId);
}

/** @param {string} root @param {import("./types.mjs").FollowUpQueue} queue */
export function writeFollowUpQueue(root, queue) {
	const normalized = normalizeQueue(queue, queue.viewId);
	normalized.updatedAt = Date.now();
	atomicWriteJson(P.followUpQueuePath(root, normalized.viewId), normalized);
	return normalized;
}

/** @param {import("./types.mjs").FollowUpQueue} queue @returns {import("./types.mjs").FollowUpSummary} */
export function summarizeFollowUpQueue(queue) {
	const q = normalizeQueue(queue, queue?.viewId ?? "");
	const queued = q.items.filter((i) => i.status === "queued");
	const claimed = q.items.filter((i) => i.status === "claimed");
	const last = [...queued].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
	return {
		queuedCount: queued.length,
		claimedCount: claimed.length,
		lastQueuedAt: last?.createdAt ?? null,
		lastQueuedPreview: last ? truncate(last.text, 120) : null,
	};
}

/** @param {string} root @param {string} viewId @param {string} text @param {{ kind?: import("./types.mjs").FollowUpKind, source?: string, delivery?: "auto"|"now"|"queue" }} [opts] */
export function enqueueFollowUp(root, viewId, text, opts = {}) {
	const clean = String(text || "").trim();
	if (!clean) return { ok: false, error: "Empty follow-up" };
	return withViewLockSync(root, viewId, "queue", () => {
		const queue = readFollowUpQueue(root, viewId);
		const now = Date.now();
		const item = {
			id: newFollowUpId(),
			seq: queue.nextSeq,
			viewId,
			kind: opts.kind ?? "reply",
			text: clean,
			createdAt: now,
			updatedAt: now,
			status: "queued",
			source: opts.source ?? "user",
			delivery: opts.delivery ?? "auto",
			runId: null,
			claimedAt: null,
			completedAt: null,
			attempts: 0,
			error: null,
		};
		queue.nextSeq += 1;
		queue.items.push(item);
		writeFollowUpQueue(root, queue);
		return { ok: true, item, summary: summarizeFollowUpQueue(queue) };
	});
}

/** @param {string} root @param {string} viewId @param {{ runId?: string|null }} [opts] */
export function claimNextFollowUp(root, viewId, opts = {}) {
	return withViewLockSync(root, viewId, "queue", () => {
		const queue = readFollowUpQueue(root, viewId);
		const item = queue.items.filter((i) => i.status === "queued").sort((a, b) => a.seq - b.seq)[0];
		if (!item) return { ok: false, error: "No queued follow-up" };
		item.status = "claimed";
		item.claimedAt = Date.now();
		item.updatedAt = item.claimedAt;
		item.attempts = (item.attempts ?? 0) + 1;
		item.runId = opts.runId ?? item.runId ?? null;
		writeFollowUpQueue(root, queue);
		return { ok: true, item, summary: summarizeFollowUpQueue(queue) };
	});
}

/** @param {string} root @param {string} viewId @param {string} itemId @param {{ runId?: string|null }} [opts] */
export function completeFollowUp(root, viewId, itemId, opts = {}) {
	return updateItem(root, viewId, itemId, (item) => {
		item.status = "completed";
		item.completedAt = Date.now();
		item.updatedAt = item.completedAt;
		if (opts.runId) item.runId = opts.runId;
	});
}

/** @param {string} root @param {string} viewId @param {string} itemId @param {string} error */
export function failFollowUp(root, viewId, itemId, error) {
	return updateItem(root, viewId, itemId, (item) => {
		item.status = "failed";
		item.error = String(error || "Follow-up failed");
		item.updatedAt = Date.now();
	});
}

/** @param {string} root @param {string} viewId @param {string} itemId */
export function releaseFollowUp(root, viewId, itemId) {
	return updateItem(root, viewId, itemId, (item) => {
		item.status = "queued";
		item.claimedAt = null;
		item.updatedAt = Date.now();
	});
}

/** @param {string} root @param {string} viewId */
export function removeLastFollowUp(root, viewId) {
	return withViewLockSync(root, viewId, "queue", () => {
		const queue = readFollowUpQueue(root, viewId);
		const queued = queue.items.filter((i) => i.status === "queued").sort((a, b) => b.seq - a.seq);
		const last = queued[0];
		if (!last) return { ok: false, error: "No queued follow-up" };
		last.status = "cancelled";
		last.updatedAt = Date.now();
		writeFollowUpQueue(root, queue);
		return { ok: true, item: last, summary: summarizeFollowUpQueue(queue) };
	});
}

/** @param {string} root @param {string} viewId */
export function clearQueuedFollowUps(root, viewId) {
	return withViewLockSync(root, viewId, "queue", () => {
		const queue = readFollowUpQueue(root, viewId);
		let cancelled = 0;
		for (const item of queue.items) {
			if (item.status === "queued") {
				item.status = "cancelled";
				item.updatedAt = Date.now();
				cancelled += 1;
			}
		}
		writeFollowUpQueue(root, queue);
		return { ok: true, cancelled, summary: summarizeFollowUpQueue(queue) };
	});
}

/** @param {string} root @param {string} viewId @param {string} itemId @param {(item: import("./types.mjs").FollowUpItem) => void} mutate */
function updateItem(root, viewId, itemId, mutate) {
	return withViewLockSync(root, viewId, "queue", () => {
		const queue = readFollowUpQueue(root, viewId);
		const item = queue.items.find((i) => i.id === itemId);
		if (!item) return { ok: false, error: "Unknown follow-up" };
		mutate(item);
		writeFollowUpQueue(root, queue);
		return { ok: true, item, summary: summarizeFollowUpQueue(queue) };
	});
}

/** @param {any} queue @param {string} viewId @returns {import("./types.mjs").FollowUpQueue} */
function normalizeQueue(queue, viewId) {
	const base = emptyFollowUpQueue(viewId || queue?.viewId || "");
	if (!queue || typeof queue !== "object") return base;
	const items = Array.isArray(queue.items) ? queue.items.map((item, idx) => normalizeItem(item, viewId, idx + 1)) : [];
	return {
		version: 1,
		viewId: typeof queue.viewId === "string" ? queue.viewId : base.viewId,
		nextSeq: Math.max(Number(queue.nextSeq ?? 1) || 1, items.reduce((m, i) => Math.max(m, i.seq + 1), 1)),
		updatedAt: Number(queue.updatedAt ?? Date.now()) || Date.now(),
		items,
	};
}

/** @param {any} item @param {string} viewId @param {number} seq */
function normalizeItem(item, viewId, seq) {
	const now = Date.now();
	const status = ["queued", "claimed", "completed", "failed", "cancelled"].includes(item?.status) ? item.status : "queued";
	return {
		id: typeof item?.id === "string" ? item.id : newFollowUpId(),
		seq: Number(item?.seq ?? seq) || seq,
		viewId: typeof item?.viewId === "string" ? item.viewId : viewId,
		kind: ["reply", "plan_request", "plan_approval", "plan_change"].includes(item?.kind) ? item.kind : "reply",
		text: String(item?.text ?? ""),
		createdAt: Number(item?.createdAt ?? now) || now,
		updatedAt: Number(item?.updatedAt ?? now) || now,
		status,
		source: typeof item?.source === "string" ? item.source : "user",
		delivery: ["auto", "now", "queue"].includes(item?.delivery) ? item.delivery : "auto",
		runId: typeof item?.runId === "string" ? item.runId : null,
		claimedAt: Number.isFinite(item?.claimedAt) ? item.claimedAt : null,
		completedAt: Number.isFinite(item?.completedAt) ? item.completedAt : null,
		attempts: Number(item?.attempts ?? 0) || 0,
		error: typeof item?.error === "string" ? item.error : null,
	};
}
