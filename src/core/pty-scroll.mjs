export function clampInt(value, min, max) {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseMouseEventPrefix(data, offset = 0) {
	const input = data.slice(offset);
	const sgr = /^\x1b\[(<|\?)(\d+);(\d+);(\d+)([Mm])/.exec(input);
	if (sgr) {
		const button = Number(sgr[2]);
		const col = Number(sgr[3]);
		const row = Number(sgr[4]);
		if (!Number.isFinite(button) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
		return {
			length: sgr[0].length,
			raw: sgr[0],
			mouse: {
				encoding: sgr[1] === "?" ? "passive" : "sgr",
				button,
				col,
				row,
				action: sgr[5] === "m" ? "release" : button & 32 ? "move" : "press",
			},
		};
	}

	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (input.startsWith("\x1b[M") && input.length >= 6) {
		const button = input.charCodeAt(3) - 32;
		return {
			length: 6,
			raw: input.slice(0, 6),
			mouse: {
				encoding: "x10",
				button,
				col: input.charCodeAt(4) - 32,
				row: input.charCodeAt(5) - 32,
				action: button & 32 ? "move" : "press",
			},
		};
	}
	return null;
}

/**
 * Parse a terminal mouse report.
 * Supports standard SGR (`CSI < ...`), passive SGR (`CSI ? ...`), and X10 mouse encodings.
 */
export function parseMouseEvent(data) {
	const parsed = parseMouseEventPrefix(data);
	return parsed && parsed.length === data.length ? parsed.mouse : null;
}

/**
 * Parse an input chunk that consists entirely of one or more concatenated mouse reports.
 * Returns each decoded event with its exact raw byte sequence, or null if any non-mouse
 * bytes are present in the chunk.
 */
export function parseMouseInputChunk(data) {
	if (!data) return null;
	const events = [];
	let offset = 0;
	while (offset < data.length) {
		const parsed = parseMouseEventPrefix(data, offset);
		if (!parsed) return null;
		events.push(parsed);
		offset += parsed.length;
	}
	return events;
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
