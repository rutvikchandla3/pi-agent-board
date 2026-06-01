import assert from "node:assert/strict";
import { test } from "node:test";
import { isProbablyEmptyPiInputLine } from "../src/core/pty-input.mjs";

test("isProbablyEmptyPiInputLine accepts empty Pi prompt lines", () => {
	assert.equal(isProbablyEmptyPiInputLine("› "), true);
	assert.equal(isProbablyEmptyPiInputLine("  ┃   "), true);
	assert.equal(isProbablyEmptyPiInputLine("  │   "), true);
});

test("isProbablyEmptyPiInputLine rejects prompt lines containing draft text", () => {
	assert.equal(isProbablyEmptyPiInputLine("› hello"), false);
	assert.equal(isProbablyEmptyPiInputLine("  ┃ edit me"), false);
	assert.equal(isProbablyEmptyPiInputLine("  │ second line"), false);
});
