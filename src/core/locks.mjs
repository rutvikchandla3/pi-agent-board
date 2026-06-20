/**
 * Tiny dependency-free synchronous file lock helpers for local agent-board artifacts.
 * Locks use atomic mkdir on a sibling .lock directory and are cleaned up in finally.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./atomic.mjs";
import * as P from "./paths.mjs";

const DEFAULT_STALE_MS = 30_000;

/**
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ staleMs?: number }} [opts]
 * @returns {T}
 */
export function withFileLockSync(lockPath, fn, opts = {}) {
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	acquireLock(lockPath, staleMs);
	try {
		return fn();
	} finally {
		releaseLock(lockPath);
	}
}

/**
 * @template T
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {() => T} fn
 * @param {{ staleMs?: number }} [opts]
 * @returns {T}
 */
export function withViewLockSync(root, viewId, name, fn, opts = {}) {
	return withFileLockSync(P.viewLockPath(root, viewId, name), fn, opts);
}

/** @param {string} lockPath @param {number} staleMs */
function acquireLock(lockPath, staleMs) {
	ensureDir(path.dirname(lockPath));
	const started = Date.now();
	while (true) {
		try {
			mkdirSync(lockPath);
			writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
			return;
		} catch (err) {
			if (!isLockStale(lockPath, staleMs) && Date.now() - started < Math.max(250, staleMs)) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
				continue;
			}
			releaseLock(lockPath);
		}
	}
}

/** @param {string} lockPath @param {number} staleMs */
function isLockStale(lockPath, staleMs) {
	try {
		if (!existsSync(lockPath)) return false;
		const raw = readFileSync(path.join(lockPath, "owner.json"), "utf8");
		const owner = JSON.parse(raw);
		return Date.now() - Number(owner.at ?? 0) > staleMs;
	} catch {
		return true;
	}
}

/** @param {string} lockPath */
function releaseLock(lockPath) {
	try {
		rmSync(lockPath, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
