/**
 * Pi Agent Board — extension entry point.
 *
 * Registers the `/agent-board` dashboard command, resolves how to
 * launch background workers and the detached runner, and keeps a small footer status with
 * the count of sessions needing attention. See docs/EXPLORATION.md for the design.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiInvocation } from "./core/invocation.mjs";
import { defaultRoot } from "./core/paths.mjs";
import { listRows } from "./core/store.mjs";
import { createService } from "./runtime/service.mjs";
import { openDashboard, registerAgentBoardCommand } from "./commands/agent-board.js";

const RUNNER_SCRIPT = fileURLToPath(new URL("../runner/job-runner.mjs", import.meta.url));
const PTY_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/pty-runner.mjs", import.meta.url));

export default function piAgentBoard(pi: ExtensionAPI): void {
	const root = defaultRoot();
	const { piCommand, piArgsPrefix } = resolvePiInvocation();

	const isHostedChild = process.env.AGENT_BOARD_CHILD === "1" || process.env.AGENT_VIEW_CHILD === "1";
	const hostedViewId = process.env.AGENT_BOARD_VIEW_ID ?? process.env.AGENT_VIEW_VIEW_ID;

	registerAgentBoardCommand(pi, { root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, piCommand, piArgsPrefix });
	pi.registerFlag("agent-board", {
		description: "Open the agent-board dashboard on startup",
		type: "boolean",
		default: false,
	});

	// Footer status: reconcile stale rows and surface how many need attention.
	const serviceFor = (ctx: ExtensionContext) =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });

	const updateStatus = (ctx: ExtensionContext) => {
		try {
			serviceFor(ctx).reconcile();
			const rows = listRows(root);
			const needs = rows.filter((r) => r.state?.semanticState === "needs_input").length;
			const working = rows.filter((r) => r.alive).length;
			if (isHostedChild) return;
			if (rows.length === 0) {
				ctx.ui.setStatus("agent-board", undefined);
				return;
			}
			const parts: string[] = [];
			if (working > 0) parts.push(ctx.ui.theme.fg("accent", `●${working}`));
			if (needs > 0) parts.push(ctx.ui.theme.fg("warning", `◆${needs}`));
			ctx.ui.setStatus("agent-board", parts.length ? `${ctx.ui.theme.fg("muted", "agents")} ${parts.join(" ")}` : undefined);
		} catch {
			/* never break the session over a status update */
		}
	};

	pi.on("session_start", async (event, ctx) => {
		updateStatus(ctx);
		if (event.reason === "startup" && !isHostedChild && pi.getFlag("agent-board") === true && ctx.hasUI) {
			const service = createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });
			service.reconcile();
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setTitle("agent board");
			const result = await openDashboard(ctx, service);
			if (result.action === "attach") {
				ctx.ui.notify("Attach requires the /agent-board command path; launch from a normal Pi session for now.", "warning");
			} else {
				ctx.shutdown();
			}
		}
	});
	const syncForeground = (event: unknown, ctx: ExtensionContext) => {
		try {
			const service = serviceFor(ctx);
			if (hostedViewId) service.syncHostedEvent(hostedViewId, event);
			else service.syncForegroundEvent(ctx.sessionManager.getSessionFile(), event);
			updateStatus(ctx);
		} catch {
			/* never break the session over dashboard mirroring */
		}
	};

	pi.on("input", async (event, ctx) => syncForeground(event, ctx));
	pi.on("before_agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("tool_execution_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_start", async (event, ctx) => syncForeground(event, ctx));
	pi.on("message_end", async (event, ctx) => syncForeground(event, ctx));
	pi.on("agent_end", async (event, ctx) => syncForeground(event, ctx));
}
