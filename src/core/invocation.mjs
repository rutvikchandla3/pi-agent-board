/**
 * Resolve how to invoke the `pi` worker and the `node` runner across install shapes:
 *  - pi as `dist/cli.js` under system node  → piCommand=node, piArgsPrefix=[cli.js]
 *  - pi as a bun-compiled binary            → piCommand="pi" (on PATH)
 *  - generic node/bun runtime               → piCommand=execPath
 * Mirrors the logic in the official subagent example's getPiInvocation().
 */
import { existsSync } from "node:fs";
import * as path from "node:path";

/** @returns {boolean} true when process.execPath is a generic node/bun runtime (not a compiled app). */
function isGenericRuntime() {
	const name = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(name);
}

/**
 * Compute `{ piCommand, piArgsPrefix }` for spawning the pi worker.
 * @returns {{ piCommand: string, piArgsPrefix: string[] }}
 */
export function resolvePiInvocation() {
	const script = process.argv[1];
	const isBunVirtual = typeof script === "string" && script.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && existsSync(script)) {
		// Running the pi cli script under a runtime — re-run the same script.
		return { piCommand: process.execPath, piArgsPrefix: [script] };
	}
	if (!isGenericRuntime()) {
		// Compiled pi binary invoked directly.
		return { piCommand: process.execPath, piArgsPrefix: [] };
	}
	// Fallback: rely on `pi` being on PATH.
	return { piCommand: "pi", piArgsPrefix: [] };
}

/**
 * Resolve a real `node` executable to run the detached `.mjs` runner.
 * @returns {string}
 */
export function resolveNode() {
	if (isGenericRuntime()) return process.execPath;
	return "node";
}
