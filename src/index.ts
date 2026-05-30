/**
 * Pi Agent View — extension entry point.
 *
 * Registers the `/agents` dashboard command, resolves how to
 * launch background workers and the detached runner, and keeps a small footer status with
 * the count of sessions needing attention. See docs/EXPLORATION.md for the design.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePiInvocation } from "./core/invocation.mjs";
import { defaultRoot } from "./core/paths.mjs";
import { listRows } from "./core/store.mjs";
import { createService } from "./runtime/service.mjs";
import { openDashboard, registerAgentsCommand } from "./commands/agents.js";

const RUNNER_SCRIPT = fileURLToPath(new URL("../runner/job-runner.mjs", import.meta.url));

export default function piAgentView(pi: ExtensionAPI): void {
	const root = defaultRoot();
	const { piCommand, piArgsPrefix } = resolvePiInvocation();

	registerAgentsCommand(pi, { root, runnerScript: RUNNER_SCRIPT, piCommand, piArgsPrefix });
	pi.registerFlag("agent-view", {
		description: "Open the agent-view dashboard on startup",
		type: "boolean",
		default: false,
	});

	// Footer status: reconcile stale rows and surface how many need attention.
	const updateStatus = (ctx: ExtensionContext) => {
		try {
			createService({ root, runnerScript: RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd }).reconcile();
			const rows = listRows(root);
			const needs = rows.filter((r) => r.state?.semanticState === "needs_input").length;
			const working = rows.filter((r) => r.alive).length;
			if (rows.length === 0) {
				ctx.ui.setStatus("agent-view", undefined);
				return;
			}
			const parts: string[] = [];
			if (working > 0) parts.push(ctx.ui.theme.fg("accent", `●${working}`));
			if (needs > 0) parts.push(ctx.ui.theme.fg("warning", `◆${needs}`));
			ctx.ui.setStatus("agent-view", parts.length ? `${ctx.ui.theme.fg("muted", "agents")} ${parts.join(" ")}` : undefined);
		} catch {
			/* never break the session over a status update */
		}
	};

	pi.on("session_start", async (event, ctx) => {
		updateStatus(ctx);
		if (event.reason === "startup" && pi.getFlag("agent-view") === true && ctx.hasUI) {
			const service = createService({ root, runnerScript: RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });
			service.reconcile();
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
			ctx.ui.setTitle("agent view");
			const result = await openDashboard(ctx, service);
			if (result.action === "attach") {
				ctx.ui.notify("Attach requires the /agents command path; launch from a normal Pi session for now.", "warning");
			} else {
				ctx.shutdown();
			}
		}
	});
	pi.on("agent_end", async (_event, ctx) => updateStatus(ctx));
}
