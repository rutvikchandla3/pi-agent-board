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
/** @typedef {import("./types.mjs").HostConfig} HostConfig */
/** @typedef {import("./types.mjs").TitleConfig} TitleConfig */
/** @typedef {import("./types.mjs").AutoStateConfig} AutoStateConfig */

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

/**
 * Launch a detached PTY host for a view. The host owns a long-lived child Pi and
 * exposes a JSONL control socket for attach/input/resize/terminate.
 * @param {string} root
 * @param {HostConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchHost(root, config, opts) {
	const configPath = P.hostConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawn(node, [opts.runnerScript, configPath], {
		cwd: config.cwd,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	return { pid: child.pid ?? null, configPath };
}

/**
 * Launch a detached title runner for a view. Best-effort only: it may update `meta.json`
 * later with a short GPT-generated name derived from the initial task prompt.
 * @param {string} root
 * @param {TitleConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchTitle(root, config, opts) {
	const configPath = P.titleConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawn(node, [opts.runnerScript, configPath], {
		cwd: config.cwd,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	return { pid: child.pid ?? null, configPath };
}

/**
 * Launch a detached auto-state classifier for a view. Best-effort: it may update
 * state.json later with a model-refined terminal bucket.
 * @param {string} root
 * @param {AutoStateConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchAutoState(root, config, opts) {
	const configPath = P.autoStateConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawn(node, [opts.runnerScript, configPath], {
		cwd: config.cwd,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	return { pid: child.pid ?? null, configPath };
}
