#!/usr/bin/env node
/**
 * Detached job-runner shim (plain ESM — must not depend on Pi's jiti loader).
 *
 * Usage: node job-runner.mjs <configPath>
 *
 * Owns one run: spawns a headless Pi worker (`pi --mode json -p --session <file> <prompt>`),
 * streams its JSON events into events.jsonl, reduces them into status.json + the row's
 * state.json, and finalizes on exit. Survives the parent Pi process exiting/reloading.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import { createRunStatus, finalizeRun, projectViewState, reduceEvent } from "../src/core/events.mjs";
import * as P from "../src/core/paths.mjs";
import { writeState, writeStatus } from "../src/core/store.mjs";

const WRITE_THROTTLE_MS = 250;

function main() {
	const configPath = process.argv[2];
	if (!configPath) {
		process.stderr.write("job-runner: missing config path\n");
		process.exit(2);
	}
	/** @type {import("../src/core/types.mjs").RunConfig|null} */
	const config = readJson(configPath, null);
	if (!config) {
		process.stderr.write(`job-runner: cannot read config ${configPath}\n`);
		process.exit(2);
	}

	const { root, viewId, runId } = config;
	const stdoutLog = P.stdoutPath(root, viewId, runId);
	const stderrLog = P.stderrPath(root, viewId, runId);
	const eventsLog = P.eventsPath(root, viewId, runId);

	let status = createRunStatus(config, null, Date.now());
	writeStatus(root, status);
	writeState(root, projectViewState(status, Date.now()));

	// Build worker args: pi --mode json -p --session <file> [--model m] [--tools t] <prompt>
	const args = [
		...config.piArgsPrefix,
		"--mode",
		"json",
		"-p",
		"--session",
		config.sessionFile,
	];
	if (config.model) args.push("--model", config.model);
	if (config.tools) args.push("--tools", config.tools);
	args.push(config.prompt);

	const worker = spawn(config.piCommand, args, {
		cwd: config.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});

	status.pid = worker.pid ?? null;
	writeStatus(root, status);

	let stoppedByUser = false;
	let dirty = false;
	let flushTimer = null;

	const persist = (force = false) => {
		const now = Date.now();
		writeStatus(root, status);
		writeState(root, projectViewState(status, now));
		dirty = false;
	};

	const scheduleFlush = () => {
		if (flushTimer) {
			dirty = true;
			return;
		}
		persist();
		flushTimer = setTimeout(() => {
			flushTimer = null;
			if (dirty) scheduleFlush();
		}, WRITE_THROTTLE_MS);
	};

	// ---- stdout: JSON event stream -----------------------------------------
	let buffer = "";
	const onLine = (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		appendLine(eventsLog, trimmed);
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return;
		}
		// First line is the session header {type:"session",...}; nothing to reduce.
		if (event?.type === "session") return;
		if (reduceEvent(status, event, Date.now())) scheduleFlush();
	};

	worker.stdout.on("data", (chunk) => {
		const text = chunk.toString();
		try {
			appendLine(stdoutLog, text.replace(/\n$/, ""));
		} catch {
			/* ignore raw-log failures */
		}
		buffer += text;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});

	worker.stderr.on("data", (chunk) => {
		appendLine(stderrLog, chunk.toString().replace(/\n$/, ""));
	});

	// ---- termination handling ----------------------------------------------
	const stop = () => {
		stoppedByUser = true;
		try {
			if (worker.pid && !worker.killed) worker.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (worker.pid && !worker.killed) worker.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 4000).unref?.();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);

	worker.on("error", (err) => {
		status.error = `Failed to launch worker: ${err instanceof Error ? err.message : String(err)}`;
		finalizeRun(status, { exitCode: 1, stoppedByUser }, Date.now());
		persist(true);
		process.exit(1);
	});

	worker.on("close", (code) => {
		if (buffer.trim()) onLine(buffer);
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		finalizeRun(status, { exitCode: code ?? 0, stoppedByUser }, Date.now());
		// Persist the terminal state (with the heuristic summary) IMMEDIATELY so the
		// dashboard flips to its final state at once. Then try to upgrade the summary with
		// a cheap model and re-persist — a slow/unreachable summarizer can't stall the row.
		persist(true);
		maybeModelSummary(config, status)
			.then((changed) => {
				if (changed) persist(true);
			})
			.catch(() => {})
			.finally(() => {
				process.exit(stoppedByUser ? 0 : (code ?? 0));
			});
	});
}

/** Default cheap model for terminal summaries. Override/disable via $AGENT_BOARD_SUMMARY_MODEL. */
const DEFAULT_SUMMARY_MODEL = "gpt-4o";

/**
 * Cheap-model summary, ON BY DEFAULT (uses {@link DEFAULT_SUMMARY_MODEL}; override with
 * $AGENT_BOARD_SUMMARY_MODEL=<model>, disable with $AGENT_BOARD_SUMMARY_MODEL=off). Overrides
 * status.summary with a short model-generated line. On any failure (no API key, model
 * unavailable, timeout) it silently keeps the heuristic summary already in status.summary.
 * @param {import("../src/core/types.mjs").RunConfig} config
 * @param {import("../src/core/types.mjs").RunStatus} status
 * @returns {Promise<boolean>} whether the summary was upgraded.
 */
async function maybeModelSummary(config, status) {
	const configured = process.env.AGENT_BOARD_SUMMARY_MODEL ?? process.env.AGENT_VIEW_SUMMARY_MODEL;
	if (configured === "off") return false;
	const model = configured || DEFAULT_SUMMARY_MODEL;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return false;
	const source = status.latestAssistantPreview || status.summary;
	if (!source) return false;
	const prompt = `In 8 words or fewer, summarize what this coding agent just did. No quotes.\n\n${source}`;
	const out = await runOneShot(
		config.piCommand,
		[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
		15000,
	);
	const text = out.trim().split("\n").slice(-1)[0]?.trim();
	if (text) {
		status.summary = text.replace(/^["']|["']$/g, "").slice(0, 80);
		return true;
	}
	return false;
}

/**
 * Run a pi one-shot and return the concatenated assistant text from message_end events.
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function runOneShot(command, args, timeoutMs = 20000) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
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
		// Safety timeout so a hung summarizer never blocks finalization forever.
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
