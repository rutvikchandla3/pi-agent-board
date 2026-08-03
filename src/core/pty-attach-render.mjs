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

export const ATTACH_OUTPUT_RENDER_INTERVAL_MS = 40;

/**
 * Coalesce PTY parser callbacks into a bounded stream of repaint requests.
 *
 * node-pty commonly splits one child-TUI update across many small chunks. Rendering
 * after each @xterm/headless write callback exposes those intermediate frames and can
 * drive the outer TUI near its 60 fps limit. A trailing throttle keeps output live
 * while presenting only parsed snapshots at roughly 25 fps.
 */
export function createAttachOutputRenderScheduler(requestRender, delayMs = ATTACH_OUTPUT_RENDER_INTERVAL_MS) {
	let timer = null;
	let disposed = false;
	return {
		request() {
			if (disposed || timer) return;
			timer = setTimeout(() => {
				timer = null;
				if (!disposed) requestRender();
			}, delayMs);
			timer.unref?.();
		},
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
