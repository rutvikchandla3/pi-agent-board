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
import { fileURLToPath } from "node:url";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import { createRunStatus, finalizeRun, projectViewState, reduceEvent } from "../src/core/events.mjs";
import { encodePromptForCliArg } from "../src/core/prompt-transport.mjs";
import { applyAutoStateToStatus, autoStateEnabled, autoStateFromModelOrHeuristic, autoStateModel, buildAutoStatePrompt, heuristicAutoState } from "../src/core/auto-state.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { emptyEvidenceSnapshot, finalizeEvidence, reduceEvidence, summarizeEvidence, writeEvidence, writeRunEvidence } from "../src/core/evidence.mjs";
import { claimNextFollowUp, completeFollowUp, releaseFollowUp } from "../src/core/follow-up-queue.mjs";
import { newRunId } from "../src/core/ids.mjs";
import { launchRun } from "../src/core/launch.mjs";
import * as P from "../src/core/paths.mjs";
import { readState, writeState, writeStatus } from "../src/core/store.mjs";
import { readSteering, recordPlanReady } from "../src/core/steering.mjs";
import { buildApprovePlanPrompt, buildPlanChangesPrompt, buildPlanRequestPrompt } from "../src/core/steering-prompts.mjs";

const WRITE_THROTTLE_MS = 250;

/** @param {string[]} args */
function redactWorkerArgs(args) {
	return args.map((arg, idx) => {
		const prev = args[idx - 1];
		if (["--api-key", "--token", "--password", "--secret"].includes(prev)) return "[redacted]";
		if (/^(sk-|gho_|ghp_)/.test(arg)) return "[redacted]";
		return arg;
	});
}

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
	let evidence = emptyEvidenceSnapshot({ viewId, runId, source: "json-runner" });
	appendDiagnostic(root, viewId, { source: "runner", runId, code: "runner_start", message: "Runner started", details: { kind: config.kind, cwd: config.cwd, model: config.model } });
	writeStatus(root, status);
	writeRunEvidence(root, evidence);
	writeEvidence(root, evidence);
	writeState(root, projectViewState(status, Date.now(), readState(root, viewId)));

	// Build worker args: pi --mode json -p --session <file> [--model m] [--thinking l] [--tools t] <prompt>
	const args = [
		...config.piArgsPrefix,
		"--mode",
		"json",
		"-p",
		"--session",
		config.sessionFile,
	];
	if (config.model) args.push("--model", config.model);
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	if (config.tools) args.push("--tools", config.tools);
	args.push(encodePromptForCliArg(config.prompt));

	appendDiagnostic(root, viewId, { source: "runner", runId, code: "worker_spawn", message: "Worker spawned", details: { command: config.piCommand, args: redactWorkerArgs(args) } });
	const worker = spawn(config.piCommand, args, {
		cwd: config.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});

	status.pid = worker.pid ?? null;
	appendDiagnostic(root, viewId, { source: "runner", runId, code: "worker_pid", message: "Worker pid recorded", details: { pid: status.pid } });
	writeStatus(root, status);

	let stoppedByUser = false;
	let dirty = false;
	let flushTimer = null;

	const persist = (force = false) => {
		void force;
		const now = Date.now();
		status.evidenceSummary = summarizeEvidence(evidence);
		writeStatus(root, status);
		writeRunEvidence(root, evidence);
		writeEvidence(root, evidence);
		writeState(root, projectViewState(status, now, readState(root, viewId)));
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
			appendDiagnostic(root, viewId, { source: "runner", runId, level: "warn", code: "malformed_event", message: "Worker emitted malformed JSON", details: { preview: trimmed.slice(0, 160) } });
			return;
		}
		// First line is the session header {type:"session",...}; nothing to reduce.
		if (event?.type === "session") return;
		const now = Date.now();
		const statusChanged = reduceEvent(status, event, now);
		const evidenceChanged = reduceEvidence(evidence, event, now);
		if (statusChanged || evidenceChanged) scheduleFlush();
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
		const text = chunk.toString();
		appendLine(stderrLog, text.replace(/\n$/, ""));
		appendDiagnostic(root, viewId, { source: "runner", runId, level: "warn", code: "worker_stderr", message: "Worker wrote to stderr", details: { preview: text.slice(0, 300) } });
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
		appendDiagnostic(root, viewId, { source: "runner", runId, level: "error", code: "worker_error", message: status.error, details: {} });
		finalizeRun(status, { exitCode: 1, stoppedByUser }, Date.now());
		finalizeEvidence(evidence, status, Date.now());
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
		finalizeEvidence(evidence, status, Date.now());
		appendDiagnostic(root, viewId, { source: "runner", runId, level: code ? "error" : "info", code: "worker_exit", message: `Worker exited with code ${code ?? 0}`, details: { code, stoppedByUser } });
		// Persist the terminal state (with the heuristic summary) IMMEDIATELY so the
		// dashboard flips to its final state at once. Then try to classify the final
		// bucket and upgrade the summary with cheap model passes. Slow/unreachable
		// model calls must never stall the row indefinitely.
		persist(true);
		if (applyHeuristicAutoState(config, status, evidence)) {
			finalizeEvidence(evidence, status, Date.now());
			status.evidenceSummary = summarizeEvidence(evidence);
			persist(true);
		}
		maybeModelAutoState(config, status, evidence)
			.then((changed) => {
				if (changed) {
					finalizeEvidence(evidence, status, Date.now());
					status.evidenceSummary = summarizeEvidence(evidence);
					persist(true);
				}
				return maybeModelSummary(config, status);
			})
			.then((changed) => {
				if (changed) persist(true);
			})
			.catch(() => {})
			.finally(() => {
				finalizeSteeringIfNeeded(config, status, evidence);
				drainQueuedFollowUp(config, status);
				process.exit(stoppedByUser ? 0 : (code ?? 0));
			});
	});
}

/** @param {import("../src/core/types.mjs").RunConfig} config @param {import("../src/core/types.mjs").RunStatus} status @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
function finalizeSteeringIfNeeded(config, status, evidence) {
	if (config.kind !== "plan" && config.kind !== "plan_change") return;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return;
	recordPlanReady(config.root, config.viewId, {
		runId: config.runId,
		planText: latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "Plan ready",
	});
	const prev = readState(config.root, config.viewId);
	if (prev) {
		prev.semanticState = "needs_input";
		prev.processState = "exited";
		prev.needsInput = true;
		prev.question = "Approve this plan?";
		prev.summary = "Plan ready for approval";
		prev.currentRunId = config.runId;
		prev.updatedAt = Date.now();
		writeState(config.root, prev);
	}
}

/** @param {import("../src/core/types.mjs").RunConfig} config @param {import("../src/core/types.mjs").RunStatus} status */
function drainQueuedFollowUp(config, status) {
	if (status.semanticState !== "idle" && status.semanticState !== "completed") return;
	if (config.kind === "plan" || config.kind === "plan_change") return;
	const claimed = claimNextFollowUp(config.root, config.viewId);
	if (!claimed.ok || !claimed.item) return;
	const item = claimed.item;
	const nextRunId = newRunId();
	const nextConfig = {
		...config,
		runId: nextRunId,
		kind: runKindForFollowUp(item),
		prompt: promptForFollowUp(config.root, config.viewId, item),
	};
	try {
		const { pid } = launchRun(config.root, nextConfig, { runnerScript: fileURLToPath(import.meta.url) });
		const nextStatus = createRunStatus(nextConfig, pid ?? null, Date.now());
		writeStatus(config.root, nextStatus);
		writeState(config.root, projectViewState(nextStatus, Date.now(), readState(config.root, config.viewId)));
		completeFollowUp(config.root, config.viewId, item.id, { runId: nextRunId });
		appendDiagnostic(config.root, config.viewId, { source: "queue", runId: nextRunId, code: "follow_up_started", message: "Queued follow-up started by JSON runner", details: { kind: item.kind } });
	} catch (err) {
		releaseFollowUp(config.root, config.viewId, item.id);
		appendDiagnostic(config.root, config.viewId, { source: "queue", level: "error", code: "follow_up_drain_failed", message: "JSON runner could not start queued follow-up", details: { error: err instanceof Error ? err.message : String(err) } });
	}
}

/** @param {import("../src/core/types.mjs").FollowUpItem} item */
function runKindForFollowUp(item) {
	switch (item.kind) {
		case "plan_request":
			return "plan";
		case "plan_change":
			return "plan_change";
		case "plan_approval":
			return "plan_approval";
		default:
			return "reply";
	}
}

/** @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

/** @param {string} root @param {string} viewId @param {import("../src/core/types.mjs").FollowUpItem} item */
function promptForFollowUp(root, viewId, item) {
	const steering = readSteering(root, viewId);
	switch (item.kind) {
		case "plan_request":
			return buildPlanRequestPrompt(item.text);
		case "plan_change":
			return buildPlanChangesPrompt(steering.planText, item.text);
		case "plan_approval":
			return buildApprovePlanPrompt(steering.planText);
		default:
			return item.text;
	}
}

function canAutoState(config, status, evidence) {
	if (!autoStateEnabled()) return false;
	if (config.kind === "plan" || config.kind === "plan_change") return false;
	if (status.semanticState === "failed" || status.semanticState === "stopped" || status.processState === "alive") return false;
	return Boolean((latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "").trim());
}

function applyHeuristicAutoState(config, status, evidence) {
	if (!canAutoState(config, status, evidence)) return false;
	const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
	const classification = heuristicAutoState(latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null });
	const changed = applyAutoStateToStatus(status, classification, Date.now());
	if (changed) {
		appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier updated terminal state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
	}
	return changed;
}

async function maybeModelAutoState(config, status, evidence) {
	if (!canAutoState(config, status, evidence)) return false;
	const model = autoStateModel();
	if (!model) return false;
	const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
	const prompt = buildAutoStatePrompt(latest);
	const out = await runOneShot(
		config.piCommand,
		[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
		15000,
	);
	const classification = autoStateFromModelOrHeuristic(out, latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null });
	const changed = applyAutoStateToStatus(status, classification, Date.now());
	if (changed) {
		appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier refined terminal state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
	}
	return changed;
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
