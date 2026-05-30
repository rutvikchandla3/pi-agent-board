/**
 * `/agents` command: opens the dashboard, runs its action loop, and performs the
 * post-close actions the surface can't (attach = ctx.switchSession, which tears down the
 * current session). Also wires dispatch+attach and stale-row recovery on open.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createService } from "../runtime/service.mjs";
import { DashboardComponent, type DashboardResult } from "../ui/dashboard.js";

const POLL_MS = 700;

export interface AgentsCommandOptions {
	root: string;
	runnerScript: string;
	piCommand: string;
	piArgsPrefix: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerAgentsCommand(pi: ExtensionAPI, opts: AgentsCommandOptions): void {
	pi.registerCommand("agents", {
		description: "Open the background agent-view dashboard",
		handler: async (args, ctx) => {
			const attachMatch = /(?:^|\s)--attach\s+(\S+)/.exec(args);
			const stopFirst = /(^|\s)--stop(\s|$)/.test(args);
			const service = createService({
				root: opts.root,
				runnerScript: opts.runnerScript,
				piCommand: opts.piCommand,
				piArgsPrefix: opts.piArgsPrefix,
				defaultCwd: ctx.cwd,
			});

			if (!ctx.hasUI) {
				ctx.ui.notify("The agent-view dashboard requires interactive mode.", "warning");
				return;
			}

			if (attachMatch) {
				await attach(ctx, service, attachMatch[1], stopFirst);
				return;
			}

			let again = true;
			while (again) {
				service.reconcile();
				const result = await openDashboard(ctx, service);
				if (result.action === "attach") {
					again = false;
					await attach(ctx, service, result.viewId, result.stopFirst);
				} else {
					again = false;
				}
			}
		},
	});
}

export function openDashboard(
	ctx: Pick<ExtensionCommandContext, "ui" | "cwd">,
	service: ReturnType<typeof createService>,
): Promise<DashboardResult> {
	return ctx.ui.custom<DashboardResult>((tui, theme, keybindings, done) => {
		let interval: ReturnType<typeof setInterval> | null = null;
		const wrappedDone = (result: DashboardResult) => {
			if (interval) clearInterval(interval);
			interval = null;
			done(result);
		};
		const comp = new DashboardComponent(tui, theme as never, keybindings, wrappedDone, {
			service,
			defaultCwd: ctx.cwd,
		});
		interval = setInterval(() => {
			comp.refresh();
			tui.requestRender();
		}, POLL_MS);
		const withDispose = comp as DashboardComponent & { dispose: () => void };
		withDispose.dispose = () => {
			if (interval) clearInterval(interval);
			interval = null;
		};
		return comp;
	});
}

async function attach(
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof createService>,
	viewId: string,
	stopFirst: boolean,
): Promise<void> {
	const row = service.row(viewId);
	if (!row) {
		ctx.ui.notify("Session no longer exists.", "warning");
		return;
	}
	if (stopFirst && row.alive) {
		service.stop(viewId);
		// Give the runner a moment to terminate the worker and release the session file.
		await sleep(500);
	}
	if (!existsSync(row.meta.sessionFile)) {
		ctx.ui.notify("Session file isn't ready yet — try again once the run has started.", "warning");
		return;
	}
	const name = row.meta.name;
	const result = await ctx.switchSession(row.meta.sessionFile, {
		withSession: async (replaced) => {
			replaced.ui.notify(`Attached to "${name}". Run /agents to return to the dashboard.`, "info");
		},
	});
	if (result.cancelled) ctx.ui.notify("Attach cancelled.", "warning");
}
