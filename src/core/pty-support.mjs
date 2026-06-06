/**
 * Shared node-pty support helpers:
 * - best-effort self-heal for macOS spawn-helper permissions
 * - user-facing diagnosis for common PTY startup failures
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";

/** @param {import("node:module").Require} requireForPty */
export function resolveNodePtyPackageRoot(requireForPty) {
	try {
		const pkg = requireForPty.resolve("node-pty/package.json");
		return pkg.slice(0, -"package.json".length);
	} catch {
		return null;
	}
}

/**
 * @param {import("node:module").Require} requireForPty
 * @param {string} [platform]
 * @param {string} [arch]
 */
export function nodePtySpawnHelperPaths(requireForPty, platform = process.platform, arch = process.arch) {
	const root = resolveNodePtyPackageRoot(requireForPty);
	if (!root) return [];
	return [`${root}prebuilds/${platform}-${arch}/spawn-helper`, `${root}build/Release/spawn-helper`];
}

/**
 * Best-effort chmod for node-pty's spawn-helper. This specifically heals the macOS/npm
 * packaging issue where the helper lands as 0644 instead of 0755.
 *
 * Important: this must never create a false PTY failure for an already-working install.
 * If the helper already has an execute bit, leave it alone. If chmod itself fails because
 * the install directory is read-only, swallow that and let the real node-pty probe decide.
 * @param {import("node:module").Require} requireForPty
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string[]} touched helper paths
 */
export function ensureNodePtySpawnHelperExecutable(requireForPty, platform = process.platform, arch = process.arch) {
	const touched = [];
	for (const helper of nodePtySpawnHelperPaths(requireForPty, platform, arch)) {
		if (!existsSync(helper)) continue;
		try {
			if (Boolean(statSync(helper).mode & 0o111)) continue;
		} catch {
			continue;
		}
		try {
			chmodSync(helper, 0o755);
			touched.push(helper);
		} catch {
			/* best effort: a read-only install should not disable PTY if the helper already works */
		}
	}
	return touched;
}

const RESOLVE_HELPER_COMMAND =
	`helper=$(node -p "const path=require('path'); const pkg=require.resolve('node-pty/package.json'); path.join(path.dirname(pkg),'prebuilds',process.platform+'-'+process.arch,'spawn-helper')")`;
const VERIFY_COMMAND =
	`node -e "const p=require('node-pty').spawn('/bin/echo',['ok'],{name:'xterm-256color',cols:20,rows:5,cwd:process.cwd(),env:process.env}); console.log('node-pty OK'); p.kill()"`;
const TEMP_WORKAROUND = "AGENT_BOARD_DISABLE_PTY=1 pi /agent-board";

/** @param {string} value */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** @param {string|null|undefined} helperPath @param {string} [label] */
function helperPathSteps(helperPath, label = "Detected helper path") {
	if (!helperPath) return ["Resolve the helper path:", RESOLVE_HELPER_COMMAND];
	return [`${label}:`, helperPath];
}

/** @param {string|null|undefined} helperPath */
function chmodHelperCommand(helperPath) {
	return helperPath ? `chmod +x ${shellQuote(helperPath)}` : `chmod +x "$helper"`;
}

/** @param {string|null|undefined} helperPath */
function quarantineHelperCommand(helperPath) {
	return helperPath ? `xattr -dr com.apple.quarantine ${shellQuote(helperPath)}` : `xattr -dr com.apple.quarantine "$helper"`;
}

/** @param {string|null|undefined} helperPath */
function quarantineHelperCommandBestEffort(helperPath) {
	return helperPath
		? `xattr -dr com.apple.quarantine ${shellQuote(helperPath)} 2>/dev/null || true`
		: `xattr -dr com.apple.quarantine "$helper" 2>/dev/null || true`;
}

/**
 * @typedef {Object} PtyProbe
 * @property {string|null} helperPath
 * @property {boolean|null} helperExists
 * @property {boolean|null} helperExecutable
 * @property {boolean|null} helperQuarantined
 */

/**
 * @typedef {Object} PtyIssue
 * @property {string} id
 * @property {string} title
 * @property {string} statusLabel
 * @property {string} summary
 * @property {string} fixHint
 * @property {string[]} steps
 * @property {string} rawReason
 */

/**
 * Inspect the installed node-pty helper on disk so we can separate "missing exec bit"
 * from "quarantined by Gatekeeper" from "helper missing altogether".
 * @param {import("node:module").Require} requireForPty
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {PtyProbe}
 */
export function probeNodePtyEnvironment(requireForPty, platform = process.platform, arch = process.arch) {
	const candidates = nodePtySpawnHelperPaths(requireForPty, platform, arch);
	const helperPath = candidates.find((p) => existsSync(p)) ?? candidates[0] ?? null;
	if (!helperPath) {
		return { helperPath: null, helperExists: null, helperExecutable: null, helperQuarantined: null };
	}
	const helperExists = existsSync(helperPath);
	let helperExecutable = null;
	let helperQuarantined = null;
	if (helperExists) {
		try {
			helperExecutable = Boolean(statSync(helperPath).mode & 0o111);
		} catch {
			helperExecutable = null;
		}
		if (platform === "darwin") {
			try {
				const res = spawnSync("xattr", ["-p", "com.apple.quarantine", helperPath], { encoding: "utf8" });
				helperQuarantined = res.status === 0 && Boolean(res.stdout?.trim());
			} catch {
				helperQuarantined = null;
			}
		}
	}
	return { helperPath, helperExists, helperExecutable, helperQuarantined };
}

/** @param {string|null|undefined} reason */
function cleanReason(reason) {
	return String(reason || "").replace(/\s+/g, " ").trim();
}

/**
 * Turn a raw node-pty startup failure into a user-facing explanation + fix steps.
 * @param {string|null|undefined} reason
 * @param {{ platform?: string, arch?: string, probe?: PtyProbe|null }} [opts]
 * @returns {PtyIssue}
 */
export function diagnoseNodePtyFailure(reason, opts = {}) {
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	const probe = opts.probe ?? null;
	const helperPath = probe?.helperPath ?? null;
	const rawReason = cleanReason(reason) || "unknown error";

	if (/AGENT_BOARD_DISABLE_PTY=1|AGENT_VIEW_DISABLE_PTY=1/.test(rawReason)) {
		return {
			id: "disabled-env",
			title: "PTY disabled by environment",
			statusLabel: "disabled by env",
			summary: "Live PTY is disabled because AGENT_BOARD_DISABLE_PTY=1 is set.",
			fixHint: "Unset AGENT_BOARD_DISABLE_PTY and retry Agent Board.",
			steps: ["Unset the env override.", "Retry /agent-board or attach again."],
			rawReason,
		};
	}

	if (/Cannot find module ['\"]node-pty['\"]|Cannot find package ['\"]node-pty['\"]|ERR_MODULE_NOT_FOUND/i.test(rawReason)) {
		return {
			id: "missing-module",
			title: "node-pty dependency missing",
			statusLabel: "node-pty missing",
			summary: "Live PTY is disabled because the node-pty dependency is missing.",
			fixHint: "Reinstall the package so production dependencies are present.",
			steps: [
				"For a local checkout, run: npm install",
				"For an installed package, reinstall agent-board so node-pty is present.",
				`Temporary workaround: ${TEMP_WORKAROUND}`,
			],
			rawReason,
		};
	}

	if (/(Could not locate the bindings file|No native build was found|Cannot find module ['\"].*pty\.node['\"]|No prebuilds found)/i.test(rawReason)) {
		return {
			id: "native-missing",
			title: "node-pty native binary missing",
			statusLabel: "native binary missing",
			summary: "Live PTY is disabled because node-pty is installed but its native binary is missing for this runtime.",
			fixHint: `Reinstall or rebuild node-pty under the same Node version and architecture (${platform}-${arch}) that Pi is using.`,
			steps: [
				`Confirm runtime: node -p \"process.version + ' ' + process.platform + ' ' + process.arch\"`,
				"Reinstall dependencies or rebuild native modules under that same runtime.",
				"For source installs, run npm rebuild node-pty (or npm install) in the package directory.",
				`Temporary workaround: ${TEMP_WORKAROUND}`,
			],
			rawReason,
		};
	}

	if (
		platform === "darwin" &&
		/(posix_spawnp failed|spawn-helper|permission denied|operation not permitted|eacces|eperm)/i.test(rawReason)
	) {
		if (probe?.helperExists === false) {
			return {
				id: "macos-spawn-helper-missing",
				title: "node-pty helper missing",
				statusLabel: "spawn-helper missing",
				summary: "Live PTY is disabled because node-pty's macOS spawn-helper file is missing.",
				fixHint: "Reinstall the package so the darwin helper is restored.",
				steps: [
					...helperPathSteps(helperPath, "Expected helper path"),
					"Reinstall agent-board or run npm install again so node-pty's darwin prebuilds are present.",
					`Temporary workaround: ${TEMP_WORKAROUND}`,
				],
				rawReason,
			};
		}
		if (probe?.helperExecutable === false) {
			return {
				id: "macos-spawn-helper-mode",
				title: "spawn-helper is not executable",
				statusLabel: "spawn-helper not executable",
				summary: "Live PTY is disabled because node-pty's spawn-helper does not have execute permission.",
				fixHint: "Run chmod +x on spawn-helper.",
				steps: [
					...helperPathSteps(helperPath),
					"Grant execute permission:",
					chmodHelperCommand(helperPath),
					"Validate node-pty after the fix:",
					VERIFY_COMMAND,
					`Temporary workaround: ${TEMP_WORKAROUND}`,
				],
				rawReason,
			};
		}
		if (probe?.helperQuarantined) {
			return {
				id: "macos-spawn-helper-quarantine",
				title: "spawn-helper is quarantined",
				statusLabel: "spawn-helper quarantined",
				summary: "Live PTY is disabled because macOS Gatekeeper quarantined node-pty's spawn-helper.",
				fixHint: "Clear the quarantine xattr from spawn-helper.",
				steps: [
					...helperPathSteps(helperPath),
					"Remove the quarantine attribute:",
					quarantineHelperCommand(helperPath),
					"Validate node-pty after the fix:",
					VERIFY_COMMAND,
					`Temporary workaround: ${TEMP_WORKAROUND}`,
				],
				rawReason,
			};
		}
		return {
			id: "macos-spawn-helper",
			title: "macOS blocked spawn-helper",
			statusLabel: "spawn-helper blocked",
			summary: "Live PTY is disabled because macOS could not execute node-pty's spawn-helper.",
			fixHint: "Run chmod +x on spawn-helper and clear quarantine if needed.",
			steps: [
				...helperPathSteps(helperPath),
				"Fix permissions and quarantine:",
				chmodHelperCommand(helperPath),
				quarantineHelperCommandBestEffort(helperPath),
				"Validate node-pty after the fix:",
				VERIFY_COMMAND,
				`Temporary workaround: ${TEMP_WORKAROUND}`,
			],
			rawReason,
		};
	}

	if (
		/(NODE_MODULE_VERSION|module version mismatch|module did not self-register|dlopen\(|mach-o|wrong architecture|incompatible architecture|no suitable image|invalid elf|symbol not found)/i.test(
			rawReason,
		)
	) {
		return {
			id: "native-mismatch",
			title: "node-pty native binary mismatch",
			statusLabel: "native binary mismatch",
			summary: "Live PTY is disabled because node-pty's native binary does not match this Node or CPU architecture.",
			fixHint: `Reinstall node-pty under the same Node version and architecture (${platform}-${arch}) that Pi is using.`,
			steps: [
				`Confirm runtime: node -p \"process.version + ' ' + process.platform + ' ' + process.arch\"`,
				"Reinstall dependencies under that same runtime.",
				"Avoid mixing Rosetta x64 and native arm64 installs on macOS.",
				`Temporary workaround: ${TEMP_WORKAROUND}`,
			],
			rawReason,
		};
	}

	return {
		id: "generic",
		title: "node-pty startup probe failed",
		statusLabel: "startup probe failed",
		summary: "Live PTY is disabled because node-pty failed its startup probe.",
		fixHint: "Inspect the raw error, reinstall node-pty, or temporarily disable PTY.",
		steps: [
			"Inspect the raw reason below for the underlying system error.",
			"Reinstall the package dependencies if the problem persists.",
			`Temporary workaround: ${TEMP_WORKAROUND}`,
		],
		rawReason,
	};
}

/** @param {{ ok: boolean, reason?: string|null, issue?: PtyIssue|null }} support */
export function nodePtyFallbackMessage(support) {
	if (support.ok) return undefined;
	const issue = support.issue ?? diagnoseNodePtyFailure(support.reason ?? null);
	return `${issue.summary} Fix: ${issue.fixHint} Press ! for exact steps.`;
}
