/**
 * Signature of the row data that the dashboard renders, used by the poll loop to
 * skip repaints when nothing changed. Without it the dashboard requested a repaint
 * every POLL_MS even when the rows were identical, keeping the whole TUI render
 * pipeline busy (and visibly flickering on terminals without synchronized-output
 * support before the differential render fix).
 *
 * Relative "Xs" age labels are bucketed to one minute so a passing second does
 * not itself trigger a repaint; the bucketed value is derived from the row's
 * last activity timestamp.
 *
 * @param {import("./store.mjs").Row[]} rows
 * @returns {string}
 */
export function rowDataSignature(rows) {
	const bucketMs = 60_000;
	return JSON.stringify(rows.map((r) => {
		const s = r.state ?? {};
		const lastActivityAt = s.lastActivityAt ?? r.meta.updatedAt ?? r.meta.createdAt ?? 0;
		return [
			r.meta.id,
			r.meta.name,
			r.meta.pinned,
			r.meta.repoCwd ?? r.meta.cwd,
			r.meta.worktreeMode,
			s.semanticState,
			s.processState,
			s.needsInput,
			s.question,
			s.summary,
			s.error,
			s.lastVisitedAt,
			s.lastAgentActivityAt !== null && s.lastAgentActivityAt !== undefined
				? Math.floor(s.lastAgentActivityAt / bucketMs)
				: null,
			s.review?.ready,
			s.review?.errorCount,
			s.diagnostics?.stalled,
			s.diagnostics?.errorCount,
			s.followUps?.queuedCount,
			s.followUps?.lastQueuedPreview,
			s.steering?.status,
			r.alive,
			r.hostAlive,
			r.host?.state,
			Math.floor(lastActivityAt / bucketMs),
		];
	}));
}
