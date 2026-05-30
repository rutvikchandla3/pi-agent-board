import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepoRoot, isDirty, sameRepo } from "../src/core/repo.mjs";

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function realpath(p) {
	return execFileSync("node", ["-e", `process.stdout.write(require('fs').realpathSync(${JSON.stringify(p)}))`], {
		encoding: "utf8",
	});
}

test("gitRepoRoot returns null outside a repo", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-norepo-"));
	try {
		assert.equal(gitRepoRoot(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitRepoRoot + isDirty inside a temp repo", { skip: !gitAvailable() }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-repo-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
		const root = gitRepoRoot(dir);
		assert.equal(root, realpath(dir));
		assert.equal(isDirty(root), false);
		writeFileSync(join(dir, "a.txt"), "hi");
		assert.equal(isDirty(root), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sameRepo compares roots", () => {
	assert.equal(sameRepo("/a", "/a"), true);
	assert.equal(sameRepo("/a", "/b"), false);
	assert.equal(sameRepo(null, null), false);
});
