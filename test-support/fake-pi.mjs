#!/usr/bin/env node
/**
 * Fake `pi` worker for hermetic tests. Emulates `pi --mode json -p --session <file> <prompt>`:
 * emits a realistic JSON event stream to stdout and (optionally) persists a session file,
 * without any model/network/TTY. Behavior is controlled by $FAKE_PI_MODE:
 *   completed (default) | needs_input | fail | slow | hang
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

function arg(flag) {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionFile = arg("--session");
const prompt = process.argv[process.argv.length - 1];
const mode = process.env.FAKE_PI_MODE || "completed";
const cwd = process.cwd();

function emit(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function persistSession() {
	if (!sessionFile || process.env.FAKE_PI_NO_SESSION === "1") return;
	try {
		mkdirSync(path.dirname(sessionFile), { recursive: true });
		const header = {
			type: "session",
			version: 3,
			id: `fake-${Math.abs(hash(sessionFile)) % 1e8}`,
			timestamp: new Date(0).toISOString(),
			cwd,
		};
		const userEntry = {
			type: "message",
			id: "u0000001",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: prompt },
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`);
	} catch {
		/* ignore */
	}
}

function hash(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

async function main() {
	persistSession();

	// Header (first line in real json mode is the session header).
	emit({ type: "session", version: 3, id: "fake-header", timestamp: new Date(0).toISOString(), cwd });

	if (mode === "hang") {
		// Emit a start then sleep forever, so the parent can test stop/kill.
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
		emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 999" } });
		await sleep(600000);
		return;
	}

	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	if (mode === "slow") await sleep(150);
	emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { file_path: "src/auth/middleware.ts" } });
	if (mode === "slow") await sleep(150);
	emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "edit", result: { ok: true }, isError: false });
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			model: "fake/model",
			stopReason: "toolUse",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
			content: [
				{ type: "text", text: "Editing the auth middleware to fix the token expiry check." },
				{ type: "toolCall", id: "t1", name: "edit", arguments: { file_path: "src/auth/middleware.ts" } },
			],
		},
	});

	if (mode === "fail") {
		process.stderr.write("fake-pi: simulated failure\n");
		emit({
			type: "message_end",
			message: { role: "assistant", model: "fake/model", stopReason: "error", errorMessage: "Provider exploded", content: [] },
		});
		process.exit(1);
	}

	const finalText =
		mode === "needs_input"
			? "I updated the middleware. Which token expiry policy should I use, sliding or absolute?"
			: "Done. Fixed the token expiry check in auth middleware and the tests pass.";

	emit({ type: "turn_start" });
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			model: "fake/model",
			stopReason: "stop",
			usage: { input: 20, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 32, cost: { total: 0 } },
			content: [{ type: "text", text: finalText }],
		},
	});

	if (sessionFile && process.env.FAKE_PI_NO_SESSION !== "1") {
		try {
			appendFileSync(
				sessionFile,
				`${JSON.stringify({ type: "message", id: "a0000001", parentId: "u0000001", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: finalText }], model: "fake/model", stopReason: "stop" } })}\n`,
			);
		} catch {
			/* ignore */
		}
	}

	emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] }, toolResults: [] });
	emit({ type: "agent_end", messages: [] });
}

main();
