import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionText } from "../src/core/session-view.mjs";

function line(obj) {
	return `${JSON.stringify(obj)}\n`;
}

test("parseSessionText projects the active branch from the last leaf", () => {
	const text =
		line({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }) +
		line({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "start" } }) +
		line({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) +
		line({ type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "branch a" } }) +
		line({ type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "done a" }] } }) +
		line({ type: "message", id: "u3", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: "branch b" } }) +
		line({ type: "message", id: "a3", parentId: "u3", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "done b" }] } });

	const view = parseSessionText(text);
	assert.equal(view.header?.cwd, "/repo");
	assert.deepEqual(
		view.items.map((i) => [i.role, i.text]),
		[
			["user", "start"],
			["assistant", "ok"],
			["user", "branch b"],
			["assistant", "done b"],
		],
	);
});

test("parseSessionText keeps visible custom messages and summaries, skips hidden custom messages", () => {
	const text =
		line({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }) +
		line({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "start" } }) +
		line({ type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", summary: "older context" }) +
		line({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-01-01T00:00:03.000Z", fromId: "x", summary: "other path" }) +
		line({ type: "custom_message", id: "m1", parentId: "b1", timestamp: "2026-01-01T00:00:04.000Z", customType: "my-ext", content: [{ type: "text", text: "visible" }], display: true }) +
		line({ type: "custom_message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:05.000Z", customType: "my-ext", content: "hidden", display: false }) +
		line({ type: "message", id: "a1", parentId: "m2", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });

	const view = parseSessionText(text);
	assert.deepEqual(
		view.items.map((i) => [i.role, i.label, i.text]),
		[
			["user", "you", "start"],
			["note", "compaction", "older context"],
			["note", "branch summary", "other path"],
			["custom", "my-ext", "visible"],
			["assistant", "agent", "done"],
		],
	);
});
