/** Process liveness checks. */

/**
 * Whether `pid` refers to a live process.
 * `process.kill(pid, 0)` throws ESRCH when the process is gone, and EPERM when it
 * exists but we lack permission to signal it — EPERM still means "alive".
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
	}
}

/**
 * Try to terminate a process tree gently, then force after `graceMs`.
 * Safe no-op if already dead.
 * @param {number|null|undefined} pid
 * @param {number} [graceMs]
 */
export function killProcess(pid, graceMs = 4000) {
	if (!isAlive(pid)) return;
	try {
		process.kill(/** @type {number} */ (pid), "SIGTERM");
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		if (isAlive(pid)) {
			try {
				process.kill(/** @type {number} */ (pid), "SIGKILL");
			} catch {
				/* ignore */
			}
		}
	}, graceMs).unref?.();
}
