import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";

export const SCREEN_LOG_REPLAY_BYTES = 100_000;
export const SCREEN_LOG_MAX_BYTES = 5_000_000;

export const defaultScreenLogFs = Object.freeze({
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
});

let tempSequence = 0;

/** @param {string} file @param {number} maxBytes @param {typeof defaultScreenLogFs} fs */
export function readScreenLogTailBytes(file, maxBytes = SCREEN_LOG_REPLAY_BYTES, fs = defaultScreenLogFs) {
	return readTailResult(file, maxBytes, fs).data;
}

/** @param {string} file @param {number} maxBytes */
export function readScreenLogTail(file, maxBytes = SCREEN_LOG_REPLAY_BYTES) {
	return readScreenLogTailBytes(file, maxBytes).toString("utf8");
}

/**
 * Compact an existing screen log when it exceeds maxBytes.
 * @param {string} file
 * @param {{ maxBytes?: number, retainBytes?: number, fs?: typeof defaultScreenLogFs }} [opts]
 */
export function reconcileScreenLog(file, opts = {}) {
	const fs = opts.fs ?? defaultScreenLogFs;
	const { maxBytes, retainBytes } = limits(opts);
	const size = fileSize(file, 0, fs);
	if (size <= maxBytes) return size;
	const tail = readTailResult(file, retainBytes, fs);
	if (!tail.ok || !replaceScreenLog(file, tail.data, fs)) return fileSize(file, size, fs);
	return fileSize(file, tail.data.length, fs);
}

/**
 * Append PTY output while bounding the persisted replay log.
 * @param {string} file
 * @param {string|Buffer} data
 * @param {number} currentBytes
 * @param {{ maxBytes?: number, retainBytes?: number, fs?: typeof defaultScreenLogFs }} [opts]
 */
export function appendBoundedScreenLog(file, data, currentBytes, opts = {}) {
	const fs = opts.fs ?? defaultScreenLogFs;
	const { maxBytes, retainBytes } = limits(opts);
	const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
	let size = Number.isFinite(currentBytes) && currentBytes >= 0 ? currentBytes : fileSize(file, 0, fs);

	if (size > maxBytes) {
		size = reconcileScreenLog(file, { maxBytes, retainBytes, fs });
		if (size > maxBytes) return size;
	}
	if (payload.length === 0) return size;
	if (payload.length >= maxBytes) {
		const tail = payload.subarray(Math.max(0, payload.length - retainBytes));
		if (!replaceScreenLog(file, tail, fs)) return fileSize(file, size, fs);
		return fileSize(file, tail.length, fs);
	}

	try {
		fs.appendFileSync(file, payload);
	} catch {
		return fileSize(file, size, fs);
	}
	size += payload.length;
	if (size <= maxBytes) return size;
	return reconcileScreenLog(file, { maxBytes, retainBytes, fs });
}

/** @param {string} file @param {number} maxBytes @param {typeof defaultScreenLogFs} fs */
function readTailResult(file, maxBytes, fs) {
	if (!file || maxBytes <= 0 || !fs.existsSync(file)) return { ok: true, data: Buffer.alloc(0) };
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, Math.floor(maxBytes));
		if (length <= 0) return { ok: true, data: Buffer.alloc(0) };
		const output = Buffer.allocUnsafe(length);
		const start = size - length;
		let offset = 0;
		while (offset < length) {
			const read = fs.readSync(fd, output, offset, length - offset, start + offset);
			if (read === 0) break;
			offset += read;
		}
		return { ok: true, data: offset === length ? output : output.subarray(0, offset) };
	} catch {
		return { ok: false, data: Buffer.alloc(0) };
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch {}
		}
	}
}

/** @param {{ maxBytes?: number, retainBytes?: number }} opts */
function limits(opts) {
	const maxBytes = positiveInt(opts.maxBytes, SCREEN_LOG_MAX_BYTES);
	return { maxBytes, retainBytes: Math.min(positiveInt(opts.retainBytes, SCREEN_LOG_REPLAY_BYTES), maxBytes) };
}

/** @param {string} file @param {Buffer} data @param {typeof defaultScreenLogFs} fs */
function replaceScreenLog(file, data, fs) {
	const temp = `${file}.${process.pid}.${tempSequence++}.tmp`;
	let fd;
	try {
		fd = fs.openSync(temp, "w");
		let offset = 0;
		while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset, offset);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, file);
		return true;
	} catch {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch {}
		}
		try { fs.unlinkSync(temp); } catch {}
		return false;
	}
}

/** @param {string} file @param {number} fallback @param {typeof defaultScreenLogFs} fs */
function fileSize(file, fallback, fs) {
	try {
		return fs.statSync(file).size;
	} catch {
		return fallback;
	}
}

function positiveInt(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
