import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSummary, fallbackStatusText, finalizeSemanticState } from "../src/core/derive.mjs";

test("finalizeSemanticState matrix", () => {
	assert.equal(
		finalizeSemanticState({ exitCode: 0, stopReason: "stop", stoppedByUser: false, needsInput: false }),
		"idle",
	);
	assert.equal(
		finalizeSemanticState({ exitCode: 0, stopReason: "stop", stoppedByUser: false, needsInput: true }),
		"needs_input",
	);
	assert.equal(
		finalizeSemanticState({ exitCode: 1, stopReason: "stop", stoppedByUser: false, needsInput: false }),
		"failed",
	);
	assert.equal(
		finalizeSemanticState({ exitCode: 0, stopReason: "error", stoppedByUser: false, needsInput: false }),
		"failed",
	);
	assert.equal(
		finalizeSemanticState({ exitCode: 0, stopReason: "stop", stoppedByUser: true, needsInput: true }),
		"stopped",
	);
	assert.equal(
		finalizeSemanticState({ exitCode: 0, stopReason: "stop", stoppedByUser: false, needsInput: false, openEnded: true }),
		"idle",
	);
});

test("deriveSummary priority: active tool while alive", () => {
	const s = {
		processState: "alive",
		semanticState: "working",
		currentTool: { name: "edit", path: "src/a.ts", summary: "Editing a.ts" },
		question: null,
		error: null,
		latestAssistantPreview: "blah",
	};
	assert.equal(deriveSummary(s), "Editing a.ts");
});

test("deriveSummary priority: blocker for needs_input", () => {
	const s = {
		processState: "exited",
		semanticState: "needs_input",
		currentTool: null,
		question: "Which option?",
		error: null,
		latestAssistantPreview: "I did stuff",
	};
	assert.equal(deriveSummary(s), "Which option?");
});

test("deriveSummary priority: error for failed", () => {
	const s = {
		processState: "exited",
		semanticState: "failed",
		currentTool: null,
		question: null,
		error: "Provider exploded",
		latestAssistantPreview: "",
	};
	assert.equal(deriveSummary(s), "Provider exploded");
});

test("deriveSummary falls back to preview then status text", () => {
	assert.equal(
		deriveSummary({
			processState: "exited",
			semanticState: "completed",
			currentTool: null,
			question: null,
			error: null,
			latestAssistantPreview: "All done here",
		}),
		"All done here",
	);
	assert.equal(
		deriveSummary({
			processState: "exited",
			semanticState: "completed",
			currentTool: null,
			question: null,
			error: null,
			latestAssistantPreview: "",
		}),
		"Completed",
	);
});

test("fallbackStatusText", () => {
	assert.equal(fallbackStatusText("queued"), "Queued");
	assert.equal(fallbackStatusText("needs_input"), "Needs input");
});
