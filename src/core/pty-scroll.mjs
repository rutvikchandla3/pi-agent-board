export function clampInt(value, min, max) {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Parse a terminal mouse report.
 * Supports standard SGR (`CSI < ...`), passive SGR (`CSI ? ...`), and X10 mouse encodings.
 */
export function parseMouseEvent(data) {
	const sgr = /^\x1b\[(<|\?)(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		const button = Number(sgr[2]);
		const col = Number(sgr[3]);
		const row = Number(sgr[4]);
		if (!Number.isFinite(button) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
		return {
			encoding: sgr[1] === "?" ? "passive" : "sgr",
			button,
			col,
			row,
			action: sgr[5] === "m" ? "release" : button & 32 ? "move" : "press",
		};
	}

	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		return {
			encoding: "x10",
			button: data.charCodeAt(3) - 32,
			col: data.charCodeAt(4) - 32,
			row: data.charCodeAt(5) - 32,
			action: (data.charCodeAt(3) - 32) & 32 ? "move" : "press",
		};
	}
	return null;
}

/**
 * Return +1 for wheel-up (scroll back), -1 for wheel-down, 0 for non-wheel input.
 * Supports standard/passive SGR and X10/normal mouse encodings.
 */
export function mouseWheelDirection(data) {
	const mouse = parseMouseEvent(data);
	if (!mouse || (mouse.button & 64) === 0) return 0;
	const wheelButton = mouse.button & 3;
	if (wheelButton === 0) return 1;
	if (wheelButton === 1) return -1;
	return 0; // horizontal wheel: ignore
}

/**
 * Compute the next local PTY viewport after a scroll gesture.
 *
 * `viewportTop === null` means follow bottom. `changed` reports whether the gesture
 * would visibly move the local scrollback viewport; callers can forward unconsumed
 * scroll keys/wheel events to the hosted TUI instead.
 */
export function scrollViewportTop(viewportTop, bottom, linesUp) {
	const safeBottom = Math.max(0, Math.floor(bottom));
	const current = viewportTop == null ? safeBottom : clampInt(viewportTop, 0, safeBottom);
	const next = clampInt(current - linesUp, 0, safeBottom);
	return {
		viewportTop: next >= safeBottom ? null : next,
		changed: next !== current,
	};
}

/**
 * Return a one-frame alternate PTY size that will force a hosted TUI to receive a
 * SIGWINCH/redraw before restoring the real size. This mirrors the user-visible
 * terminal zoom workaround without leaving the child at the wrong dimensions.
 */
export function resizeJiggleSize(cols, rows) {
	const c = Math.max(1, Math.floor(cols));
	const r = Math.max(1, Math.floor(rows));
	if (c > 21 && r > 6) return { cols: c - 1, rows: r - 1 };
	if (r > 6) return { cols: c, rows: r - 1 };
	if (c > 21) return { cols: c - 1, rows: r };
	return null;
}
