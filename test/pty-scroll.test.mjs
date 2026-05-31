import assert from "node:assert/strict";
import test from "node:test";
import { mouseWheelDirection, resizeJiggleSize, scrollViewportTop } from "../src/core/pty-scroll.mjs";

test("mouseWheelDirection decodes SGR and X10 wheel events", () => {
	assert.equal(mouseWheelDirection("\x1b[<64;10;20M"), 1);
	assert.equal(mouseWheelDirection("\x1b[<65;10;20M"), -1);
	assert.equal(mouseWheelDirection("\x1b[<66;10;20M"), 0);
	assert.equal(mouseWheelDirection("\x1b[M`!!"), 1);
	assert.equal(mouseWheelDirection("\x1b[Ma!!"), -1);
	assert.equal(mouseWheelDirection("x"), 0);
});

test("scrollViewportTop reports unconsumed scroll when no local scrollback can move", () => {
	assert.deepEqual(scrollViewportTop(null, 0, 5), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(null, 20, -5), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(0, 20, 5), { viewportTop: 0, changed: false });
});

test("scrollViewportTop consumes gestures that move local scrollback", () => {
	assert.deepEqual(scrollViewportTop(null, 20, 5), { viewportTop: 15, changed: true });
	assert.deepEqual(scrollViewportTop(15, 20, -5), { viewportTop: null, changed: true });
	assert.deepEqual(scrollViewportTop(15, 20, 20), { viewportTop: 0, changed: true });
});

test("resizeJiggleSize chooses a safe temporary size to force child redraw", () => {
	assert.deepEqual(resizeJiggleSize(120, 34), { cols: 119, rows: 33 });
	assert.deepEqual(resizeJiggleSize(20, 34), { cols: 20, rows: 33 });
	assert.deepEqual(resizeJiggleSize(120, 6), { cols: 119, rows: 6 });
	assert.equal(resizeJiggleSize(20, 6), null);
});
