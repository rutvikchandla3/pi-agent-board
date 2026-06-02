import assert from "node:assert/strict";
import test from "node:test";
import { mouseWheelDirection, parseMouseEvent, parseMouseInputChunk, resizeJiggleSize, scrollViewportTop } from "../src/core/pty-scroll.mjs";

test("mouseWheelDirection decodes standard/passive SGR and X10 wheel events", () => {
	assert.equal(mouseWheelDirection("\x1b[<64;10;20M"), 1);
	assert.equal(mouseWheelDirection("\x1b[<65;10;20M"), -1);
	assert.equal(mouseWheelDirection("\x1b[?64;10;20M"), 1);
	assert.equal(mouseWheelDirection("\x1b[?65;10;20M"), -1);
	assert.equal(mouseWheelDirection("\x1b[<66;10;20M"), 0);
	assert.equal(mouseWheelDirection("\x1b[M`!!"), 1);
	assert.equal(mouseWheelDirection("\x1b[Ma!!"), -1);
	assert.equal(mouseWheelDirection("x"), 0);
});

test("parseMouseEvent decodes press, drag, and release events", () => {
	assert.deepEqual(parseMouseEvent("\x1b[<0;10;20M"), {
		encoding: "sgr",
		button: 0,
		col: 10,
		row: 20,
		action: "press",
	});
	assert.deepEqual(parseMouseEvent("\x1b[<32;11;20M"), {
		encoding: "sgr",
		button: 32,
		col: 11,
		row: 20,
		action: "move",
	});
	assert.deepEqual(parseMouseEvent("\x1b[<0;11;20m"), {
		encoding: "sgr",
		button: 0,
		col: 11,
		row: 20,
		action: "release",
	});
	assert.deepEqual(parseMouseEvent("\x1b[?32;7;8M"), {
		encoding: "passive",
		button: 32,
		col: 7,
		row: 8,
		action: "move",
	});
	assert.deepEqual(parseMouseEvent("\x1b[M !!"), {
		encoding: "x10",
		button: 0,
		col: 1,
		row: 1,
		action: "press",
	});
	assert.equal(parseMouseEvent("x"), null);
});

test("parseMouseInputChunk decodes concatenated mouse reports and rejects mixed input", () => {
	assert.deepEqual(parseMouseInputChunk("\x1b[<64;10;20M\x1b[<65;10;20M"), [
		{
			length: "\x1b[<64;10;20M".length,
			raw: "\x1b[<64;10;20M",
			mouse: { encoding: "sgr", button: 64, col: 10, row: 20, action: "press" },
		},
		{
			length: "\x1b[<65;10;20M".length,
			raw: "\x1b[<65;10;20M",
			mouse: { encoding: "sgr", button: 65, col: 10, row: 20, action: "press" },
		},
	]);
	assert.equal(parseMouseInputChunk("\x1b[<64;10;20Mx"), null);
	assert.equal(parseMouseInputChunk("x\x1b[<64;10;20M"), null);
	assert.equal(parseMouseInputChunk(""), null);
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
