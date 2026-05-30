import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assistantText,
	baseName,
	detectNeedsInput,
	firstSentence,
	relativeTime,
	toolPath,
	toolSummary,
	truncate,
} from "../src/core/heuristics.mjs";

test("assistantText joins text blocks, ignores tool calls", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello." },
			{ type: "toolCall", name: "edit", arguments: {} },
			{ type: "text", text: "World." },
		],
	};
	assert.equal(assistantText(msg), "Hello.\nWorld.");
	assert.equal(assistantText({ content: "raw string" }), "raw string");
	assert.equal(assistantText(null), "");
});

test("detectNeedsInput: trailing question mark", () => {
	const r = detectNeedsInput("I did the thing. Which approach do you prefer?");
	assert.equal(r.needsInput, true);
	assert.match(r.question, /Which approach/);
});

test("detectNeedsInput: phrase trigger without question mark", () => {
	const r = detectNeedsInput("Please confirm before I delete the table.");
	assert.equal(r.needsInput, true);
	assert.match(r.question, /confirm/i);
});

test("detectNeedsInput: plain statement is not a blocker", () => {
	const r = detectNeedsInput("Done. All tests pass.");
	assert.equal(r.needsInput, false);
	assert.equal(r.question, null);
});

test("firstSentence", () => {
	assert.equal(firstSentence("First one. Second one."), "First one.");
	assert.equal(firstSentence(""), "");
});

test("toolSummary covers common tools", () => {
	assert.equal(toolSummary("edit", { file_path: "/a/b/src/auth.ts" }), "Editing auth.ts");
	assert.equal(toolSummary("bash", { command: "npm test" }), "Running tests");
	assert.equal(toolSummary("bash", { command: "tsc -p ." }), "Building");
	assert.equal(toolSummary("grep", { pattern: "TODO" }), "Searching /TODO/");
	assert.equal(toolSummary("read", {}), "Reading files");
});

test("toolPath prefers file_path/path then pattern", () => {
	assert.equal(toolPath({ file_path: "x" }), "x");
	assert.equal(toolPath({ path: "y" }), "y");
	assert.equal(toolPath({ pattern: "z" }), "z");
	assert.equal(toolPath({}), null);
});

test("baseName", () => {
	assert.equal(baseName("/a/b/c.ts"), "c.ts");
	assert.equal(baseName("c.ts"), "c.ts");
});

test("truncate adds ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
});

test("relativeTime buckets", () => {
	const now = 1_000_000_000_000;
	assert.equal(relativeTime(now - 5_000, now), "5s");
	assert.equal(relativeTime(now - 120_000, now), "2m");
	assert.equal(relativeTime(now - 3 * 3600_000, now), "3h");
	assert.equal(relativeTime(now - 2 * 86400_000, now), "2d");
});
