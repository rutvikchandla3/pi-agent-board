/**
 * Git worktree isolation for same-repo parallel writer sessions (plan §11.2).
 * Each managed view gets its own worktree + branch so concurrent writers never clobber.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, error: string|null }}
 */
function git(repoRoot, args) {
	try {
		const stdout = execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: stdout.trim(), error: null };
	} catch (err) {
		const e = /** @type {any} */ (err);
		const error = (e?.stderr?.toString?.() || e?.message || "git error").trim();
		return { ok: false, stdout: "", error };
	}
}

/**
 * Create a worktree at `worktreePath` on a fresh branch `branch`, based on HEAD.
 * Idempotent-ish: if the path already exists we assume it's already a worktree.
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @param {string} branch
 * @returns {{ ok: boolean, error: string|null }}
 */
export function addWorktree(repoRoot, worktreePath, branch) {
	if (existsSync(worktreePath)) return { ok: true, error: null };
	// Try with a new branch first; fall back to attaching if the branch already exists.
	let res = git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	if (!res.ok && /already exists/i.test(res.error ?? "")) {
		res = git(repoRoot, ["worktree", "add", worktreePath, branch]);
	}
	return { ok: res.ok, error: res.error };
}

/**
 * Remove a worktree (forced) and prune. Best-effort.
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {{ ok: boolean, error: string|null }}
 */
export function removeWorktree(repoRoot, worktreePath) {
	const res = git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
	git(repoRoot, ["worktree", "prune"]);
	return { ok: res.ok, error: res.error };
}

/**
 * A short, filesystem/branch-safe identifier for a view's worktree branch.
 * @param {string} viewId
 * @returns {string}
 */
export function worktreeBranch(viewId) {
	return `agent-board/${viewId}`;
}
