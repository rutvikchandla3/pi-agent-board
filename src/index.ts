/**
 * Pi Agent View — extension entry point.
 *
 * Registers the `/agents` dashboard command (+ an optional shortcut), resolves how to
 * launch background workers and the detached runner, and keeps a small footer status with
 * the count of sessions needing attention. See docs/EXPLORATION.md for the design.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { resolvePiInvocation } from "./core/invocation.mjs";
import { defaultRoot } from "./core/paths.mjs";
import { listRows } from "./core/store.mjs";
import { createService } from "./runtime/service.mjs";
import { registerAgentsCommand } from "./commands/agents.js";

const RUNNER_SCRIPT = fileURLToPath(new URL("../runner/job-runner.mjs", import.meta.url));

export default function piAgentView(pi: ExtensionAPI): void {
	const root = defaultRoot();
	const { piCommand, piArgsPrefix } = resolvePiInvocation();

	registerAgentsCommand(pi, { root, runnerScript: RUNNER_SCRIPT, piCommand, piArgsPrefix });

	// Convenience shortcut: route to the /agents command (so attach/session-switch run in a
	// command context). Ctrl+G = "go to agents".
	pi.registerShortcut(Key.ctrl("g"), {
		description: "Open the agent-view dashboard",
		handler: async () => {
			pi.sendUserMessage("/agents");
		},
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

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("agent_end", async (_event, ctx) => updateStatus(ctx));
}
