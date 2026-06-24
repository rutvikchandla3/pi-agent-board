import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePromptForCliArg } from "../src/core/prompt-transport.mjs";

test("encodePromptForCliArg protects leading dash prompts", () => {
	assert.equal(encodePromptForCliArg("- Create a ticket"), " - Create a ticket");
	assert.equal(encodePromptForCliArg("normal prompt"), "normal prompt");
});
