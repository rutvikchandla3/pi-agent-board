import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { controlPipeName, controlSocketPath, controlSocketPathFor, viewDir } from "../src/core/paths.mjs";

test("controlSocketPath uses a named pipe on win32 (no filesystem socket path)", () => {
	const p = controlSocketPathFor("win32", "C:\\root", "view_abc123");
	assert.ok(p.startsWith("\\\\.\\pipe\\"), `expected \\\\.\\pipe\\ prefix, got ${p}`);
	assert.ok(p.includes("view_abc123"), "pipe name embeds the view id");
	assert.ok(p.length <= 256, "named pipe name must fit Windows 256-char limit");

	if (process.platform === "win32") {
		assert.equal(controlSocketPath("C:\\root", "view_abc123"), p, "live helper follows the platform");
		assert.equal(controlSocketPath("C:\\root", "view_abc123"), controlPipeName("view_abc123"));
	}
});

test("controlSocketPath keeps a file path on non-win32 platforms", () => {
	const expected = join(viewDir("/tmp/root", "view_abc123"), "control.sock");
	assert.equal(controlSocketPathFor("linux", "/tmp/root", "view_abc123"), expected);
	assert.equal(controlSocketPathFor("darwin", "/tmp/root", "view_abc123"), expected);

	if (process.platform !== "win32") {
		assert.equal(controlSocketPath("/tmp/root", "view_abc123"), expected, "live helper follows the platform");
	}
});
