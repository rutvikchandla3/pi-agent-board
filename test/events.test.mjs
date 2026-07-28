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
	assert.equal(s.lastAgentActivityAt, null);
});

test("tool errors track the latest failure and survive unrelated tool success", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true }, 2000);
	assert.equal(s.error, "Tool bash failed");
	assert.equal(projectViewState(s, 2100).error, "Tool bash failed");

	reduceEvent(s, { type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: true }, 2200);
	assert.equal(s.error, "Tool read failed");

	reduceEvent(s, { type: "tool_execution_end", toolCallId: "t3", toolName: "edit", isError: false }, 2300);
	assert.equal(s.error, "Tool read failed");
});

test("successful assistant recovery clears current errors", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true }, 2000);

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "toolUse", content: [] },
	}, 2100);
	assert.equal(s.error, "Tool bash failed");

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "error", content: [] },
	}, 2200);
	assert.equal(s.error, "Tool bash failed");

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "aborted", content: [] },
	}, 2300);
	assert.equal(s.error, "Tool bash failed");

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "Provider failed", content: [] },
	}, 2400);
	assert.equal(s.error, "Provider failed");
	assert.equal(projectViewState(s, 2450).error, "Provider failed");

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered." }] },
	}, 2500);
	assert.equal(s.error, null);
	const recovered = projectViewState(s, 2600);
	assert.equal(recovered.error, null);
	assert.equal(recovered.hasError, false);
});

test("terminal failure preserves an unrecovered tool error", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true }, 2000);
	finalizeRun(s, { exitCode: 1 }, 3000);
	assert.equal(s.error, "Tool bash failed");
	const failed = projectViewState(s, 3100);
	assert.equal(failed.error, "Tool bash failed");
	assert.equal(failed.hasError, true);
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

test("projectViewState preserves last unread message until a new assistant reply arrives", () => {
	const s = createRunStatus(cfg(), 5, 1000);
	reduceEvent(s, { type: "tool_execution_start", toolName: "edit", args: { file_path: "a.ts" } }, 2000);
	const vs = projectViewState(s, 2500, { lastVisitedAt: 1500, lastAgentActivityAt: 1200 });
	assert.equal(vs.viewId, "view_a");
	assert.equal(vs.currentRunId, "run_1");
	assert.equal(vs.semanticState, "working");
	assert.deepEqual(vs.latestTool, { name: "edit", path: "a.ts" });
	assert.equal(vs.lastVisitedAt, 1500);
	assert.equal(vs.lastAgentActivityAt, 1200);

	reduceEvent(s, {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented it." }] },
	}, 3000);
	const next = projectViewState(s, 3500, vs);
	assert.equal(next.lastAgentActivityAt, 3000);
});
