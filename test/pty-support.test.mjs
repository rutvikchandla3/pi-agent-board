import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseNodePtyFailure, nodePtyFallbackMessage } from "../src/core/pty-support.mjs";

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
});

test("diagnoseNodePtyFailure classifies missing module", () => {
	const issue = diagnoseNodePtyFailure("Cannot find module 'node-pty'", { platform: "darwin", arch: "arm64" });
	assert.equal(issue.id, "missing-module");
	assert.match(issue.fixHint, /reinstall/i);
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
