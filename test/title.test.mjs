import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGeneratedTitle, titlePrompt } from "../src/core/title.mjs";

test("titlePrompt asks for a 3-4 word plain-text title", () => {
	const prompt = titlePrompt("fix websocket reconnect bug");
	assert.match(prompt, /3 or 4 words max/i);
	assert.match(prompt, /plain text only/i);
	assert.match(prompt, /fix websocket reconnect bug/i);
});

test("normalizeGeneratedTitle strips wrappers and limits to four words", () => {
	assert.equal(normalizeGeneratedTitle('"Fix Websocket Reconnect Flow Now"', "fallback"), "Fix Websocket Reconnect Flow");
});

test("normalizeGeneratedTitle falls back when blank", () => {
	assert.equal(normalizeGeneratedTitle("   ", "fallback-name"), "fallback-name");
});
