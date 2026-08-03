import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService, shouldProbePtySupport } from "../src/runtime/service.mjs";
import { diagnoseNodePtyFailure } from "../src/core/pty-support.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState, writeHost, writeHostPid, writeState } from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-service-"));
}

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(dir) {
	execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
}

function service(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
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

test("dispatch schedules detached GPT title generation", () => {
	const root = freshRoot();
	let titled = null;
	try {
		const svc = service(root, {
			titleRunnerScript: "/no/title-runner.mjs",
			launchTitle: (_root, config) => {
				titled = config;
				return { pid: null, configPath: "/no/title-config.json" };
			},
		});
		const res = svc.dispatch("fix websocket reconnect bug", { cwd: "/tmp/project-a" });
		assert.equal(res.ok, true);
		assert.equal(titled.prompt, "fix websocket reconnect bug");
		assert.equal(titled.viewId, res.viewId);
		assert.equal(titled.fallbackName, "fix-websocket-reconnect-bug");
		assert.equal(titled.cwd, "/tmp/project-a");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("successful PTY support stays cached for the process lifetime", () => {
	const cached = { ok: true, checkedAt: 1 };
	assert.equal(shouldProbePtySupport(cached, {}, 60_000), false);
	assert.equal(shouldProbePtySupport(cached, { refresh: true }, 60_000), false);
});

test("failed PTY support respects expiry and explicit refresh", () => {
	const cached = { ok: false, checkedAt: 1_000 };
	assert.equal(shouldProbePtySupport(undefined, {}, 1_500), true);
	assert.equal(shouldProbePtySupport(cached, {}, 1_500), false);
	assert.equal(shouldProbePtySupport(cached, {}, 3_000), true);
	assert.equal(shouldProbePtySupport(cached, { refresh: true }, 1_500), true);
});

test("dispatch refreshes PTY support so a fixed install can recover without restarting Pi", () => {
	const root = freshRoot();
	let healthy = false;
	const calls = [];
	let hostLaunches = 0;
	let jsonLaunches = 0;
	try {
		const svc = service(root, {
			ptySupport: (opts = {}) => {
				calls.push(opts);
				return healthy
					? { ok: true }
					: { ok: false, reason: "posix_spawnp failed", issue: diagnoseNodePtyFailure("posix_spawnp failed", { platform: "darwin", arch: "arm64" }) };
			},
			launchHost: () => {
				hostLaunches += 1;
				return { pid: process.pid, configPath: "/no/host-config.json" };
			},
			launch: () => {
				jsonLaunches += 1;
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const first = svc.dispatch("first", { cwd: "/tmp/project-a" });
		assert.equal(first.ok, true);
		assert.equal(first.hostMode, "json-runner");
		assert.equal(jsonLaunches, 1);
		healthy = true;
		const second = svc.dispatch("second", { cwd: "/tmp/project-a" });
		assert.equal(second.ok, true);
		assert.equal(second.hostMode, "pty");
		assert.equal(hostLaunches, 1);
		assert.equal(calls.length, 2);
		assert.equal(calls.every((opts) => opts.refresh === true), true);
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

test("dispatch rejects explicit worktree requests", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = freshRoot();
	try {
		initRepo(repo);
		const res = service(root).dispatch("ship it", { cwd: repo, worktree: true });
		assert.deepEqual(res, { ok: false, error: "Worktree mode is currently disabled." });
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("dispatch allows a second active session in the same repo", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = freshRoot();
	try {
		initRepo(repo);
		const svc = service(root);
		const first = svc.dispatch("first", { cwd: repo });
		assert.equal(first.ok, true);
		const second = svc.dispatch("second", { cwd: repo });
		assert.equal(second.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("dispatch allows a second active session in the same non-git folder", () => {
	const root = freshRoot();
	const folder = freshRoot();
	try {
		const svc = service(root);
		const first = svc.dispatch("first", { cwd: folder });
		assert.equal(first.ok, true);
		const second = svc.dispatch("second", { cwd: folder });
		assert.equal(second.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(folder, { recursive: true, force: true });
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

test("syncHostedEvent persists interactive questions and resets them on new input", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		assert.equal(svc.syncHostedEvent("v1", {
			type: "tool_execution_start",
			toolCallId: "q1",
			toolName: "ask_questions",
			args: { questions: [{ question: "Choose a mode?" }] },
		}), true);
		const waiting = readState(root, "v1");
		assert.equal(waiting.semanticState, "needs_input");
		assert.equal(waiting.processState, "alive");
		assert.equal(waiting.needsInput, true);
		assert.equal(waiting.question, "Choose a mode?");
		assert.deepEqual(waiting.pendingQuestions, [{ toolCallId: "q1", question: "Choose a mode?" }]);
		assert.equal(svc.markCompleted("v1").ok, false);
		assert.deepEqual(svc.reply("v1", "safe"), { ok: false, error: "Attach to answer the pending question" });

		assert.equal(svc.syncHostedEvent("v1", { type: "input", text: "safe" }), true);
		const resumed = readState(root, "v1");
		assert.equal(resumed.semanticState, "working");
		assert.equal(resumed.needsInput, false);
		assert.equal(resumed.question, null);
		assert.deepEqual(resumed.pendingQuestions, []);
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
		assert.equal(next.autoState?.kind, "done");
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

test("busy replies queue and drain when idle", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const queued = svc.reply("v1", "next step");
		assert.equal(queued.ok, true);
		assert.equal(queued.queued, true);
		assert.equal(svc.followUps("v1").summary.queuedCount, 1);

		const idle = readState(root, "v1");
		idle.semanticState = "idle";
		idle.processState = "exited";
		writeState(root, idle);
		const drained = svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(launched.length, 1);
		assert.equal(launched[0].prompt, "next step");
		assert.equal(svc.followUps("v1").summary.queuedCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adoptSession creates and reuses rows for an existing session file", () => {
	const root = freshRoot();
	try {
		const sessionFile = join(root, "current.jsonl");
		const svc = service(root);
		const first = svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		assert.equal(first.ok, true);
		assert.equal(first.reused, false);
		const second = svc.adoptSession({ sessionFile, cwd: "/r", name: "current renamed" });
		assert.equal(second.ok, true);
		assert.equal(second.reused, true);
		assert.equal(second.viewId, first.viewId);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile does not drain queued follow-ups after failed terminal state", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "failed";
		st.processState = "exited";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		svc.queueFollowUp("v1", "should wait");
		svc.reconcile();
		assert.equal(launched.length, 0);
		assert.equal(svc.followUps("v1").summary.queuedCount, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("busy steering actions queue raw steering payloads", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		writeState(root, st);
		const svc = service(root);
		const res = svc.requestPlan("v1", "make a plan");
		assert.equal(res.ok, true);
		const queue = svc.followUps("v1").queue;
		assert.equal(queue.items[0].kind, "plan_request");
		assert.equal(queue.items[0].text, "make a plan");
		assert.doesNotMatch(queue.items[0].text, /Create an implementation plan only/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("idle non-PTY plan request launches with plan run kind", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		writeState(root, st);
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const res = svc.requestPlan("v1", "make a plan");
		assert.equal(res.ok, true);
		assert.equal(launched.length, 1);
		assert.equal(launched[0].kind, "plan");
		assert.match(launched[0].prompt, /Create an implementation plan only/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adoptSession resets reused inactive failed row to idle so queued bg prompts can drain", () => {
	const root = freshRoot();
	try {
		const sessionFile = join(root, "current.jsonl");
		const svc = service(root);
		const first = svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		const state = readState(root, first.viewId);
		state.semanticState = "failed";
		state.processState = "exited";
		state.hasError = true;
		state.error = "old failure";
		writeState(root, state);
		const reused = svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		assert.equal(reused.reused, true);
		const next = readState(root, first.viewId);
		assert.equal(next.semanticState, "idle");
		assert.equal(next.hasError, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile finalizes host-backed row when PTY host exits without agent_end", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "queued";
		st.processState = "alive";
		st.currentRunId = null;
		writeState(root, st);
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: null,
			childPid: null,
			socketPath: P.controlSocketPath(root, "v1"),
			state: "exited",
			startedAt: 1,
			lastSeenAt: 2,
			endedAt: 3,
			exitCode: 0,
			error: null,
			cols: 80,
			rows: 24,
			attachedClients: 0,
		});
		const fixed = service(root).reconcile();
		assert.equal(fixed, 1);
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "idle");
		assert.equal(next.processState, "exited");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adopted external session does not fall back to JSON runner when PTY is unavailable", () => {
	const root = freshRoot();
	try {
		const sessionFile = join(root, "external-current.jsonl");
		const launched = [];
		const svc = service(root, {
			ptySupport: () => ({ ok: false, reason: "test" }),
			launch: (_root, config) => {
				launched.push(config);
				return { pid: null, configPath: "/no/config.json" };
			},
		});
		const adopted = svc.adoptSession({ sessionFile, cwd: "/r", name: "current" });
		const res = svc.reply(adopted.viewId, "continue", { delivery: "now" });
		assert.equal(res.ok, false);
		assert.match(res.error, /PTY is required/);
		assert.equal(launched.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reconcile finalizes stale starting/alive host snapshots", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "working";
		st.processState = "alive";
		st.currentRunId = null;
		writeState(root, st);
		writeHost(root, {
			version: 1,
			viewId: "v1",
			mode: "pty",
			runnerPid: 99999999,
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
		assert.equal(service(root).reconcile(), 1);
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "failed");
		assert.equal(next.processState, "exited");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
