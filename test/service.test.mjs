import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState, writeHost, writeHostPid, writeState } from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-service-"));
}

function service(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		...overrides,
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

test("archive deletes an active or stuck queued row after confirmation", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "stuck", name: "stuck", cwd: "/r" });
		const state = readState(root, "stuck");
		state.semanticState = "queued";
		state.processState = "alive";
		state.summary = "Queued";
		writeState(root, state);

		assert.deepEqual(service(root).archive("stuck"), { ok: true });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), []);
		const archived = readState(root, "stuck");
		assert.equal(archived.semanticState, "stopped");
		assert.equal(archived.processState, "exited");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("launch prefs round-trip through service", () => {
	const root = freshRoot();
	try {
		const svc = service(root);
		svc.saveLaunchPrefs({ cwd: "/tmp/work", model: "openai/gpt-5.4", thinkingLevel: "high" });
		assert.deepEqual(svc.getLaunchPrefs(), {
			version: 1,
			cwd: "/tmp/work",
			model: "openai/gpt-5.4",
			thinkingLevel: "high",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attachTarget uses any live PTY host for fast attach", () => {
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
		assert.deepEqual(service(root).attachTarget("v1"), {
			kind: "pty",
			socketPath: P.controlSocketPath(root, "v1"),
			sessionFile: meta.sessionFile,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch carries cwd, model, and thinking into the hosted session config", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		let launched = null;
		const svc = service(root, {
			launchHost: (_root, config) => {
				launched = config;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
		});
		const res = svc.dispatch("ship it", {
			cwd: "/tmp/project-a",
			model: "anthropic/claude-sonnet-4-8",
			thinkingLevel: "high",
		});
		assert.equal(res.ok, true);
		assert.equal(launched.cwd, "/tmp/project-a");
		assert.equal(launched.model, "anthropic/claude-sonnet-4-8");
		assert.equal(launched.thinkingLevel, "high");
		const row = svc.row(res.viewId);
		assert.equal(row.meta.cwd, "/tmp/project-a");
		assert.equal(row.meta.defaultModel, "anthropic/claude-sonnet-4-8");
		assert.equal(row.meta.defaultThinking, "high");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost starts an idle PTY host without changing row task state", () => {
	const root = freshRoot();
	const oldForce = process.env.AGENT_BOARD_FORCE_PTY;
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, JSON.stringify({ type: "session", id: "s1", cwd: "/r" }) + "\n");
		const before = readState(root, "v1");
		before.semanticState = "completed";
		before.processState = "exited";
		before.summary = "Done";
		writeState(root, before);

		let launched = null;
		const svc = service(root, { launchHost: (_root, config) => {
			launched = config;
			return { pid: process.pid, configPath: "/no/host-config.json" };
		} });
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(res.started, true);
		assert.equal(res.socketPath, P.controlSocketPath(root, "v1"));
		assert.equal(launched.initialPrompt, null);
		const after = readState(root, "v1");
		assert.equal(after.semanticState, "completed");
		assert.equal(after.processState, "exited");
		assert.equal(after.summary, "Done");
	} finally {
		if (oldForce === undefined) delete process.env.AGENT_BOARD_FORCE_PTY;
		else process.env.AGENT_BOARD_FORCE_PTY = oldForce;
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
		assert.equal(next.semanticState, "idle");
		assert.equal(next.processState, "exited");
		assert.equal(next.latestAssistantPreview, "All done.");
		assert.equal(svc.row("v1").alive, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("markCompleted explicitly moves an inactive session to completed", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		s.summary = "All done.";
		s.latestAssistantPreview = "All done.";
		writeState(root, s);

		assert.deepEqual(service(root).markCompleted("v1"), { ok: true });
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.processState, "exited");
		assert.equal(next.summary, "All done.");
		assert.equal(next.needsInput, false);
		assert.equal(next.hasError, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("markVisited records a durable lastVisitedAt timestamp", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const before = readState(root, "v1");
		assert.equal(before.lastVisitedAt, null);
		assert.deepEqual(service(root).markVisited("v1"), { ok: true });
		const after = readState(root, "v1");
		assert.equal(typeof after.lastVisitedAt, "number");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("markCompletedMany completes inactive rows and skips live/already-done rows", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "idle1", name: "idle1", cwd: "/r" });
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "live1", name: "live1", cwd: "/r" });
		const idle = readState(root, "idle1");
		idle.semanticState = "idle";
		idle.processState = "exited";
		writeState(root, idle);
		const done = readState(root, "done1");
		done.semanticState = "completed";
		done.processState = "exited";
		writeState(root, done);
		const live = readState(root, "live1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(service(root).markCompletedMany(["idle1", "done1", "live1"]), {
			ok: true,
			completed: 1,
			skipped: 2,
			completedIds: ["idle1"],
		});
		assert.equal(readState(root, "idle1").semanticState, "completed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("archiveMany archives explicit completed rows and skips live ones", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "done1", name: "done1", cwd: "/r" });
		createView(root, { id: "done2", name: "done2", cwd: "/r" });
		createView(root, { id: "live1", name: "live1", cwd: "/r" });
		for (const id of ["done1", "done2"]) {
			const s = readState(root, id);
			s.semanticState = "completed";
			s.processState = "exited";
			writeState(root, s);
		}
		const live = readState(root, "live1");
		live.semanticState = "working";
		live.processState = "alive";
		writeState(root, live);

		assert.deepEqual(service(root).archiveMany(["done1", "done2", "live1"]), { ok: true, archived: 2, skipped: 1 });
		assert.deepEqual(service(root).rows().map((r) => r.meta.id), ["live1"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
