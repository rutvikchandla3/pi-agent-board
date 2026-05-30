import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState, writeHost, writeHostPid, writeState } from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-service-"));
}

function service(root) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
	});
}

test("archiveByState archives inactive rows and skips live rows", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "done2", name: "done2", cwd: "/r" });
		createView(root, { id: "work1", name: "work1", cwd: "/r" });
		for (const id of ["done1", "done2"]) {
			const s = readState(root, id);
			s.semanticState = "completed";
			s.processState = "exited";
			writeState(root, s);
		}
		const live = readState(root, "work1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(service(root).archiveByState("completed"), { ok: true, archived: 2, skipped: 0 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["work1"]);
		assert.deepEqual(service(root).archiveByState("working"), { ok: true, archived: 0, skipped: 1 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["work1"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attachTarget uses PTY only for busy live hosts and falls back to session otherwise", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		assert.deepEqual(service(root).attachTarget("v1"), { kind: "session", sessionFile: meta.sessionFile });
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: process.pid,
			childPid: null,
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
		});
		writeHostPid(root, "v1", process.pid);
		assert.deepEqual(service(root).attachTarget("v1"), { kind: "session", sessionFile: meta.sessionFile });

		const busy = readState(root, "v1");
		busy.semanticState = "working";
		busy.processState = "alive";
		writeState(root, busy);
		assert.equal(service(root).attachTarget("v1").kind, "pty");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncForegroundEvent marks a managed attached session working when user inputs", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "needs_input";
		s.processState = "exited";
		s.summary = "Needs input";
		s.question = "Proceed?";
		writeState(root, s);

		assert.equal(service(root).syncForegroundEvent(meta.sessionFile, { type: "input", text: "yes" }), true);
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "working");
		assert.equal(next.processState, "alive");
		assert.equal(next.currentRunId, null);
		assert.equal(next.question, null);
		assert.equal(service(root).row("v1").alive, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("syncForegroundEvent finalizes attached foreground turn from assistant output", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		svc.syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		svc.syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
		});
		svc.syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.processState, "exited");
		assert.equal(next.latestAssistantPreview, "All done.");
		assert.equal(svc.row("v1").alive, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
