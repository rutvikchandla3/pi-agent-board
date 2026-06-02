import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunStatus, finalizeRun, projectViewState, reduceEvent } from "../src/core/events.mjs";

/** @returns {import("../src/core/types.mjs").RunConfig} */
function cfg(overrides = {}) {
	return {
		root: "/tmp/x",
		viewId: "view_a",
		runId: "run_1",
		kind: "dispatch",
		sessionFile: "/tmp/x/sessions/view_a.jsonl",
		cwd: "/repo",
		prompt: "fix the bug",
		piCommand: "pi",
		piArgsPrefix: [],
		model: null,
		tools: null,
		...overrides,
	};
}

test("createRunStatus starts queued/alive", () => {
	const s = createRunStatus(cfg(), 123, 1000);
	assert.equal(s.semanticState, "queued");
	assert.equal(s.processState, "alive");
	assert.equal(s.pid, 123);
	assert.equal(s.prompt, "fix the bug");
});

test("tool_execution_start moves to working and sets currentTool", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	const meaningful = reduceEvent(
		s,
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { file_path: "src/a.ts" } },
		2000,
	);
	assert.equal(meaningful, true);
	assert.equal(s.semanticState, "working");
	assert.equal(s.currentTool.name, "edit");
	assert.equal(s.currentTool.summary, "Editing a.ts");
	assert.equal(s.summary, "Editing a.ts");
	assert.equal(s.toolCount, 1);
});

test("message_end assistant updates preview and detects question", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(
		s,
		{
			type: "message_end",
			message: {
				role: "assistant",
				model: "m",
				stopReason: "stop",
				content: [{ type: "text", text: "I changed it. Which name should I use?" }],
			},
		},
		2000,
	);
	assert.equal(s.turns, 1);
	assert.equal(s.model, "m");
	assert.match(s.latestAssistantPreview, /I changed it/);
	assert.match(s.question, /Which name/);
});

test("ignores unknown + header events", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	assert.equal(reduceEvent(s, { type: "queue_update" }, 2000), false);
	assert.equal(reduceEvent(s, { type: "session" }, 2000), false);
	assert.equal(reduceEvent(s, null, 2000), false);
});

test("finalizeRun -> idle until user marks done", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	reduceEvent(
		s,
		{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done. Tests pass." }] } },
		2000,
	);
	finalizeRun(s, { exitCode: 0 }, 3000);
	assert.equal(s.semanticState, "idle");
	assert.equal(s.processState, "exited");
	assert.equal(s.pid, null);
	assert.equal(s.endedAt, 3000);
});

test("finalizeRun -> needs_input from trailing question", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	reduceEvent(
		s,
		{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Should I proceed?" }] } },
		2000,
	);
	finalizeRun(s, { exitCode: 0 }, 3000);
	assert.equal(s.semanticState, "needs_input");
	assert.ok(s.question);
});

test("finalizeRun -> failed on nonzero exit", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	finalizeRun(s, { exitCode: 1 }, 3000);
	assert.equal(s.semanticState, "failed");
});

test("finalizeRun -> stopped when stoppedByUser", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	finalizeRun(s, { exitCode: 143, stoppedByUser: true }, 3000);
	assert.equal(s.semanticState, "stopped");
});

test("projectViewState mirrors status", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	reduceEvent(s, { type: "tool_execution_start", toolName: "edit", args: { file_path: "a.ts" } }, 2000);
	const vs = projectViewState(s, 2500, { lastVisitedAt: 1500 });
	assert.equal(vs.viewId, "view_a");
	assert.equal(vs.currentRunId, "run_1");
	assert.equal(vs.semanticState, "working");
	assert.deepEqual(vs.latestTool, { name: "edit", path: "a.ts" });
	assert.equal(vs.lastVisitedAt, 1500);
	assert.equal(vs.lastAgentActivityAt, 2000);
});
