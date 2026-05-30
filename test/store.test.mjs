import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as P from "../src/core/paths.mjs";
import {
	addToRoster,
	createView,
	listRows,
	loadRow,
	readMeta,
	readRoster,
	readState,
	readHost,
	readStatus,
	removeFromRoster,
	writeHost,
	writeHostPid,
	writeMeta,
	writeState,
	writeStatus,
} from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-store-"));
}

test("createView writes meta, state, roster, session path", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "view_a", name: "fix-bug", cwd: "/repo", repoRoot: "/repo" });
		assert.equal(meta.id, "view_a");
		assert.equal(meta.sessionFile, P.sessionFilePath(root, "view_a"));
		assert.equal(meta.kind, "pi-session");
		assert.equal(meta.archived, false);

		const reread = readMeta(root, "view_a");
		assert.deepEqual(reread, meta);

		const state = readState(root, "view_a");
		assert.equal(state.semanticState, "queued");

		const roster = readRoster(root);
		assert.deepEqual(roster.views, ["view_a"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("roster add/remove is idempotent", () => {
	const root = freshRoot();
	try {
		addToRoster(root, "v1");
		addToRoster(root, "v1");
		addToRoster(root, "v2");
		assert.deepEqual(readRoster(root).views, ["v1", "v2"]);
		removeFromRoster(root, "v1");
		assert.deepEqual(readRoster(root).views, ["v2"]);
		removeFromRoster(root, "missing");
		assert.deepEqual(readRoster(root).views, ["v2"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listRows excludes archived by default", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const m2 = createView(root, { id: "v2", name: "b", cwd: "/r" });
		m2.archived = true;
		writeMeta(root, m2);

		const visible = listRows(root);
		assert.deepEqual(visible.map((r) => r.meta.id), ["v1"]);

		const all = listRows(root, { includeArchived: true });
		assert.deepEqual(all.map((r) => r.meta.id).sort(), ["v1", "v2"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadRow treats foreground-mirrored processState as alive without a pid", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const state = readState(root, "v1");
		state.currentRunId = null;
		state.semanticState = "working";
		state.processState = "alive";
		writeState(root, state);

		const row = loadRow(root, "v1");
		assert.equal(row.alive, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host status round-trips and loadRow exposes hostAlive", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const host = {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: process.pid,
			childPid: process.pid,
			socketPath: P.controlSocketPath(root, "v1"),
			state: "alive",
			startedAt: 1,
			lastSeenAt: 2,
			endedAt: null,
			exitCode: null,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		};
		writeHost(root, host);
		writeHostPid(root, "v1", process.pid);
		assert.deepEqual(readHost(root, "v1"), host);
		const row = loadRow(root, "v1");
		assert.equal(row.hostAlive, true);
		assert.equal(row.host.socketPath, P.controlSocketPath(root, "v1"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status round-trips and loadRow reflects state", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		/** @type {import("../src/core/types.mjs").RunStatus} */
		const status = {
			version: 1,
			runId: "run_1",
			viewId: "v1",
			pid: null,
			startedAt: 1,
			endedAt: 2,
			exitCode: 0,
			kind: "dispatch",
			prompt: "p",
			model: null,
			semanticState: "completed",
			processState: "exited",
			summary: "Completed",
			lastActivityAt: 2,
			currentTool: null,
			latestAssistantPreview: "done",
			question: null,
			error: null,
			stopReason: "stop",
			stoppedByUser: false,
			turns: 1,
			toolCount: 0,
		};
		writeStatus(root, status);
		assert.deepEqual(readStatus(root, "v1", "run_1"), status);

		const state = readState(root, "v1");
		state.currentRunId = "run_1";
		state.semanticState = "completed";
		writeState(root, state);

		const row = loadRow(root, "v1");
		assert.equal(row.state.semanticState, "completed");
		assert.equal(row.alive, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
