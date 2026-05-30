/**
 * `/agents` command: opens the dashboard, runs its action loop, and performs the
 * post-close actions the surface can't (attach = ctx.switchSession, which tears down the
 * current session). Also wires dispatch+attach and stale-row recovery on open.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
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

export async function openDashboard(
	ctx: Pick<ExtensionCommandContext, "ui" | "cwd">,
	service: ReturnType<typeof createService>,
	options: { initialSelectedId?: string | null } = {},
): Promise<DashboardResult> {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setTitle("agent-view");
	try {
		return await ctx.ui.custom<DashboardResult>(
			(tui, theme, keybindings, done) => {
				let interval: ReturnType<typeof setInterval> | null = null;
				const wrappedDone = (result: DashboardResult) => {
					if (interval) clearInterval(interval);
					interval = null;
					done(result);
				};
				const comp = new DashboardComponent(tui, theme as never, keybindings, wrappedDone, {
					service,
					defaultCwd: ctx.cwd,
					initialSelectedId: options.initialSelectedId,
				});
				interval = setInterval(() => {
					comp.refresh();
					tui.requestRender(true);
				}, POLL_MS);
				const withDispose = comp as DashboardComponent & { dispose: () => void };
				withDispose.dispose = () => {
					if (interval) clearInterval(interval);
					interval = null;
				};
				return comp;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			},
		);
	} finally {
		ctx.ui.setHeader(undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setWorkingVisible(true);
	}
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
			replaced.ui.notify(`Attached to "${name}". Press ← on empty input to return to agent view.`, "info");
			installBackToDashboard(replaced, service);
		},
	});
	if (result.cancelled) ctx.ui.notify("Attach cancelled.", "warning");
}

function installBackToDashboard(ctx: ExtensionCommandContext, service: ReturnType<typeof createService>): void {
	ctx.ui.setStatus("agent-view.back", ctx.ui.theme.fg("muted", "← agents"));
	let opening = false;
	ctx.ui.onTerminalInput((data: string) => {
		if (opening || !matchesKey(data, Key.left)) return undefined;
		// Do not steal normal cursor-left while the user is composing a message.
		if (ctx.ui.getEditorText().length > 0) return undefined;
		opening = true;
		void (async () => {
			try {
				service.reconcile();
				const result = await openDashboard(ctx, service, { initialSelectedId: currentViewId(ctx, service) });
				if (result.action !== "attach") return;
				const target = service.row(result.viewId);
				const currentSessionFile = ctx.sessionManager.getSessionFile();
				if (target && currentSessionFile && samePath(target.meta.sessionFile, currentSessionFile)) {
					ctx.ui.notify("Already attached to this session.", "info");
					return;
				}
				await attach(ctx, service, result.viewId, result.stopFirst);
			} catch (err) {
				ctx.ui.notify(`Couldn't open agent view: ${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				opening = false;
			}
		})();
		return { consume: true };
	});
}

function currentViewId(ctx: ExtensionCommandContext, service: ReturnType<typeof createService>): string | null {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) return null;
	return service.rows().find((r) => samePath(r.meta.sessionFile, currentSessionFile))?.meta.id ?? null;
}

function samePath(a: string, b: string): boolean {
	return resolve(a) === resolve(b);
}
