/**
 * Reusable attach-flow helpers shared by the `agent-board` and `bg` commands.
 *
 * These are pure logic extractions — no runtime behaviour changes. Every
 * function here was previously private in agent-board.ts.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { createService } from "../runtime/service.mjs";
import { screenLogPath } from "../core/paths.mjs";
import { PtyAttachComponent, type PtyAttachResult } from "../ui/pty-attach.js";
import type { DashboardResult } from "../ui/dashboard.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AttachOutcome = { action: "detached" | "closed" | "switched" | "none" };

/** Open the PTY-attach UI for a live agent session. */
export async function openPtyAttach(
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

/** Show a brief overlay while the session switch is being initiated. */
export async function showSwitchingOverlay(
	ctx: ExtensionCommandContext,
	name: string,
	reason: string,
): Promise<{ hide(): void } | null> {
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

/** Return the viewId of whichever agent session matches the current pi session file. */
export function currentViewId(
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof createService>,
): string | null {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) return null;
	return service.rows().find((r) => samePath(r.meta.sessionFile, currentSessionFile))?.meta.id ?? null;
}

export function samePath(a: string, b: string): boolean {
	return resolve(a) === resolve(b);
}

/**
 * Attach to an agent session, preferring PTY if available and falling back to
 * a session-switch overlay.
 */
export async function attach(
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
		service.markVisited?.(viewId);
		const result = await openPtyAttach(ctx, root, row.meta.id, row.meta.name, target.socketPath);
		service.markVisited?.(viewId);
		return { action: result.action === "closed" ? "closed" : "detached" };
	}

	const ensured = service.ensureHost(viewId);
	if (ensured.ok && ensured.socketPath) {
		service.markVisited?.(viewId);
		const result = await openPtyAttach(ctx, root, row.meta.id, row.meta.name, ensured.socketPath);
		service.markVisited?.(viewId);
		return { action: result.action === "closed" ? "closed" : "detached" };
	}

	const latest = service.row(viewId) ?? row;
	if (!existsSync(latest.meta.sessionFile)) {
		ctx.ui.notify("Session file isn't ready yet — try again once the run has started.", "warning");
		return { action: "none" };
	}
	const name = latest.meta.name;
	service.markVisited?.(viewId);
	const switchingOverlay = await showSwitchingOverlay(ctx, name, ensured.fallbackReason ?? ensured.error ?? "PTY unavailable");
	const result = await ctx.switchSession(latest.meta.sessionFile, {
		withSession: async (replaced) => {
			replaced.ui.notify(`Attached to "${name}". Press ← on empty input to return to agent board.`, "info");
			installBackToDashboard(replaced, service, openDashboardFn);
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

/**
 * The openDashboard function reference used by installBackToDashboard when called
 * from attach(). This is set at module initialisation time by agent-board.ts via
 * setOpenDashboardFn so that attach-flow.ts does not need to import from agent-board.ts
 * (which would create a circular dependency).
 */
type OpenDashboardFn = (
	ctx: Pick<ExtensionCommandContext, "ui" | "cwd" | "modelRegistry" | "model">,
	service: ReturnType<typeof createService>,
	options?: { initialSelectedId?: string | null },
) => Promise<DashboardResult>;

let openDashboardFn: OpenDashboardFn = async () => {
	throw new Error("openDashboardFn not initialised — call setOpenDashboardFn first");
};

/** Called once by agent-board.ts to wire up the openDashboard dependency. */
export function setOpenDashboardFn(fn: OpenDashboardFn): void {
	openDashboardFn = fn;
}

/**
 * Install the ← keybinding that opens the dashboard from inside an attached session.
 * `openDashboard` is accepted as a parameter to avoid a circular import between
 * agent-board.ts and attach-flow.ts.
 */
export function installBackToDashboard(
	ctx: ExtensionCommandContext,
	service: ReturnType<typeof createService>,
	openDashboard: OpenDashboardFn,
): void {
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
					if (selectedId) service.markVisited?.(selectedId);
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
