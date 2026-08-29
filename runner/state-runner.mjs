#!/usr/bin/env node
/**
 * Detached auto-state classifier.
 *
 * Reads the latest assistant turn from evidence/state, asks a cheap model to classify
 * the terminal bucket, and updates state.json (and status.json when a run id exists).
 * Safe best-effort: on model failure it falls back to the same heuristic classifier.
 */
import { spawn } from "node:child_process";
import { readJson } from "../src/core/atomic.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { applyAutoStateToStatus, applyAutoStateToViewState, autoStateEnabled, autoStateFromModelOrHeuristic, autoStateModel, buildAutoStatePrompt, heuristicAutoState } from "../src/core/auto-state.mjs";
import { finalizeEvidence, readEvidence, summarizeEvidence, writeEvidence } from "../src/core/evidence.mjs";
import { readState, readStatus, writeState, writeStatus } from "../src/core/store.mjs";

async function main() {
	const configPath = process.argv[2];
	if (!configPath) process.exit(2);
	/** @type {import("../src/core/types.mjs").AutoStateConfig|null} */
	const config = readJson(configPath, null);
	if (!config || !autoStateEnabled()) process.exit(0);

	const state = readState(config.root, config.viewId);
	if (!state || state.processState === "alive" || state.semanticState === "failed" || state.semanticState === "stopped") process.exit(0);

	const evidence = readEvidence(config.root, config.viewId);
	const latest = latestEvidenceText(evidence) || state.latestAssistantPreview || state.summary || "";
	if (!latest.trim()) process.exit(0);

	if (state.autoState?.source === "model" && state.autoState.textHash === heuristicAutoState(latest).textHash) process.exit(0);

	const model = autoStateModel();
	let classification = heuristicAutoState(latest, { lastAgentActivityAt: state.lastAgentActivityAt ?? null });
	if (model) {
		const prompt = buildAutoStatePrompt(latest);
		const out = await runOneShot(
			config.piCommand,
			[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
			{ timeoutMs: 15000, cwd: config.cwd, env: sanitizedEnv() },
		);
		classification = autoStateFromModelOrHeuristic(out, latest, { lastAgentActivityAt: state.lastAgentActivityAt ?? null });
	}

	let changed = false;
	if (config.runId) {
		const status = readStatus(config.root, config.viewId, config.runId);
		if (status) {
			changed = applyAutoStateToStatus(status, classification, Date.now()) || changed;
			status.evidenceSummary = summarizeEvidence(finalizeEvidence(evidence, status, Date.now()));
			writeStatus(config.root, status);
		}
	}
	const latestState = readState(config.root, config.viewId) ?? state;
	changed = applyAutoStateToViewState(latestState, classification, Date.now()) || changed;
	finalizeEvidence(evidence, { semanticState: latestState.semanticState, usage: null }, Date.now());
	latestState.review = summarizeEvidence(evidence);
	writeEvidence(config.root, evidence);
	writeState(config.root, latestState);
	if (changed) {
		appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier updated row state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
	}
}

/** @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

function sanitizedEnv() {
	const env = { ...process.env };
	delete env.AGENT_BOARD_CHILD;
	delete env.AGENT_VIEW_CHILD;
	delete env.AGENT_BOARD_VIEW_ID;
	delete env.AGENT_VIEW_VIEW_ID;
	delete env.AGENT_BOARD_HOSTED;
	delete env.AGENT_VIEW_HOSTED;
	return env;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function runOneShot(command, args, opts = {}) {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let buf = "";
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(out);
		};
		child.stdout.on("data", (c) => {
			buf += c.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e?.type === "message_end" && e.message?.role === "assistant") {
						for (const b of e.message.content ?? []) if (b.type === "text") out += b.text;
					}
				} catch {
					/* ignore */
				}
			}
		});
		child.on("close", finish);
		child.on("error", finish);
		setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			finish();
		}, opts.timeoutMs ?? 20000).unref?.();
	});
}

main().catch(() => process.exit(0));
