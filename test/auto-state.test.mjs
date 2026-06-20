import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAutoStateToStatus, autoStateFromModelOrHeuristic, heuristicAutoState, parseAutoStateModelOutput } from "../src/core/auto-state.mjs";

test("parseAutoStateModelOutput normalizes model JSON", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
	});
	assert.equal(c.kind, "done");
	assert.equal(c.semanticState, "completed");
	assert.equal(c.source, "model");
	assert.equal(c.confidence, "high");
	assert.equal(c.lastAgentActivityAt, 42);
});

test("autoStateFromModelOrHeuristic falls back to question heuristic", () => {
	const c = autoStateFromModelOrHeuristic("not json", "Which deployment target should I use?");
	assert.equal(c.kind, "needs_input");
	assert.equal(c.semanticState, "needs_input");
	assert.match(c.question, /deployment target/i);
});

test("heuristicAutoState detects done and in-progress turns", () => {
	assert.equal(heuristicAutoState("Done. Fixed the bug and tests pass.").kind, "done");
	assert.equal(heuristicAutoState("I updated one file. Next step is to add tests.").kind, "in_progress");
});

test("applyAutoStateToStatus moves clean terminal run to completed", () => {
	const status = {
		processState: "exited",
		semanticState: "idle",
		currentTool: null,
		question: null,
		error: null,
		latestAssistantPreview: "Done. Fixed the bug and tests pass.",
		summary: "Done. Fixed the bug and tests pass.",
	};
	const changed = applyAutoStateToStatus(status, heuristicAutoState(status.latestAssistantPreview), 100);
	assert.equal(changed, true);
	assert.equal(status.semanticState, "completed");
	assert.equal(status.autoState.kind, "done");
});
