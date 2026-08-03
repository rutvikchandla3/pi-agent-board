import assert from "node:assert/strict";
import test from "node:test";
import { requestDashboardRender } from "../src/core/dashboard-render.mjs";

test("dashboard repaint preserves Pi TUI differential render state", () => {
	const calls = [];
	requestDashboardRender({ requestRender: (...args) => calls.push(args) });
	assert.deepEqual(calls, [[]]);
});
