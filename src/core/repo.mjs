/** Git repository identity. Pure node (shells out to `git`); returns null off-repo. */
import { execFileSync } from "node:child_process";

/**
 * Resolve the git repo root containing `cwd`, or null if not in a repo.
 * @param {string} cwd
 * @returns {string|null}
 */
export function gitRepoRoot(cwd) {
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const root = out.trim();
		return root || null;
	} catch {
		return null;
	}
}

/**
 * Whether two directories resolve to the same git repo root.
 * @param {string|null} rootA
 * @param {string|null} rootB
 * @returns {boolean}
 */
export function sameRepo(rootA, rootB) {
	return Boolean(rootA && rootB && rootA === rootB);
}

/**
 * Whether the repo has uncommitted changes (dirty). Best-effort; false on error/off-repo.
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isDirty(repoRoot) {
	try {
		const out = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim().length > 0;
	} catch {
		return false;
	}
}
