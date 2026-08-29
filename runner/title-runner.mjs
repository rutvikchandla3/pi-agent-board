#!/usr/bin/env node
/**
 * Detached title-runner shim.
 *
 * Best-effort only: generates a short GPT-4o title from the initial task prompt and updates
 * the row's meta name if the user has not already renamed it.
 */
import { spawn } from "node:child_process";
import { readJson } from "../src/core/atomic.mjs";
import { readMeta, writeMeta } from "../src/core/store.mjs";
import { DEFAULT_TITLE_MODEL, DEFAULT_TITLE_THINKING_LEVEL, normalizeGeneratedTitle, titlePrompt } from "../src/core/title.mjs";

function main() {
	const configPath = process.argv[2];
	if (!configPath) process.exit(2);
	/** @type {import("../src/core/types.mjs").TitleConfig|null} */
	const config = readJson(configPath, null);
	if (!config?.viewId || !config.prompt) process.exit(2);

	maybeGenerateTitle(config)
		.catch(() => {})
		.finally(() => process.exit(0));
}

async function maybeGenerateTitle(config) {
	const configured = process.env.AGENT_BOARD_TITLE_MODEL ?? process.env.AGENT_VIEW_TITLE_MODEL;
	if (configured === "off") return;
	const model = config.model ?? configured ?? DEFAULT_TITLE_MODEL;
	const thinking = process.env.AGENT_BOARD_TITLE_THINKING_LEVEL ?? process.env.AGENT_VIEW_TITLE_THINKING_LEVEL ?? DEFAULT_TITLE_THINKING_LEVEL;
	const prompt = titlePrompt(config.prompt);
	const args = [...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model];
	if (thinking && thinking !== "off") args.push("--thinking", thinking);
	args.push(prompt);
	const out = await runOneShot(config.piCommand, args, 15000);
	const title = normalizeGeneratedTitle(out.trim().split("\n").slice(-1)[0]?.trim(), config.fallbackName);
	if (!title || title === config.fallbackName) return;

	const meta = readMeta(config.root, config.viewId);
	if (!meta) return;
	if (meta.name !== config.fallbackName) return;
	meta.name = title;
	writeMeta(config.root, meta);
}

function runOneShot(command, args, timeoutMs = 20000) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let buf = "";
		child.stdout.on("data", (c) => {
			buf += c.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e?.type === "message_end" && e.message?.role === "assistant") {
						for (const b of e.message.content ?? []) {
							if (b.type === "text") out += b.text;
						}
					}
				} catch {
					/* ignore */
				}
			}
		});
		child.on("close", () => resolve(out));
		child.on("error", () => resolve(""));
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			resolve(out);
		}, timeoutMs).unref?.();
	});
}

main();
