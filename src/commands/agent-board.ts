/**
 * `/agent-board` command: opens the dashboard, runs its action loop, and attaches through
 * agent-board PTY hosts for fast switching. `ctx.switchSession` is only a no-PTY fallback.
 * Also wires dispatch+attach and stale-row recovery on open.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { createService } from "../runtime/service.mjs";
import { screenLogPath } from "../core/paths.mjs";
import { DashboardComponent, type DashboardResult } from "../ui/dashboard.js";
import { PtyAttachComponent, type PtyAttachResult } from "../ui/pty-attach.js";

const POLL_MS = 700;

export interface AgentBoardCommandOptions {
	root: string;
	runnerScript: string;
	ptyRunnerScript?: string;
	piCommand: string;
	piArgsPrefix: string[];
	getThinkingLevel: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerAgentBoardCommand(pi: ExtensionAPI, opts: AgentBoardCommandOptions): void {
	pi.registerCommand("agent-board", {
		description: "Open the background agent-board dashboard",
		handler: async (args, ctx) => {
			const attachMatch = /(?:^|\s)--attach\s+(\S+)/.exec(args);
			const stopFirst = /(^|\s)--stop(\s|$)/.test(args);
			const service = createService({
				root: opts.root,
				runnerScript: opts.runnerScript,
				ptyRunnerScript: opts.ptyRunnerScript,
				piCommand: opts.piCommand,
				piArgsPrefix: opts.piArgsPrefix,
				defaultCwd: ctx.cwd,
			});

			if (!ctx.hasUI) {
				ctx.ui.notify("The agent-board dashboard requires interactive mode.", "warning");
				return;
			}

			if (attachMatch) {
				const outcome = await attach(ctx, service, opts.root, attachMatch[1], stopFirst);
				if (outcome.action !== "switched") await dashboardAttachLoop(ctx, service, opts.root, attachMatch[1], opts.getThinkingLevel);
				return;
			}

			await dashboardAttachLoop(ctx, service, opts.root, null, opts.getThinkingLevel);
		},
	});
}

export async function openDashboard(
	ctx: Pick<ExtensionCommandContext, "ui" | "cwd" | "modelRegistry" | "model">,
	service: ReturnType<typeof createService>,
	options: {
		initialSelectedId?: string | null;
		currentThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	} = {},
): Promise<DashboardResult> {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setTitle("agent-board");
	let availableModels: any[] = [];
	try {
		availableModels = ctx.modelRegistry.getAvailable();
	} catch {
		availableModels = [];
	}
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
					availableModels,
					currentModel: ctx.model ?? null,
					currentThinkingLevel: options.currentThinkingLevel ?? "off",
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

type AttachOutcome = { action: "detached" | "closed" | "switched" | "none" };

async function dashboardAttachLoop(
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof createService>,
	root: string,
	initialSelectedId: string | null,
	getThinkingLevel?: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<void> {
	let selectedId = initialSelectedId;
	let again = true;
	while (again) {
		service.reconcile();
		const result = await openDashboard(ctx, service, {
			initialSelectedId: selectedId,
			currentThinkingLevel: getThinkingLevel?.(),
		});
		if (result.action !== "attach") return;
		selectedId = result.viewId;
		const outcome = await attach(ctx, service, root, result.viewId, result.stopFirst);
		again = outcome.action === "detached" || outcome.action === "closed" || outcome.action === "none";
	}
}

async function attach(
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof createService>,
	root: string,
	viewId: string,
	stopFirst: boolean,
): Promise<AttachOutcome> {
	const row = service.row(viewId);
	if (!row) {
		ctx.ui.notify("Session no longer exists.", "warning");
		return { action: "none" };
	}
	if (stopFirst && row.alive && !row.hostAlive) {
		service.stop(viewId);
		// Give the runner a moment to terminate the worker and release the session file.
		await sleep(500);
	} else if (row.alive && !row.hostAlive) {
		ctx.ui.notify("Session is still running. Stop it before attaching, or confirm from the dashboard.", "warning");
		return { action: "none" };
	}

	const target = service.attachTarget(viewId);
	if (target.kind === "pty" && target.socketPath) {
		const result = await openPtyAttach(ctx, root, row.meta.id, row.meta.name, target.socketPath);
		return { action: result.action === "closed" ? "closed" : "detached" };
	}

	const ensured = service.ensureHost(viewId);
	if (ensured.ok && ensured.socketPath) {
		const result = await openPtyAttach(ctx, root, row.meta.id, row.meta.name, ensured.socketPath);
		return { action: result.action === "closed" ? "closed" : "detached" };
	}

	const latest = service.row(viewId) ?? row;
	if (!existsSync(latest.meta.sessionFile)) {
		ctx.ui.notify("Session file isn't ready yet — try again once the run has started.", "warning");
		return { action: "none" };
	}
	const name = latest.meta.name;
	const switchingOverlay = await showSwitchingOverlay(ctx, name, ensured.fallbackReason ?? ensured.error ?? "PTY unavailable");
	const result = await ctx.switchSession(latest.meta.sessionFile, {
		withSession: async (replaced) => {
			replaced.ui.notify(`Attached to "${name}". Press ← on empty input to return to agent board.`, "info");
			installBackToDashboard(replaced, service);
		},
	}).finally(() => {
		try {
			switchingOverlay?.hide();
		} catch {}
	});
	if (result.cancelled) {
		ctx.ui.notify("Attach cancelled.", "warning");
		return { action: "none" };
	}
	return { action: "switched" };
}

async function openPtyAttach(
	ctx: ExtensionCommandContext,
	root: string,
	viewId: string,
	name: string,
	socketPath: string,
): Promise<PtyAttachResult> {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	ctx.ui.setTitle(`agent-board: ${name}`);
	try {
		return await ctx.ui.custom<PtyAttachResult>(
			(tui, theme, keybindings, done) =>
				new PtyAttachComponent(tui, theme as never, keybindings, done, {
					socketPath,
					screenLogPath: root ? screenLogPath(root, viewId) : undefined,
					title: name,
				}),
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

async function showSwitchingOverlay(ctx: ExtensionCommandContext, name: string, reason: string): Promise<{ hide(): void } | null> {
	let handle: { hide(): void } | null = null;
	void ctx.ui.custom<null>(
		(tui, theme) => ({
			render(width: number): string[] {
				const height = tui.terminal?.rows ?? 24;
				const out = Array.from({ length: Math.max(0, Math.floor(height / 2) - 2) }, () => "");
				out.push(clipLine(theme.fg("accent", theme.bold(`Switching to "${name}"…`)), width));
				out.push(clipLine(theme.fg("dim", `Starting fallback session switch (${reason})`), width));
				while (out.length < height) out.push("");
				return out;
			},
			invalidate() {},
		}),
		{
			overlay: true,
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			onHandle: (h) => {
				handle = h;
			},
		},
	);
	await sleep(50);
	return handle;
}

function clipLine(text: string, width: number): string {
	return truncateToWidth(text, width);
}

function installBackToDashboard(ctx: ExtensionCommandContext, service: ReturnType<typeof createService>): void {
	ctx.ui.setStatus("agent-board.back", ctx.ui.theme.fg("muted", "← board"));
	let opening = false;
	ctx.ui.onTerminalInput((data: string) => {
		if (opening || !matchesKey(data, Key.left)) return undefined;
		// Do not steal normal cursor-left while the user is composing a message.
		if (ctx.ui.getEditorText().length > 0) return undefined;
		opening = true;
		void (async () => {
			try {
				let selectedId = currentViewId(ctx, service);
				while (true) {
					service.reconcile();
					const result = await openDashboard(ctx, service, { initialSelectedId: selectedId });
					if (result.action !== "attach") return;
					selectedId = result.viewId;
					const target = service.row(result.viewId);
					const currentSessionFile = ctx.sessionManager.getSessionFile();
					if (target && currentSessionFile && samePath(target.meta.sessionFile, currentSessionFile)) {
						ctx.ui.notify("Already attached to this session.", "info");
						continue;
					}
					const outcome = await attach(ctx, service, service.root, result.viewId, result.stopFirst);
					if (outcome.action === "switched") return;
				}
			} catch (err) {
				ctx.ui.notify(`Couldn't open agent board: ${err instanceof Error ? err.message : String(err)}`, "error");
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
