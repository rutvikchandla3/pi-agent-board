import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diagnoseNodePtyFailure, ensureNodePtySpawnHelperExecutable, nodePtyFallbackMessage } from "../src/core/pty-support.mjs";

function fakeRequireForPackageRoot(root) {
	return {
		resolve(specifier) {
			assert.equal(specifier, "node-pty/package.json");
			return join(root, "package.json");
		},
	};
}

test("ensureNodePtySpawnHelperExecutable only chmods helpers that are actually missing execute bits", () => {
	const root = mkdtempSync(join(tmpdir(), "pty-support-"));
	try {
		const helperDir = join(root, "prebuilds", "darwin-arm64");
		const helper = join(helperDir, "spawn-helper");
		mkdirSync(helperDir, { recursive: true });
		writeFileSync(helper, "#!/bin/sh\necho ok\n");
		chmodSync(helper, 0o644);

		assert.deepEqual(ensureNodePtySpawnHelperExecutable(fakeRequireForPackageRoot(root), "darwin", "arm64"), [helper]);
		assert.equal(Boolean(statSync(helper).mode & 0o111), true);
		assert.deepEqual(ensureNodePtySpawnHelperExecutable(fakeRequireForPackageRoot(root), "darwin", "arm64"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("diagnoseNodePtyFailure classifies macOS spawn-helper failures", () => {
	const issue = diagnoseNodePtyFailure("posix_spawnp failed", { platform: "darwin", arch: "arm64" });
	assert.equal(issue.id, "macos-spawn-helper");
	assert.match(issue.summary, /macOS could not execute node-pty's spawn-helper/i);
	assert.match(issue.fixHint, /chmod \+x/i);
});

test("diagnoseNodePtyFailure prefers exact macOS execute-bit diagnosis when probe data is available", () => {
	const issue = diagnoseNodePtyFailure("posix_spawnp failed", {
		platform: "darwin",
		arch: "arm64",
		probe: { helperPath: "/tmp/spawn-helper", helperExists: true, helperExecutable: false, helperQuarantined: false },
	});
	assert.equal(issue.id, "macos-spawn-helper-mode");
	assert.match(issue.summary, /does not have execute permission/i);
	assert.match(issue.steps.join("\n"), /\/tmp\/spawn-helper/);
	assert.match(issue.steps.join("\n"), /chmod \+x '\/tmp\/spawn-helper'/);
});

test("diagnoseNodePtyFailure classifies missing module", () => {
	const issue = diagnoseNodePtyFailure("Cannot find module 'node-pty'", { platform: "darwin", arch: "arm64" });
	assert.equal(issue.id, "missing-module");
	assert.match(issue.fixHint, /reinstall/i);
});

test("diagnoseNodePtyFailure classifies missing native binary", () => {
	const issue = diagnoseNodePtyFailure("Could not locate the bindings file", { platform: "darwin", arch: "arm64" });
	assert.equal(issue.id, "native-missing");
	assert.match(issue.fixHint, /reinstall or rebuild node-pty/i);
});

test("diagnoseNodePtyFailure classifies native mismatch", () => {
	const issue = diagnoseNodePtyFailure("Module did not self-register: NODE_MODULE_VERSION mismatch", { platform: "darwin", arch: "arm64" });
	assert.equal(issue.id, "native-mismatch");
	assert.match(issue.fixHint, /same Node version and architecture/i);
});

test("nodePtyFallbackMessage produces a user-facing warning", () => {
	const msg = nodePtyFallbackMessage({ ok: false, reason: "posix_spawnp failed" });
	assert.match(msg, /Live PTY is disabled/i);
	assert.match(msg, /Press ! for exact steps/i);
});
