import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunStatus, finalizeRun } from "../src/core/events.mjs";
import {
	emptyEvidenceSnapshot,
	finalizeEvidence,
	readEvidence,
	reduceEvidence,
	summarizeEvidence,
	writeEvidence,
} from "../src/core/evidence.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-evidence-"));
}

test("evidence reducer captures files, commands, errors, assistant evidence, and final outcome", () => {
	const snap = emptyEvidenceSnapshot({ viewId: "v1", runId: "r1" });
	reduceEvidence(snap, { type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "src/a.ts" } }, 10);
	reduceEvidence(snap, { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "npm test" } }, 20);
	reduceEvidence(snap, { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", isError: false, result: "ok" }, 30);
	reduceEvidence(snap, { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", isError: true }, 40);
	reduceEvidence(snap, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Tests pass." }] } }, 50);
	assert.equal(snap.fileChanges.length, 1);
	assert.equal(snap.fileChanges[0].path, "src/a.ts");
	assert.equal(snap.commands[0].kind, "test");
	assert.equal(snap.commands[0].status, "passed");
	assert.equal(snap.errors.length, 1);
	assert.equal(snap.assistantEvidence.at(-1).text, "Tests pass.");
	const status = createRunStatus({ viewId: "v1", runId: "r1", kind: "dispatch", prompt: "x", model: null }, null, 1);
	finalizeRun(status, { exitCode: 0 }, 60);
	finalizeEvidence(snap, status, 60);
	const summary = summarizeEvidence(snap);
	assert.equal(summary.ready, true);
	assert.equal(summary.commandCount, 1);
});

test("view evidence persists", () => {
	const root = freshRoot();
	try {
		const snap = emptyEvidenceSnapshot({ viewId: "v1" });
		snap.summary = "done";
		writeEvidence(root, snap);
		assert.equal(readEvidence(root, "v1").summary, "done");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
