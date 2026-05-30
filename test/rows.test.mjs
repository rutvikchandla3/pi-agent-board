import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRows, groupRows, parseFilter, rowState, stateGlyph } from "../src/core/rows.mjs";

/** @returns {import("../src/core/store.mjs").Row} */
function row(id, semanticState, extra = {}) {
	return {
		meta: {
			id,
			name: extra.name ?? id,
			cwd: extra.cwd ?? "/repo",
			repoCwd: extra.repoCwd ?? "/repo",
			worktreeMode: extra.worktreeMode ?? "off",
			pinned: extra.pinned ?? false,
			updatedAt: 0,
			createdAt: 0,
		},
		state: {
			semanticState,
			summary: extra.summary ?? "",
			lastActivityAt: extra.lastActivityAt ?? 0,
		},
		alive: extra.alive ?? false,
	};
}

test("rowState defaults to queued", () => {
	assert.equal(rowState({ meta: {}, state: null, alive: false }), "queued");
	assert.equal(rowState(row("x", "working")), "working");
});

test("groupRows orders by GROUP_ORDER and omits empty groups", () => {
	const rows = [row("a", "completed"), row("b", "needs_input"), row("c", "working")];
	const groups = groupRows(rows, 0);
	assert.deepEqual(groups.map((g) => g.state), ["needs_input", "working", "completed"]);
});

test("groupRows sorts pinned first then recent", () => {
	const rows = [
		row("a", "working", { lastActivityAt: 100 }),
		row("b", "working", { lastActivityAt: 300 }),
		row("c", "working", { lastActivityAt: 200, pinned: true }),
	];
	const [working] = groupRows(rows, 1000);
	assert.deepEqual(working.rows.map((r) => r.id), ["c", "b", "a"]);
});

test("parseFilter splits state + terms", () => {
	const f = parseFilter("s:working auth bug");
	assert.deepEqual(f.states, ["working"]);
	assert.deepEqual(f.terms, ["auth", "bug"]);
});

test("parseFilter prefix matches multiple states", () => {
	const f = parseFilter("s:need");
	assert.deepEqual(f.states, ["needs_input"]);
});

test("filterRows by state", () => {
	const rows = [row("a", "working"), row("b", "completed")];
	assert.deepEqual(filterRows(rows, "s:working").map((r) => r.meta.id), ["a"]);
});

test("filterRows by free text over name/summary/cwd (AND)", () => {
	const rows = [
		row("a", "working", { name: "auth-fix", summary: "editing middleware" }),
		row("b", "working", { name: "ui-thing", summary: "styling" }),
	];
	assert.deepEqual(filterRows(rows, "auth").map((r) => r.meta.id), ["a"]);
	assert.deepEqual(filterRows(rows, "auth middleware").map((r) => r.meta.id), ["a"]);
	assert.deepEqual(filterRows(rows, "auth styling").map((r) => r.meta.id), []);
});

test("filterRows empty query returns all", () => {
	const rows = [row("a", "working"), row("b", "completed")];
	assert.equal(filterRows(rows, "").length, 2);
});

test("stateGlyph distinguishes alive working", () => {
	assert.equal(stateGlyph("working", true), "●");
	assert.equal(stateGlyph("working", false), "◐");
	assert.equal(stateGlyph("needs_input", false), "◆");
});
