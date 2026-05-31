export function clampInt(value, min, max) {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Return +1 for wheel-up (scroll back), -1 for wheel-down, 0 for non-wheel input.
 * Supports SGR (1006) and X10/normal mouse encodings.
 */
export function mouseWheelDirection(data) {
	// SGR mouse: ESC [ < button ; x ; y M/m. Wheel up/down are buttons 64/65
	// plus optional modifier bits.
	const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data);
	if (sgr) {
		const button = Number(sgr[1]);
		if (!Number.isFinite(button) || (button & 64) === 0) return 0;
		const wheelButton = button & 3;
		if (wheelButton === 0) return 1;
		if (wheelButton === 1) return -1;
		return 0; // horizontal wheel: ignore
	}

	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return 0;
		const wheelButton = button & 3;
		if (wheelButton === 0) return 1;
		if (wheelButton === 1) return -1;
	}
	return 0;
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
