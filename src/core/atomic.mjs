/**
 * Atomic + crash-tolerant file helpers used across the extension and the runner.
 *
 * Writes go to a temp sibling then `rename()` (atomic on the same filesystem) so a
 * reader never observes a half-written JSON file. Reads tolerate missing/corrupt files.
 */
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

/** @param {string} dir */
export function ensureDir(dir) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write a string to `file` (creates parent dirs).
 * @param {string} file
 * @param {string} data
 */
export function atomicWrite(file, data) {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, data, "utf8");
	renameSync(tmp, file);
}

/**
 * Atomically write a value as pretty JSON.
 * @param {string} file
 * @param {unknown} value
 */
export function atomicWriteJson(file, value) {
	atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read and parse JSON, returning `fallback` when the file is missing or unparseable.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
	try {
		if (!existsSync(file)) return fallback;
		const raw = readFileSync(file, "utf8");
		if (!raw.trim()) return fallback;
		return /** @type {T} */ (JSON.parse(raw));
	} catch {
		return fallback;
	}
}

/**
 * Append one line (a trailing newline is added) to a log/jsonl file.
 * @param {string} file
 * @param {string} line
 */
export function appendLine(file, line) {
	ensureDir(path.dirname(file));
	appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

/**
 * Read a JSONL file into parsed objects, skipping blank/corrupt lines.
 * @param {string} file
 * @returns {any[]}
 */
export function readJsonl(file) {
	try {
		if (!existsSync(file)) return [];
		const out = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t));
			} catch {
				/* skip corrupt line */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Read a file's text, returning `fallback` if missing.
 * @param {string} file
 * @param {string} [fallback]
 * @returns {string}
 */
export function readText(file, fallback = "") {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : fallback;
	} catch {
		return fallback;
	}
}
