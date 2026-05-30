/**
 * Pure text heuristics: extracting assistant text, detecting questions/blockers,
 * summarizing tool calls, and formatting relative times. No I/O, fully unit-tested.
 */

/**
 * Join the text content blocks of an assistant message into a single string.
 * Accepts the message object as emitted in JSON mode (`message.content` is an array
 * of `{type,...}` blocks, or, defensively, a plain string).
 * @param {any} message
 * @returns {string}
 */
export function assistantText(message) {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/**
 * Collect tool-call blocks from an assistant message.
 * @param {any} message
 * @returns {Array<{name:string, arguments:Record<string,any>}>}
 */
export function toolCalls(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b && b.type === "toolCall")
		.map((b) => ({ name: b.name, arguments: b.arguments ?? {} }));
}

const QUESTION_PHRASES = [
	"need your input",
	"need some input",
	"which option",
	"should i",
	"shall i",
	"please confirm",
	"could you confirm",
	"can you confirm",
	"let me know",
	"do you want",
	"would you like",
	"how would you like",
	"what would you like",
	"which one",
	"please clarify",
	"can you clarify",
	"waiting for your",
];

/**
 * Decide whether the latest assistant text is asking the user a question / is blocked,
 * and extract the question sentence if so.
 * @param {string} text
 * @returns {{ needsInput: boolean, question: string|null }}
 */
export function detectNeedsInput(text) {
	const trimmed = (text || "").trim();
	if (!trimmed) return { needsInput: false, question: null };

	const lower = trimmed.toLowerCase();
	const sentences = splitSentences(trimmed);
	const last = sentences[sentences.length - 1] ?? trimmed;

	// Strongest signal: the message ends on a question mark.
	if (/\?\s*$/.test(trimmed)) {
		const q = [...sentences].reverse().find((s) => s.includes("?")) ?? last;
		return { needsInput: true, question: q.trim() };
	}

	for (const phrase of QUESTION_PHRASES) {
		if (lower.includes(phrase)) {
			const hit = sentences.find((s) => s.toLowerCase().includes(phrase)) ?? last;
			return { needsInput: true, question: hit.trim() };
		}
	}

	return { needsInput: false, question: null };
}

/**
 * Split text into sentences (rough; good enough for previews/blocker extraction).
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
	return (text || "")
		.replace(/\s+/g, " ")
		.trim()
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * First sentence (or first line) of an assistant message, for compact previews.
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
	const sentences = splitSentences(text);
	return sentences[0] ?? "";
}

const PATH_KEYS = ["file_path", "path", "filePath", "file"];

/**
 * Best-effort target path from a tool call's arguments.
 * @param {Record<string,any>} args
 * @returns {string|null}
 */
export function toolPath(args) {
	if (!args || typeof args !== "object") return null;
	for (const k of PATH_KEYS) {
		if (typeof args[k] === "string" && args[k]) return args[k];
	}
	if (typeof args.pattern === "string" && args.pattern) return args.pattern;
	return null;
}

/**
 * Human one-liner for an in-progress tool call, e.g. "Editing src/auth.ts".
 * @param {string} name
 * @param {Record<string,any>} args
 * @returns {string}
 */
export function toolSummary(name, args) {
	const p = toolPath(args);
	const base = p ? baseName(p) : null;
	switch (name) {
		case "edit":
			return base ? `Editing ${base}` : "Editing files";
		case "write":
			return base ? `Writing ${base}` : "Writing files";
		case "read":
			return base ? `Reading ${base}` : "Reading files";
		case "ls":
			return base ? `Listing ${base}` : "Listing files";
		case "find":
			return p ? `Finding ${p}` : "Finding files";
		case "grep":
			return p ? `Searching /${p}/` : "Searching";
		case "bash": {
			const cmd = typeof args?.command === "string" ? args.command.trim() : "";
			if (!cmd) return "Running command";
			if (/\b(test|vitest|jest|pytest|go test|cargo test)\b/.test(cmd)) return "Running tests";
			if (/\b(build|tsc|webpack|vite build|make)\b/.test(cmd)) return "Building";
			if (/^git\b/.test(cmd)) return `git ${cmd.replace(/^git\s+/, "").split(/\s+/)[0] ?? ""}`.trim();
			return `Running ${truncate(cmd, 32)}`;
		}
		default:
			return base ? `${capitalize(name)} ${base}` : capitalize(name);
	}
}

/** @param {string} p */
export function baseName(p) {
	const parts = String(p).split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/** @param {string} s */
function capitalize(s) {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Truncate to `n` chars with an ellipsis (counts characters, not display width).
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function truncate(s, n) {
	const str = String(s ?? "");
	if (str.length <= n) return str;
	return `${str.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * Compact relative age, e.g. "10s", "2m", "3h", "4d".
 * @param {number} fromMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function relativeTime(fromMs, nowMs = Date.now()) {
	const diff = Math.max(0, nowMs - fromMs);
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}
