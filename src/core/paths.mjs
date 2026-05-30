/**
 * Filesystem layout for the agent-view store.
 *
 * Every helper takes an explicit `root` so tests can point at a tmp dir.
 * The live default is `~/.pi/agent/agent-view/` (override with $AGENT_VIEW_ROOT).
 */
import * as os from "node:os";
import * as path from "node:path";

/** @returns {string} the live store root (env override or ~/.pi/agent/agent-view). */
export function defaultRoot() {
	if (process.env.AGENT_VIEW_ROOT) return path.resolve(process.env.AGENT_VIEW_ROOT);
	return path.join(os.homedir(), ".pi", "agent", "agent-view");
}

/** @param {string} root */
export const rosterPath = (root) => path.join(root, "roster.json");

/** @param {string} root */
export const viewsDir = (root) => path.join(root, "views");
/** @param {string} root @param {string} viewId */
export const viewDir = (root, viewId) => path.join(root, "views", viewId);
/** @param {string} root @param {string} viewId */
export const metaPath = (root, viewId) => path.join(viewDir(root, viewId), "meta.json");
/** @param {string} root @param {string} viewId */
export const statePath = (root, viewId) => path.join(viewDir(root, viewId), "state.json");
/** @param {string} root @param {string} viewId */
export const runsDir = (root, viewId) => path.join(viewDir(root, viewId), "runs");
/** @param {string} root @param {string} viewId @param {string} runId */
export const runDir = (root, viewId, runId) => path.join(runsDir(root, viewId), runId);
/** @param {string} root @param {string} viewId @param {string} runId */
export const statusPath = (root, viewId, runId) => path.join(runDir(root, viewId, runId), "status.json");
/** @param {string} root @param {string} viewId @param {string} runId */
export const eventsPath = (root, viewId, runId) => path.join(runDir(root, viewId, runId), "events.jsonl");
/** @param {string} root @param {string} viewId @param {string} runId */
export const stdoutPath = (root, viewId, runId) => path.join(runDir(root, viewId, runId), "stdout.log");
/** @param {string} root @param {string} viewId @param {string} runId */
export const stderrPath = (root, viewId, runId) => path.join(runDir(root, viewId, runId), "stderr.log");
/** @param {string} root @param {string} viewId @param {string} runId */
export const pidPath = (root, viewId, runId) => path.join(runDir(root, viewId, runId), "pid.json");

/** @param {string} root */
export const sessionsDir = (root) => path.join(root, "sessions");
/** @param {string} root @param {string} viewId */
export const sessionFilePath = (root, viewId) => path.join(sessionsDir(root), `${viewId}.jsonl`);

/** @param {string} root */
export const worktreesDir = (root) => path.join(root, "worktrees");
/** @param {string} root @param {string} viewId */
export const worktreePath = (root, viewId) => path.join(worktreesDir(root), viewId);
