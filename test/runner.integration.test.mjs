import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { launchRun } from "../src/core/launch.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readPid, readState, readStatus } from "../src/core/store.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT_DIR, "runner", "job-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-pi.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn()` until it returns truthy or timeout. */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 50) {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

function makeConfig(root, viewId, runId, sessionFile, cwd, prompt) {
	return {
		root,
		viewId,
		runId,
		kind: "dispatch",
		sessionFile,
		cwd,
		prompt,
		piCommand: process.execPath, // node ...
		piArgsPrefix: [FAKE_PI], // ... fake-pi.mjs
		model: null,
		tools: null,
	};
}

test("runner drives a fake worker to idle and writes durable artifacts", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-"));
	const env = { ...process.env };
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	try {
		const meta = createView(root, { id: "view_1", name: "fix", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "fix the bug");

		// link the current run into state so loadRow can find pid
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);

		const { pid } = launchRun(root, config, { runnerScript: RUNNER });
		assert.ok(pid && pid > 0, "runner spawned");

		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status, "status reached terminal state");
		assert.equal(status.semanticState, "idle");
		assert.equal(status.processState, "exited");
		assert.equal(status.exitCode, 0);
		assert.ok(status.toolCount >= 1, "saw a tool execution");
		assert.match(status.latestAssistantPreview, /token expiry/i);
		assert.ok(status.summary.length > 0, "has a summary");

		assert.ok(existsSync(P.eventsPath(root, "view_1", "run_1")), "events.jsonl exists");
		assert.ok(existsSync(meta.sessionFile), "fake worker persisted the session file");

		const state = readState(root, "view_1");
		assert.equal(state.semanticState, "idle");
		assert.equal(state.currentRunId, "run_1");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		Object.assign(process.env, { AGENT_BOARD_SUMMARY_MODEL: env.AGENT_BOARD_SUMMARY_MODEL });
		rmSync(root, { recursive: true, force: true });
	}
});

test("runner classifies a question as needs_input", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-ni-"));
	process.env.FAKE_PI_MODE = "needs_input";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		launchRun(root, config, { runnerScript: RUNNER });
		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status);
		assert.equal(status.semanticState, "needs_input");
		assert.ok(status.question, "extracted a question");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true });
	}
});

test("runner marks failed when the worker exits nonzero", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-fail-"));
	process.env.FAKE_PI_MODE = "fail";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		launchRun(root, config, { runnerScript: RUNNER });
		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status);
		assert.equal(status.semanticState, "failed");
		assert.notEqual(status.exitCode, 0);
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true });
	}
});

test("stopping the runner finalizes the run as stopped", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-stop-"));
	process.env.FAKE_PI_MODE = "hang";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		launchRun(root, config, { runnerScript: RUNNER });

		// Wait until the worker is actively running.
		const working = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.semanticState === "working" ? s : null;
		});
		assert.ok(working, "run reached working");

		const pid = readPid(root, "v", "r");
		assert.ok(pid, "have runner pid");
		process.kill(pid, "SIGTERM");

		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status, "run finalized after stop");
		assert.equal(status.semanticState, "stopped");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true });
	}
});
