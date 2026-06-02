/**
 * Decide whether the next attach repaint should force a full clear.
 *
 * The first attach paint always forces once so the previous dashboard/session surface
 * cannot ghost behind the overlay. Later paints stay differential unless a caller
 * explicitly requests a hard reset.
 */
export function nextAttachRender(firstPaint, force = false) {
	return {
		force: Boolean(force || firstPaint),
		firstPaint: false,
	};
}

/**
 * Attach output should repaint only after @xterm/headless finishes parsing the chunk.
 * Status/control messages can repaint immediately because they mutate header/overlay state.
 */
export function shouldScheduleAttachRenderForMessage(type) {
	return type === "hello" || type === "status" || type === "exit" || type === "error";
}
