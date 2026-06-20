import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApprovePlanPrompt, buildPlanChangesPrompt, buildPlanRequestPrompt } from "../src/core/steering-prompts.mjs";
import { approvePlan, readSteering, recordPlanReady, requestPlan, requestPlanChanges, summarizeSteering } from "../src/core/steering.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-steering-"));
}

test("steering transitions through plan approval", () => {
	const root = freshRoot();
	try {
		assert.equal(readSteering(root, "v1").status, "none");
		requestPlan(root, "v1", { note: "make a plan" });
		assert.equal(readSteering(root, "v1").status, "plan_requested");
		recordPlanReady(root, "v1", { planText: "1. Do thing", runId: "r1" });
		const ready = readSteering(root, "v1");
		assert.equal(ready.status, "awaiting_approval");
		assert.equal(summarizeSteering(ready).awaitingApproval, true);
		const approved = approvePlan(root, "v1");
		assert.equal(approved.ok, true);
		assert.equal(readSteering(root, "v1").status, "approved");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("steering prompts include requested context", () => {
	assert.match(buildPlanRequestPrompt("ship it"), /ship it/);
	assert.match(buildApprovePlanPrompt("plan body"), /plan body/);
	assert.match(buildPlanChangesPrompt("old", "new"), /new/);
});

test("plan change request requires feedback", () => {
	const root = freshRoot();
	try {
		assert.equal(requestPlanChanges(root, "v1", "").ok, false);
		assert.equal(requestPlanChanges(root, "v1", "revise").ok, true);
		assert.equal(readSteering(root, "v1").status, "changes_requested");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
