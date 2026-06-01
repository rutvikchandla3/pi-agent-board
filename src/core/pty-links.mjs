const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

export function trimTrailingUrlPunctuation(value) {
	let url = value;
	while (url.length > 0) {
		if (/[.,;:!?]$/.test(url)) {
			url = url.slice(0, -1);
			continue;
		}
		const last = url.at(-1);
		if (last === ")" && countChar(url, "(") < countChar(url, ")")) {
			url = url.slice(0, -1);
			continue;
		}
		if (last === "]" && countChar(url, "[") < countChar(url, "]")) {
			url = url.slice(0, -1);
			continue;
		}
		if (last === "}" && countChar(url, "{") < countChar(url, "}")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}
	return url;
}

export function findHttpUrlRangeAtCells(cells, col) {
	if (!Array.isArray(cells) || col < 0 || col >= cells.length) return null;
	const text = cells.map(normalizeAsciiCell).join("");
	HTTP_URL_RE.lastIndex = 0;
	let match;
	while ((match = HTTP_URL_RE.exec(text))) {
		const url = trimTrailingUrlPunctuation(match[0]);
		const start = match.index;
		const end = start + url.length - 1;
		if (col >= start && col <= end) return { text: url, start, end };
	}
	return null;
}

export function findHttpUrlAtCells(cells, col) {
	return findHttpUrlRangeAtCells(cells, col)?.text ?? null;
}

export function findWordRangeAtCells(cells, col) {
	if (!Array.isArray(cells) || col < 0 || col >= cells.length) return null;
	const url = findHttpUrlRangeAtCells(cells, col);
	if (url) return { ...url, kind: "url" };
	const text = cells.map(normalizeAsciiCell);
	if (!WORD_CHAR_RE.test(text[col] ?? "")) return null;
	let start = col;
	let end = col;
	while (start > 0 && WORD_CHAR_RE.test(text[start - 1] ?? "")) start -= 1;
	while (end + 1 < text.length && WORD_CHAR_RE.test(text[end + 1] ?? "")) end += 1;
	return { text: text.slice(start, end + 1).join(""), start, end, kind: "word" };
}

function normalizeAsciiCell(cell) {
	if (typeof cell !== "string" || cell.length !== 1) return " ";
	return cell >= " " && cell <= "~" ? cell : " ";
}

function countChar(text, char) {
	let count = 0;
	for (const ch of text) {
		if (ch === char) count += 1;
	}
	return count;
}
