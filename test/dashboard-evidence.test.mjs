import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidencePanel } from "../src/ui/dashboard-evidence.mjs";

test("evidence panel renders key sections", () => {
	const lines = buildEvidencePanel({
		width: 100,
		row: { meta: { name: "fix bug" }, state: { semanticState: "idle" } },
		evidence: {
			outcome: "ready",
			ready: true,
			summary: "Implemented fix",
			fileChanges: [{ path: "src/a.ts", action: "edited", count: 1 }],
			commands: [{ command: "npm test", kind: "test", status: "passed" }],
			errors: [],
			assistantEvidence: [{ text: "Tests pass." }],
		},
		diagnostics: [{ at: Date.now(), level: "info", code: "runner_start", message: "started" }],
		paths: { evidence: "/tmp/evidence.json" },
	});
	const text = lines.join("\n");
	assert.match(text, /Evidence \/ diagnostics/);
	assert.match(text, /Changed files/);
	assert.match(text, /src\/a.ts/);
	assert.match(text, /Commands/);
	assert.match(text, /npm test/);
	assert.match(text, /Diagnostics/);
	assert.match(text, /Artifacts/);
});
