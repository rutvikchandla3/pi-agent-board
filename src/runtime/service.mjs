/**
 * AgentViewService — the imperative actions behind the dashboard: dispatch a new
 * background session, reply/resume, stop, pin/rename/archive, and the same-repo write
 * safety rule. Pure node + core modules; the Pi-coupled bits (attach, dialogs) live in
 * the command handler. The pi invocation + runner path are injected (resolved in index.ts).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { applyAutoStateToStatus, autoStateEnabled, heuristicAutoState } from "../core/auto-state.mjs";
import { finalizeRun, projectViewState, reduceEvent } from "../core/events.mjs";
import { clearDiagnostics, appendDiagnostic, tailDiagnostics } from "../core/diagnostics.mjs";
import { emptyEvidenceSnapshot, finalizeEvidence, readEvidence, reduceEvidence, summarizeEvidence, writeEvidence } from "../core/evidence.mjs";
import { claimNextFollowUp, completeFollowUp, enqueueFollowUp, readFollowUpQueue, releaseFollowUp, summarizeFollowUpQueue, clearQueuedFollowUps, removeLastFollowUp } from "../core/follow-up-queue.mjs";
import { approvePlan as approvePlanState, markExecutingApprovedPlan, readSteering, recordPlanReady, requestPlan as requestPlanState, requestPlanChanges as requestPlanChangesState, summarizeSteering } from "../core/steering.mjs";
import { buildApprovePlanPrompt, buildPlanChangesPrompt, buildPlanRequestPrompt } from "../core/steering-prompts.mjs";
import { isGenericStatusText } from "../core/derive.mjs";
import { firstSentence, truncate } from "../core/heuristics.mjs";
import { newRunId, newViewId, slugifyTask } from "../core/ids.mjs";
import { launchAutoState as launchAutoStateProcess, launchHost as launchHostProcess, launchRun, launchTitle as launchTitleProcess } from "../core/launch.mjs";
import { gitRepoRoot } from "../core/repo.mjs";
import { killProcess } from "../core/pid.mjs";
import * as P from "../core/paths.mjs";
import {
	createView,
	listRows,
	loadRow,
	readLaunchPrefs,
	readPid,
	readState,
	readStatus,
	writeHost,
	writeHostPid,
	writeLaunchPrefs,
	writeMeta,
	writeState,
} from "../core/store.mjs";
import { diagnoseNodePtyFailure, ensureNodePtySpawnHelperExecutable, nodePtyFallbackMessage, probeNodePtyEnvironment } from "../core/pty-support.mjs";

/** @typedef {import("../core/types.mjs").RunKind} RunKind */

/**
 * @param {{
 *   root: string,
 *   runnerScript: string,
 *   ptyRunnerScript?: string,
 *   piCommand: string,
 *   piArgsPrefix: string[],
 *   defaultCwd: string,
 *   titleRunnerScript?: string,
 *   autoStateRunnerScript?: string,
 *   launch?: typeof launchRun,
 *   launchHost?: typeof launchHostProcess,
 *   launchTitle?: typeof launchTitleProcess,
 *   launchAutoState?: typeof launchAutoStateProcess,
 *   ptySupport?: (opts?: { refresh?: boolean, maxAgeMs?: number }) => { ok: boolean, reason?: string|null, issue?: any },
 * }} opts
 */
export function createService(opts) {
	const root = opts.root;
	const launch = opts.launch ?? launchRun;
	const launchHostImpl = opts.launchHost ?? launchHostProcess;
	const launchTitleImpl = opts.launchTitle ?? launchTitleProcess;
	const launchAutoStateImpl = opts.launchAutoState ?? launchAutoStateProcess;
	const ptySupport = opts.ptySupport ?? ptyHostAvailability;
	const ptyRunnerScript = opts.ptyRunnerScript ?? opts.runnerScript;
	const titleRunnerScript = opts.titleRunnerScript ?? null;

	/**
	 * Launch a run (dispatch or reply) against an existing view, updating its state to queued.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string} prompt
	 * @param {RunKind} kind
	 * @returns {{ runId: string, pid: number|null }}
	 */
	function launchForView(meta, prompt, kind) {
		const runId = newRunId();
		/** @type {import("../core/types.mjs").RunConfig} */
		const config = {
			root,
			viewId: meta.id,
			runId,
			kind,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			prompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			thinkingLevel: meta.defaultThinking ?? null,
			tools: null,
		};
		const { pid } = launch(root, config, { runnerScript: opts.runnerScript });
		appendDiagnostic(root, meta.id, { source: "service", runId, code: "launch_run", message: "Detached runner launched", details: { kind, pid } });
		markQueued(meta.id, runId);
		return { runId, pid };
	}

	/**
	 * Launch a durable interactive PTY host for a view.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string|null} initialPrompt
	 * @returns {{ pid: number|null }}
	 */
	function launchHost(meta, initialPrompt, launchOpts = {}) {
		/** @type {import("../core/types.mjs").HostConfig} */
		const config = {
			root,
			viewId: meta.id,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			initialPrompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			thinkingLevel: meta.defaultThinking ?? null,
			tools: null,
			env: {},
			cols: Number(process.env.COLUMNS || 120),
			rows: Number(process.env.LINES || 36),
		};
		const socketPath = P.controlSocketPath(root, meta.id);
		const { pid } = launchHostImpl(root, config, { runnerScript: ptyRunnerScript });
		writeHost(root, {
			version: 1,
			viewId: meta.id,
			mode: "pty",
			runnerPid: pid,
			childPid: null,
			socketPath,
			state: "starting",
			startedAt: Date.now(),
			lastSeenAt: Date.now(),
			endedAt: null,
			exitCode: null,
			error: null,
			cols: config.cols,
			rows: config.rows,
			attachedClients: 0,
		});
		writeHostPid(root, meta.id, pid);
		appendDiagnostic(root, meta.id, { source: "service", code: "launch_host", message: "PTY host launched", details: { pid, hasInitialPrompt: Boolean(initialPrompt) } });
		if (launchOpts.markQueued !== false) markQueued(meta.id, null);
		return { pid, socketPath };
	}

	/**
	 * Best-effort detached title generation. If this fails or times out, the fallback slug
	 * remains as the row name.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string} prompt
	 */
	function queueGeneratedTitle(meta, prompt) {
		if (!titleRunnerScript) return;
		/** @type {import("../core/types.mjs").TitleConfig} */
		const config = {
			root,
			viewId: meta.id,
			cwd: meta.cwd,
			prompt,
			fallbackName: meta.name,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: null,
		};
		try {
			launchTitleImpl(root, config, { runnerScript: titleRunnerScript });
		} catch {
			/* best effort */
		}
	}

	/**
	 * Apply immediate heuristic auto-state and, when configured, queue a detached
	 * model pass to refine the row without blocking the live Pi child.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {import("../core/types.mjs").RunStatus} status
	 * @param {import("../core/types.mjs").EvidenceSnapshot} evidence
	 * @returns {boolean}
	 */
	function queueAutoState(meta, status, evidence) {
		if (!autoStateEnabled()) return false;
		if (status.processState === "alive" || status.semanticState === "failed" || status.semanticState === "stopped") return false;
		const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
		if (!latest.trim()) return false;
		const changed = applyAutoStateToStatus(status, heuristicAutoState(latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null }), Date.now());
		if (opts.autoStateRunnerScript) {
			try {
				launchAutoStateImpl(root, {
					root,
					viewId: meta.id,
					runId: status.runId === "foreground" ? null : status.runId,
					cwd: meta.cwd,
					piCommand: opts.piCommand,
					piArgsPrefix: opts.piArgsPrefix,
				}, { runnerScript: opts.autoStateRunnerScript });
			} catch (err) {
				appendDiagnostic(root, meta.id, { source: "service", level: "warn", code: "auto_state_launch_failed", message: "Auto-state classifier could not be launched", details: { error: err instanceof Error ? err.message : String(err) } });
			}
		}
		return changed;
	}

	/** @param {string} viewId @param {string|null} runId */
	function markQueued(viewId, runId) {
		const state = readState(root, viewId) ?? blankState(viewId);
		state.currentRunId = runId;
		state.semanticState = "queued";
		state.processState = "alive";
		state.summary = "Queued";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/** @param {string} viewId @returns {{ ok: boolean, error?: string }} */
	function markVisited(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
		state.lastVisitedAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
		return { ok: true };
	}

	/** @param {string} viewId @returns {{ ok: boolean, error?: string }} */
	function completeView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (isAgentBusy(row)) return { ok: false, error: "Wait for the active run to finish before marking done" };
		const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
		state.semanticState = "completed";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.summary = completionSummary(state);
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
		return { ok: true };
	}

	/**
	 * @param {string} viewId
	 * @returns {{ ok: boolean, error?: string }}
	 */
	function archiveView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
		if (row.alive && row.state?.currentRunId) {
			const pid = readPid(root, viewId, row.state.currentRunId);
			if (pid) killProcess(pid);
		}
		if (isAgentBusy(row)) {
			const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
			state.semanticState = "stopped";
			state.processState = "exited";
			state.needsInput = false;
			state.hasError = false;
			state.question = null;
			state.pendingQuestions = [];
			state.error = null;
			state.autoState = null;
			state.summary = "Stopped";
			state.lastActivityAt = Date.now();
			state.updatedAt = Date.now();
			writeState(root, state);
		}
		row.meta.archived = true;
		writeMeta(root, row.meta);
		return { ok: true };
	}

	/** @param {string} viewId @returns {import("../core/types.mjs").ViewState} */
	function blankState(viewId) {
		return {
			version: 1,
			viewId,
			currentRunId: null,
			semanticState: "queued",
			processState: "exited",
			summary: "Queued",
			lastActivityAt: Date.now(),
			updatedAt: Date.now(),
			needsInput: false,
			hasError: false,
			latestAssistantPreview: "",
			latestTool: null,
			question: null,
			pendingQuestions: [],
			error: null,
			lastVisitedAt: null,
			lastAgentActivityAt: null,
			autoState: null,
		};
	}

	/** @param {string} a @param {string} b */
	function samePath(a, b) {
		return resolve(a) === resolve(b);
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @returns {import("../core/types.mjs").RunStatus}
	 */
	function statusFromRow(row) {
		const now = Date.now();
		const s = row.state ?? blankState(row.meta.id);
		return {
			version: 1,
			runId: s.currentRunId ?? "foreground",
			viewId: row.meta.id,
			pid: null,
			startedAt: s.lastActivityAt ?? now,
			endedAt: null,
			exitCode: null,
			kind: "reply",
			prompt: "",
			model: row.meta.defaultModel ?? null,
			semanticState: s.semanticState,
			processState: s.processState,
			summary: s.summary,
			lastActivityAt: s.lastActivityAt,
			currentTool: s.latestTool ? { name: s.latestTool.name, path: s.latestTool.path, summary: s.summary } : null,
			latestAssistantPreview: s.latestAssistantPreview,
			question: s.question,
			pendingQuestions: Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [],
			error: s.error,
			lastAgentActivityAt: s.lastAgentActivityAt ?? null,
			stopReason: null,
			stoppedByUser: false,
			turns: 0,
			toolCount: 0,
			autoState: s.autoState ?? null,
		};
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @param {import("../core/types.mjs").RunStatus} status
	 */
	function writeForegroundState(row, status) {
		const projected = projectViewState(status, Date.now(), readState(root, row.meta.id) ?? row.state ?? null);
		// Foreground turns are driven by the interactive Pi process, not a detached
		// runner, so keep currentRunId null. This prevents reconcile()/stop() from
		// treating a foreground turn as a managed background runner pid.
		projected.currentRunId = null;
		writeState(root, projected);
	}

	/** @param {string} sessionFile */
	function rowForSession(sessionFile) {
		return listRows(root, { includeArchived: true }).find((r) => samePath(r.meta.sessionFile, sessionFile)) ?? null;
	}

	/**
	 * Keep a small warm pool of idle PTY hosts for fast session switching.
	 * Busy hosts and attached hosts are never evicted.
	 * @param {{ keepViewId?: string|null }} [pruneOpts]
	 */
	function pruneWarmHosts(pruneOpts = {}) {
		const maxWarm = envInt("AGENT_BOARD_MAX_WARM_HOSTS", 4, 0, 50, "AGENT_VIEW_MAX_WARM_HOSTS");
		const ttlMs = envInt("AGENT_BOARD_WARM_HOST_TTL_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_WARM_HOST_TTL_MS");
		if (maxWarm === 0 && ttlMs === 0) return;
		const now = Date.now();
		const idleHosts = listRows(root)
			.filter((r) => r.meta.id !== pruneOpts.keepViewId)
			.filter((r) => r.hostAlive && !isAgentBusy(r) && (r.host?.attachedClients ?? 0) === 0);

		for (const row of idleHosts) {
			const idleSince = row.state?.lastActivityAt ?? row.host?.startedAt ?? row.meta.updatedAt;
			if (ttlMs > 0 && now - idleSince > ttlMs) sendHostMessage(row, { type: "terminate" });
		}

		const survivors = idleHosts
			.filter((r) => {
				const idleSince = r.state?.lastActivityAt ?? r.host?.startedAt ?? r.meta.updatedAt;
				return !(ttlMs > 0 && now - idleSince > ttlMs);
			})
			.sort((a, b) => (a.state?.lastActivityAt ?? a.host?.startedAt ?? 0) - (b.state?.lastActivityAt ?? b.host?.startedAt ?? 0));
		const excess = Math.max(0, survivors.length - maxWarm);
		for (const row of survivors.slice(0, excess)) sendHostMessage(row, { type: "terminate" });
	}

	/** @param {import("../core/types.mjs").FollowUpKind|import("../core/types.mjs").RunKind|string} kind */
	function runKindForKind(kind) {
		switch (kind) {
			case "plan_request":
				return "plan";
			case "plan_change":
				return "plan_change";
			case "plan_approval":
				return "plan_approval";
			case "plan":
			case "reply":
			case "dispatch":
				return kind;
			default:
				return "reply";
		}
	}

	/** @param {import("../core/types.mjs").FollowUpItem} item */
	function runKindForFollowUp(item) {
		return runKindForKind(item.kind);
	}

	/** @param {string} viewId @param {import("../core/types.mjs").FollowUpItem} item */
	function promptForFollowUp(viewId, item) {
		const steering = readSteering(root, viewId);
		switch (item.kind) {
			case "plan_request":
				return buildPlanRequestPrompt(item.text);
			case "plan_approval":
				return buildApprovePlanPrompt(steering.planText);
			case "plan_change":
				return buildPlanChangesPrompt(steering.planText, item.text);
			default:
				return item.text;
		}
	}

	/** @param {string} viewId */
	function drainNextFollowUp(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (!canAutoDrain(row)) return { ok: false, error: "Session is not ready to drain queued follow-ups" };
		const claimed = claimNextFollowUp(root, viewId);
		if (!claimed.ok || !claimed.item) return claimed;
		const item = claimed.item;
		const prompt = promptForFollowUp(viewId, item);
		try {
			if (item.kind === "plan_approval") markExecutingApprovedPlan(root, viewId);
			if (row.hostAlive) {
				const sent = sendHostMessage(row, { type: "input", data: `${prompt}\r` });
				if (!sent.ok) {
					releaseFollowUp(root, viewId, item.id);
					return sent;
				}
				completeFollowUp(root, viewId, item.id);
				appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_sent", message: "Queued follow-up sent to live host", details: { kind: item.kind } });
				return { ok: true, sent: true, item };
			}
			const pty = ptySupport({ refresh: true });
			let runId = null;
			if (pty.ok) launchHost(row.meta, prompt);
			else {
				if (isExternalSession(row.meta)) {
					releaseFollowUp(root, viewId, item.id);
					appendDiagnostic(root, viewId, { source: "queue", level: "warn", code: "follow_up_waiting_for_pty", message: "Adopted session follow-up is waiting for PTY support", details: {} });
					return { ok: false, error: "PTY is required to drain adopted session follow-ups safely" };
				}
				runId = launchForView(row.meta, prompt, runKindForFollowUp(item)).runId;
			}
			completeFollowUp(root, viewId, item.id, { runId });
			appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_started", message: "Queued follow-up started", details: { kind: item.kind, hostMode: pty.ok ? "pty" : "json-runner" } });
			return { ok: true, started: true, item };
		} catch (err) {
			releaseFollowUp(root, viewId, item.id);
			appendDiagnostic(root, viewId, { source: "queue", level: "error", code: "follow_up_drain_failed", message: "Queued follow-up failed to start", details: { error: err instanceof Error ? err.message : String(err) } });
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** @param {import("../core/store.mjs").Row} row @param {any} event */
	function syncRowEvent(row, event) {
		const now = Date.now();
		const status = statusFromRow(row);
		let evidence = readEvidence(root, row.meta.id);
		if (!evidence.viewId) evidence = emptyEvidenceSnapshot({ viewId: row.meta.id, source: "hosted" });
		try {
			reduceEvidence(evidence, event, now);
			writeEvidence(root, evidence);
		} catch (err) {
			appendDiagnostic(root, row.meta.id, { source: "evidence", level: "warn", code: "evidence_reduce_failed", message: "Could not reduce hosted evidence", details: { error: err instanceof Error ? err.message : String(err) } });
		}

		if (event.type === "input" || event.type === "before_agent_start" || event.type === "agent_start") {
			status.semanticState = "working";
			status.processState = "alive";
			status.currentTool = null;
			status.question = null;
			status.pendingQuestions = [];
			status.error = null;
			status.summary = "Running…";
			status.lastActivityAt = now;
			writeForegroundState(row, status);
			return true;
		}

		if (event.type === "agent_end") {
			finalizeRun(status, { exitCode: 0 }, now);
			finalizeEvidence(evidence, status, now);
			const steering = readSteering(root, row.meta.id);
			if (steering.status === "plan_requested" || steering.status === "changes_requested") {
				recordPlanReady(root, row.meta.id, { planText: latestEvidenceText(evidence) || status.latestAssistantPreview || evidence.summary || "Plan ready", runId: status.runId });
				status.semanticState = "needs_input";
				status.question = "Approve this plan?";
				status.summary = "Plan ready for approval";
			} else if (queueAutoState(row.meta, status, evidence)) {
				finalizeEvidence(evidence, status, now);
			}
			status.evidenceSummary = summarizeEvidence(evidence);
			writeEvidence(root, evidence);
			writeForegroundState(row, status);
			pruneWarmHosts({ keepViewId: row.meta.id });
			drainNextFollowUp(row.meta.id);
			return true;
		}

		if (reduceEvent(status, event, now, { interactive: true })) {
			status.processState = "alive";
			writeForegroundState(row, status);
			return true;
		}
		return false;
	}

	return {
		root,
		/**
		 * Create a new background session and launch its first run.
		 * Worktree mode is currently disabled, but the dashboard no longer blocks
		 * concurrent same-repo sessions on its own.
		 * @param {string} text
		 * @param {{
		 *   cwd?: string,
		 *   worktree?: boolean,
		 *   writeCapable?: boolean,
		 *   model?: string|null,
		 *   thinkingLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|null,
		 * }} [dispatchOpts]
		 * @returns {{ ok: boolean, viewId?: string, error?: string, hostMode?: "pty"|"json-runner", fallbackReason?: string }}
		 */
		dispatch(text, dispatchOpts = {}) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty task" };

			const cwd = dispatchOpts.cwd ?? opts.defaultCwd;
			const writeCapable = dispatchOpts.writeCapable ?? true;
			const defaultModel = dispatchOpts.model ?? null;
			const defaultThinking = dispatchOpts.thinkingLevel ?? null;
			const repoRoot = gitRepoRoot(cwd);

			if (dispatchOpts.worktree) {
				return { ok: false, error: "Worktree mode is currently disabled." };
			}

			const id = newViewId();
			const meta = createView(root, {
				id,
				name: slugifyTask(prompt),
				cwd,
				repoCwd: cwd,
				repoRoot,
				worktreeMode: "off",
				worktreePath: null,
				defaultModel,
				defaultThinking,
				writeCapable,
			});
			const pty = ptySupport({ refresh: true });
			if (pty.ok) launchHost(meta, prompt);
			else launchForView(meta, prompt, "dispatch");
			queueGeneratedTitle(meta, prompt);
			return {
				ok: true,
				viewId: id,
				hostMode: pty.ok ? "pty" : "json-runner",
				fallbackReason: pty.ok ? undefined : nodePtyFallbackMessage(pty),
			};
		},

		/**
		 * Append a reply to an existing session by launching a new run. Blocks if a run is live.
		 * @param {string} viewId
		 * @param {string} text
		 * @returns {{ ok: boolean, error?: string, hostMode?: "pty"|"json-runner", fallbackReason?: string }}
		 */
		reply(viewId, text, replyOpts = {}) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty reply" };
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (hasPendingQuestions(row)) return { ok: false, error: "Attach to answer the pending question" };
			const delivery = replyOpts.delivery ?? "auto";
			const kind = replyOpts.kind ?? "reply";
			if (delivery === "queue" || (delivery === "auto" && isAgentBusy(row))) {
				const queued = enqueueFollowUp(root, viewId, prompt, { kind, delivery, source: "user" });
				if (queued.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind, queuedCount: queued.summary?.queuedCount } });
				return queued.ok ? { ok: true, queued: true, summary: queued.summary } : queued;
			}
			if (row.hostAlive) return sendHostMessage(row, { type: "input", data: `${prompt}\r` });
			if (row.alive) return { ok: false, error: "A run is already active for this session" };
			const pty = ptySupport({ refresh: true });
			if (pty.ok) launchHost(row.meta, prompt);
			else {
				if (isExternalSession(row.meta)) return { ok: false, error: "PTY is required to continue an adopted foreground session safely" };
				launchForView(row.meta, prompt, runKindForKind(kind));
			}
			return { ok: true, hostMode: pty.ok ? "pty" : "json-runner", fallbackReason: pty.ok ? undefined : nodePtyFallbackMessage(pty) };
		},

		/**
		 * Stop the active run for a view (SIGTERM the runner → it finalizes as `stopped`).
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		stop(viewId) {
			const row = loadRow(root, viewId);
			if (row?.hostAlive) return sendHostMessage(row, { type: "interrupt" });
			const state = readState(root, viewId);
			if (!state?.currentRunId) return { ok: false, error: "No active run" };
			const pid = readPid(root, viewId, state.currentRunId);
			if (!pid) return { ok: false, error: "No runner pid" };
			killProcess(pid);
			return { ok: true };
		},

		/** @param {string} viewId */
		terminateHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row?.hostAlive) return { ok: false, error: "No live host" };
			return sendHostMessage(row, { type: "terminate" });
		},

		/**
		 * Ensure there is an interactive PTY host for this session. Used for fast attach
		 * and dashboard prewarm. Starting an idle host must not alter task state.
		 * @param {string} viewId
		 * @returns {{ ok: boolean, socketPath?: string, started?: boolean, error?: string, fallbackReason?: string }}
		 */
		ensureHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (row.hostAlive && row.host?.socketPath) return { ok: true, socketPath: row.host.socketPath, started: false };

			const pty = ptySupport({ refresh: true });
			if (!pty.ok) return { ok: false, error: "PTY unavailable", fallbackReason: nodePtyFallbackMessage(pty) };
			if (isAgentBusy(row)) return { ok: false, error: "A non-live background run is active for this session" };
			if (!existsSync(row.meta.sessionFile)) return { ok: false, error: "Session file isn't ready yet" };

			const launched = launchHost(row.meta, null, { markQueued: false });
			pruneWarmHosts({ keepViewId: viewId });
			return { ok: true, socketPath: launched.socketPath, started: true };
		},

		/** @param {string} viewId */
		prewarmHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row || isAgentBusy(row)) return { ok: false, error: row ? "Session is busy" : "Unknown session" };
			return this.ensureHost(viewId);
		},

		/** @param {string} viewId */
		attachTarget(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { kind: "missing" };
			if (row.hostAlive && row.host?.socketPath) {
				return { kind: "pty", socketPath: row.host.socketPath, sessionFile: row.meta.sessionFile };
			}
			return { kind: "session", sessionFile: row.meta.sessionFile };
		},

		adoptSession(adoptOpts = {}) {
			const sessionFile = String(adoptOpts.sessionFile || "").trim();
			if (!sessionFile) return { ok: false, error: "No session file to adopt" };
			const existing = rowForSession(sessionFile);
			if (existing) {
				existing.meta.archived = false;
				if (adoptOpts.name) existing.meta.name = String(adoptOpts.name).trim() || existing.meta.name;
				writeMeta(root, existing.meta);
				if (!isAgentBusy(existing)) {
					const state = readState(root, existing.meta.id) ?? existing.state ?? blankState(existing.meta.id);
					state.semanticState = "idle";
					state.processState = "exited";
					state.needsInput = false;
					state.hasError = false;
					state.question = null;
					state.pendingQuestions = [];
					state.error = null;
					state.summary = "Backgrounded session";
					state.updatedAt = Date.now();
					state.lastActivityAt = Date.now();
					writeState(root, state);
				}
				appendDiagnostic(root, existing.meta.id, { source: "service", code: "session_adopted", message: "Existing session adopted into Agent Board", details: { reused: true } });
				return { ok: true, viewId: existing.meta.id, reused: true };
			}
			const cwd = adoptOpts.cwd ?? opts.defaultCwd;
			const id = newViewId();
			const repoRoot = gitRepoRoot(cwd);
			const meta = createView(root, {
				id,
				name: adoptOpts.name ?? "background-session",
				cwd,
				repoCwd: cwd,
				repoRoot,
				worktreeMode: "off",
				worktreePath: null,
				defaultModel: adoptOpts.model ?? null,
				defaultThinking: adoptOpts.thinkingLevel ?? null,
				writeCapable: true,
				sessionFile,
			});
			const state = readState(root, id) ?? blankState(id);
			state.semanticState = "idle";
			state.processState = "exited";
			state.summary = "Backgrounded session";
			state.updatedAt = Date.now();
			state.lastActivityAt = Date.now();
			writeState(root, state);
			appendDiagnostic(root, id, { source: "service", code: "session_adopted", message: "Current session adopted into Agent Board", details: { reused: false } });
			return { ok: true, viewId: meta.id, reused: false };
		},

		getLaunchPrefs() {
			return readLaunchPrefs(root);
		},

		saveLaunchPrefs(prefs) {
			writeLaunchPrefs(root, prefs ?? {});
			return { ok: true };
		},

		/** @param {string} viewId @param {boolean} pinned */
		setPinned(viewId, pinned) {
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.pinned = pinned;
			writeMeta(root, meta);
			return { ok: true };
		},

		/** @param {string} viewId @param {string} name */
		rename(viewId, name) {
			const clean = String(name || "").trim();
			if (!clean) return { ok: false, error: "Empty name" };
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.name = clean;
			writeMeta(root, meta);
			return { ok: true };
		},

		/** @param {string} viewId @returns {{ ok: boolean, error?: string }} */
		markVisited(viewId) {
			return markVisited(viewId);
		},

		/**
		 * Explicitly mark an inactive session as done. Successful runs settle as
		 * `idle` until the user reviews and confirms this action from the dashboard.
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		markCompleted(viewId) {
			return completeView(viewId);
		},

		/**
		 * Bulk mark sessions done, skipping live/already-done rows.
		 * @param {string[]} viewIds
		 * @returns {{ ok: boolean, completed: number, skipped: number, completedIds: string[] }}
		 */
		queueFollowUp(viewId, text, queueOpts = {}) {
			const res = enqueueFollowUp(root, viewId, text, queueOpts);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind: queueOpts.kind ?? "reply" } });
			return res;
		},

		clearFollowUps(viewId) {
			const res = clearQueuedFollowUps(root, viewId);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_ups_cleared", message: "Queued follow-ups cleared", details: { cancelled: res.cancelled } });
			return res;
		},

		removeLastFollowUp(viewId) {
			const res = removeLastFollowUp(root, viewId);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_removed", message: "Last queued follow-up removed", details: { itemId: res.item?.id } });
			return res;
		},

		followUps(viewId) {
			const queue = readFollowUpQueue(root, viewId);
			return { queue, summary: summarizeFollowUpQueue(queue) };
		},

		drainNextFollowUp(viewId) {
			return drainNextFollowUp(viewId);
		},

		requestPlan(viewId, text = "") {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			requestPlanState(root, viewId, { note: text || null });
			if (isAgentBusy(row)) return this.queueFollowUp(viewId, text, { kind: "plan_request", delivery: "queue", source: "steering" });
			return this.reply(viewId, buildPlanRequestPrompt(text), { delivery: "now", kind: "plan_request" });
		},

		approvePlan(viewId) {
			const row = loadRow(root, viewId);
			const state = readSteering(root, viewId);
			const approved = approvePlanState(root, viewId);
			if (!approved.ok) return approved;
			if (row && isAgentBusy(row)) return this.queueFollowUp(viewId, "approved", { kind: "plan_approval", delivery: "queue", source: "steering" });
			markExecutingApprovedPlan(root, viewId);
			return this.reply(viewId, buildApprovePlanPrompt(state.planText), { delivery: "now", kind: "plan_approval" });
		},

		requestPlanChanges(viewId, feedback) {
			const row = loadRow(root, viewId);
			const state = readSteering(root, viewId);
			const changed = requestPlanChangesState(root, viewId, feedback);
			if (!changed.ok) return changed;
			if (row && isAgentBusy(row)) return this.queueFollowUp(viewId, feedback, { kind: "plan_change", delivery: "queue", source: "steering" });
			return this.reply(viewId, buildPlanChangesPrompt(state.planText, feedback), { delivery: "now", kind: "plan_change" });
		},

		steering(viewId) {
			const state = readSteering(root, viewId);
			return { state, summary: summarizeSteering(state) };
		},

		markCompletedMany(viewIds) {
			const ids = [...new Set((viewIds ?? []).filter(Boolean))];
			let completed = 0;
			let skipped = 0;
			const completedIds = [];
			for (const viewId of ids) {
				const row = loadRow(root, viewId);
				if (!row || row.state?.semanticState === "completed") {
					skipped += 1;
					continue;
				}
				const res = completeView(viewId);
				if (res.ok) {
					completed += 1;
					completedIds.push(viewId);
				} else skipped += 1;
			}
			return { ok: true, completed, skipped, completedIds };
		},

		/**
		 * Soft-delete a row: archive it (removed from the dashboard) but preserve the session
		 * file.
		 * @param {string} viewId
		 */
		archive(viewId) {
			return archiveView(viewId);
		},

		/**
		 * Bulk archive explicit row ids, skipping live/missing rows.
		 * @param {string[]} viewIds
		 * @returns {{ ok: boolean, archived: number, skipped: number }}
		 */
		archiveMany(viewIds) {
			const ids = [...new Set((viewIds ?? []).filter(Boolean))];
			let archived = 0;
			let skipped = 0;
			for (const viewId of ids) {
				const row = loadRow(root, viewId);
				if (!row || isAgentBusy(row)) {
					skipped += 1;
					continue;
				}
				const res = archiveView(viewId);
				if (res.ok) archived += 1;
				else skipped += 1;
			}
			return { ok: true, archived, skipped };
		},

		/**
		 * Archive every non-live visible row in a semantic state. Live rows are skipped
		 * so bulk cleanup cannot accidentally kill work.
		 * @param {import("../core/types.mjs").SemanticState} state
		 * @returns {{ ok: boolean, archived: number, skipped: number, error?: string }}
		 */
		archiveByState(state) {
			let archived = 0;
			let skipped = 0;
			for (const row of listRows(root)) {
				if (row.state?.semanticState !== state) continue;
				if (isAgentBusy(row)) {
					skipped += 1;
					continue;
				}
				if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
				row.meta.archived = true;
				writeMeta(root, row.meta);
				archived += 1;
			}
			return { ok: true, archived, skipped };
		},

		/**
		 * Recovery: reconcile rows whose runner died without finalizing (e.g. machine crash
		 * or the runner was killed). If a terminal status exists, project it; otherwise mark
		 * the row failed/stale. Safe to call on every dashboard open and on session_start.
		 * @returns {number} number of rows reconciled.
		 */
		reconcile() {
			const now = Date.now();
			let fixed = 0;
			for (const row of listRows(root)) {
				const s = row.state;
				const looksActive = s?.processState === "alive" || s?.semanticState === "queued" || s?.semanticState === "working";
				if (!s || !looksActive) continue;
				if (!s.currentRunId) {
					if (row.host && !row.hostAlive && (row.host.state === "starting" || row.host.state === "alive" || row.host.state === "exited" || row.host.state === "failed")) {
						const failed = row.host.state === "starting" || row.host.state === "alive" || row.host.state === "failed" || Boolean(row.host.error) || (row.host.exitCode !== null && row.host.exitCode !== 0);
						s.semanticState = failed ? "failed" : "idle";
						s.processState = "exited";
						s.hasError = failed;
						s.needsInput = false;
						s.question = null;
						s.pendingQuestions = [];
						s.error = failed ? (s.error ?? row.host.error ?? "PTY host exited unexpectedly") : null;
						s.summary = failed ? "Failed (PTY host exited)" : "In Progress";
						s.updatedAt = now;
						writeState(root, s);
						appendDiagnostic(root, row.meta.id, { source: "service", level: failed ? "error" : "info", code: "host_reconciled", message: failed ? "PTY host exited before final event" : "PTY host finalized without final event", details: { hostState: row.host.state, exitCode: row.host.exitCode } });
						fixed += 1;
					}
					continue;
				}
				if (row.alive) continue;
				const status = readStatus(root, row.meta.id, s.currentRunId);
				if (status?.endedAt) {
					writeState(root, projectViewState(status, now, readState(root, row.meta.id) ?? row.state ?? null));
				} else {
					s.semanticState = "failed";
					s.processState = "exited";
					s.hasError = true;
					s.needsInput = false;
					s.error = s.error ?? "Runner exited unexpectedly";
					s.summary = "Failed (runner exited)";
					s.updatedAt = now;
					writeState(root, s);
				}
				fixed += 1;
			}
			for (const row of listRows(root)) {
				if ((row.state?.followUps?.queuedCount ?? 0) > 0 && canAutoDrain(row)) {
					const drained = drainNextFollowUp(row.meta.id);
					if (drained.ok) fixed += 1;
				}
			}
			return fixed;
		},

		/**
		 * Mirror lifecycle/events from a managed session that is currently attached in
		 * the foreground. Without this, a row that was completed/needs_input can keep
		 * looking stale after the user types a follow-up in the real Pi session.
		 * @param {string|undefined} sessionFile
		 * @param {any} event
		 * @returns {boolean} whether a managed row was updated
		 */
		syncForegroundEvent(sessionFile, event) {
			if (!sessionFile || !event?.type) return false;
			const row = rowForSession(sessionFile);
			if (!row) return false;
			return syncRowEvent(row, event);
		},

		/** @param {string|undefined} viewId @param {any} event */
		syncHostedEvent(viewId, event) {
			if (!viewId || !event?.type) return false;
			const row = loadRow(root, viewId);
			if (!row) return false;
			return syncRowEvent(row, event);
		},

		/** @returns {import("../core/store.mjs").Row[]} all visible rows. */
		rows() {
			return listRows(root);
		},

		/**
		 * Live node-pty / PTY host health snapshot for dashboard chrome.
		 * - `ok` reflects whether this process can currently launch PTY hosts.
		 * - `staleHosts` counts rows whose last persisted host claimed `alive` but the
		 *   runner pid is gone, which often explains attach prompts / degraded UX.
		 */
		ptyHealth() {
			const support = ptySupport();
			const rows = listRows(root);
			const staleHosts = rows.filter((row) => row.host?.state === "alive" && !row.hostAlive).length;
			const liveHosts = rows.filter((row) => row.hostAlive).length;
			const stalled = rows.filter((row) => row.state?.diagnostics?.stalled).length;
			const diagnosticErrors = rows.reduce((sum, row) => sum + (row.state?.diagnostics?.errorCount ?? 0), 0);
			return {
				ok: Boolean(support.ok),
				reason: support.ok ? null : support.reason ?? "PTY unavailable",
				issue: support.ok ? null : (support.issue ?? diagnoseNodePtyFailure(support.reason ?? null)),
				staleHosts,
				liveHosts,
				stalled,
				diagnosticErrors,
			};
		},

		evidence(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return {
				ok: true,
				evidence: readEvidence(root, viewId),
				paths: {
					evidence: P.evidencePath(root, viewId),
					diagnostics: P.diagnosticsPath(root, viewId),
					session: row.meta.sessionFile,
					screenLog: P.screenLogPath(root, viewId),
				},
			};
		},

		diagnostics(viewId, diagOpts = {}) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return { ok: true, events: tailDiagnostics(root, viewId, { limit: diagOpts.limit ?? 50 }) };
		},

		clearDiagnostics(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return clearDiagnostics(root, viewId);
		},

		/** @param {string} viewId @returns {import("../core/store.mjs").Row|null} */
		row(viewId) {
			return loadRow(root, viewId);
		},
	};
}

/** @param {import("../core/store.mjs").Row} row */
function hasPendingQuestions(row) {
	return Array.isArray(row.state?.pendingQuestions) && row.state.pendingQuestions.length > 0;
}

/** @param {import("../core/store.mjs").Row} row */
function isAgentBusy(row) {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working" || hasPendingQuestions(row)));
}

/** @param {import("../core/types.mjs").ViewMeta} meta */
function isExternalSession(meta) {
	const normalized = resolve(meta.sessionFile).replace(/\\/g, "/");
	return !normalized.endsWith(`/sessions/${meta.id}.jsonl`);
}

/** @param {import("../core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

/** @param {import("../core/store.mjs").Row} row */
function canAutoDrain(row) {
	const st = row.state?.semanticState;
	return !isAgentBusy(row) && (st === "idle" || st === "completed");
}

/** @param {import("../core/types.mjs").ViewState} state */
function completionSummary(state) {
	if (!isGenericStatusText(state.summary)) return compactSummary(state.summary);
	return "Done";
}

/** @param {string} text */
function compactSummary(text) {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return "Done";
	const first = firstSentence(cleaned);
	return truncate(first.length >= 12 ? first : cleaned, 80);
}

/**
 * Send a one-shot JSONL command to a live host socket.
 * @param {import("../core/store.mjs").Row} row
 * @param {Record<string, unknown>} message
 * @returns {{ ok: boolean, error?: string }}
 */
function sendHostMessage(row, message) {
	const socketPath = row.host?.socketPath;
	if (!socketPath) return { ok: false, error: "No host socket" };
	if (!existsSync(socketPath)) return { ok: false, error: "Host socket is not ready" };
	try {
		const socket = createConnection(socketPath);
		socket.on("connect", () => {
			socket.write(JSON.stringify(message) + "\n");
			socket.end();
		});
		socket.on("error", () => {});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

let cachedPtySupport;
const requireForPty = createRequire(import.meta.url);
const PTY_SUPPORT_ERROR_TTL_MS = 2_000;

function ptyHostAvailability(opts = {}) {
	if (process.env.AGENT_BOARD_DISABLE_PTY === "1" || process.env.AGENT_VIEW_DISABLE_PTY === "1") {
		return { ok: false, reason: "AGENT_BOARD_DISABLE_PTY=1", issue: diagnoseNodePtyFailure("AGENT_BOARD_DISABLE_PTY=1") };
	}
	if (process.env.AGENT_BOARD_FORCE_PTY === "1" || process.env.AGENT_VIEW_FORCE_PTY === "1") return { ok: true };
	return ptySpawnSupported(opts);
}

function envInt(name, fallback, min, max, legacyName) {
	const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export function shouldProbePtySupport(cached, opts = {}, now = Date.now()) {
	if (!cached) return true;
	if (cached.ok) return false;
	if (opts.refresh) return true;
	const ttlMs = opts.maxAgeMs ?? PTY_SUPPORT_ERROR_TTL_MS;
	return now - (cached.checkedAt ?? 0) >= ttlMs;
}

function ptySpawnSupported(opts = {}) {
	const now = Date.now();
	if (!shouldProbePtySupport(cachedPtySupport, opts, now)) return cachedPtySupport;
	try {
		ensureNodePtySpawnHelperExecutable(requireForPty);
		const pty = requireForPty("node-pty");
		const proc = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
			name: "xterm-256color",
			cols: 20,
			rows: 5,
			cwd: process.cwd(),
			env: process.env,
		});
		proc.kill?.();
		cachedPtySupport = { ok: true, checkedAt: now };
	} catch (err) {
		cachedPtySupport = { ok: false, reason: err instanceof Error ? err.message : String(err), checkedAt: now };
		cachedPtySupport.issue = diagnoseNodePtyFailure(cachedPtySupport.reason, { probe: probeNodePtyEnvironment(requireForPty) });
	}
	return cachedPtySupport;
}

