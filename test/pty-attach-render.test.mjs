import assert from "node:assert/strict";
import test from "node:test";
import {
	createAttachOutputRenderScheduler,
	nextAttachRender,
	shouldScheduleAttachRenderForMessage,
} from "../src/core/pty-attach-render.mjs";

test("nextAttachRender forces exactly the first attach paint by default", () => {
	assert.deepEqual(nextAttachRender(true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(false), { force: false, firstPaint: false });
});

test("nextAttachRender preserves explicit hard resets after first paint", () => {
	assert.deepEqual(nextAttachRender(false, true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(true, true), { force: true, firstPaint: false });
});

test("shouldScheduleAttachRenderForMessage skips immediate repaint for PTY output", () => {
	assert.equal(shouldScheduleAttachRenderForMessage("output"), false);
	assert.equal(shouldScheduleAttachRenderForMessage("hello"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("status"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("error"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("exit"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("unknown"), false);
});

test("attach output scheduler coalesces parser callback bursts", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	for (let i = 0; i < 20; i++) scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 1);

	scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 2);
	scheduler.dispose();
});

test("attach output scheduler cancels a pending repaint when disposed", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	scheduler.request();
	scheduler.dispose();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 0);
});
