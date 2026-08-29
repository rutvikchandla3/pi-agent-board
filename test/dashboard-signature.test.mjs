import assert from "node:assert/strict";
import test from "node:test";
import { rowDataSignature } from "../src/core/dashboard-signature.mjs";

/** @param {Partial<import("../src/core/store.mjs").Row> & {meta: any}} overrides */
function row(overrides) {
	return {
		meta: { id: "a", name: "agent-a", createdAt: 1_000, updatedAt: 1_000, cwd: "/tmp/a", worktreeMode: "normal", pinned: false },
		state: null,
		alive: false,
		hostAlive: false,
		host: null,
		...overrides,
	};
}

test("identical rows produce an identical signature", () => {
	const rows = [row({}), row({ meta: { ...row({}).meta, id: "b" } })];
	assert.equal(rowDataSignature(rows), rowDataSignature(rows.map((r) => ({ ...r, state: r.state ? { ...r.state } : null }))));
});

test("state changes change the signature", () => {
	const idle = row({ state: { semanticState: "idle", processState: "exited" } });
	const working = row({ state: { semanticState: "working", processState: "alive" } });
	assert.notEqual(rowDataSignature([idle]), rowDataSignature([working]));
});

test("second-granularity activity does not change the signature (minute bucketing)", () => {
	const base = row({ state: { semanticState: "working", processState: "alive", lastActivityAt: 60_000_000 } });
	const fewSecondsLater = row({ state: { semanticState: "working", processState: "alive", lastActivityAt: 60_005_000 } });
	assert.equal(rowDataSignature([base]), rowDataSignature([fewSecondsLater]));
});

test("crossing a minute boundary changes the signature", () => {
	const before = row({ state: { semanticState: "working", processState: "alive", lastActivityAt: 60_059_999 } });
	const after = row({ state: { semanticState: "working", processState: "alive", lastActivityAt: 60_060_000 } });
	assert.notEqual(rowDataSignature([before]), rowDataSignature([after]));
});

test("row order changes the signature", () => {
	const a = row({});
	const b = row({ meta: { ...row({}).meta, id: "b" } });
	assert.notEqual(rowDataSignature([a, b]), rowDataSignature([b, a]));
});

test("host state changes the signature", () => {
	const noHost = row({});
	const withHost = row({ host: { state: "alive" }, hostAlive: true });
	assert.notEqual(rowDataSignature([noHost]), rowDataSignature([withHost]));
});
