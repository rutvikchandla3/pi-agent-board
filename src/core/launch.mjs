/**
 * Launch a detached job-runner process for one run.
 *
 * The runner is a plain `.mjs` spawned with `node`, fully detached (its own process
 * group, stdio ignored) so it survives the parent Pi reloading or exiting. The parent
 * records the runner pid in `pid.json` and watches the store files the runner writes.
 */
import { spawn } from "node:child_process";
import { atomicWriteJson } from "./atomic.mjs";
import { resolveNode } from "./invocation.mjs";
import * as P from "./paths.mjs";
import { writePid } from "./store.mjs";

/** @typedef {import("./types.mjs").RunConfig} RunConfig */

/**
 * @param {string} root
 * @param {RunConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchRun(root, config, opts) {
	const runDir = P.runDir(root, config.viewId, config.runId);
	const configPath = `${runDir}/config.json`;
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawn(node, [opts.runnerScript, configPath], {
		cwd: config.cwd,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	const pid = child.pid ?? null;
	// Record the *runner/monitor* pid for liveness polling (the worker pid is tracked
	// inside status.json by the runner itself).
	writePid(root, config.viewId, config.runId, pid);
	return { pid, configPath };
}
