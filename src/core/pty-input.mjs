/** Helpers for deciding whether local attach shortcuts should be handled. */

/**
 * Best-effort detection of Pi's empty prompt/input line from projected terminal text.
 * The attach surface must not steal editing keys (notably ←) while the child Pi editor
 * contains text. Pi renders empty editor lines with prompt/continuation glyphs such as
 * `›`, `┃`, or `│`; once user text is present, non-prompt content remains after this trim.
 * @param {string} line
 * @returns {boolean}
 */
export function isProbablyEmptyPiInputLine(line) {
	const withoutRightPadding = String(line || "").replace(/[\s\u00a0]+$/u, "");
	const content = withoutRightPadding.replace(/^[\s\u00a0›>┃│|┆╎╏:]+/u, "");
	return content.length === 0;
}
