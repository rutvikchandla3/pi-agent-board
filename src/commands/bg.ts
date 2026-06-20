/** `/bg` command: adopt the current interactive Pi session into Agent Board. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createService } from "../runtime/service.mjs";
import { dashboardAttachLoop } from "./agent-board.js";

export interface BgCommandOptions {
	root: string;
	runnerScript: string;
	ptyRunnerScript?: string;
	titleRunnerScript?: string;
	piCommand: string;
	piArgsPrefix: string[];
	getThinkingLevel: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export function registerBgCommand(pi: ExtensionAPI, opts: BgCommandOptions): void {
	pi.registerCommand("bg", {
		description: "Adopt the current session into Agent Board and optionally queue a prompt",
		handler: async (args, ctx) => {
			await handleBgCommand(args, ctx, opts);
		},
	});
}

async function handleBgCommand(args: string, ctx: ExtensionCommandContext, opts: BgCommandOptions): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/bg requires interactive mode.", "warning");
		return;
	}
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("No current session file is available to background.", "warning");
		return;
	}
	const service = createService({
		root: opts.root,
		runnerScript: opts.runnerScript,
		ptyRunnerScript: opts.ptyRunnerScript,
		titleRunnerScript: opts.titleRunnerScript,
		piCommand: opts.piCommand,
		piArgsPrefix: opts.piArgsPrefix,
		defaultCwd: ctx.cwd,
	});
	const model = modelRef(ctx.model as any);
	const adopted = service.adoptSession({
		sessionFile,
		cwd: ctx.cwd,
		model,
		thinkingLevel: opts.getThinkingLevel(),
		name: "background-session",
	});
	if (!adopted.ok || !adopted.viewId) {
		ctx.ui.notify(adopted.error ?? "Could not background current session.", "warning");
		return;
	}
	const prompt = String(args || "").trim();
	if (prompt) {
		const reply = service.queueFollowUp(adopted.viewId, prompt, { delivery: "queue", source: "bg-command" }) as { ok: boolean; error?: string };
		if (!reply.ok) ctx.ui.notify(reply.error ?? "Could not queue background prompt.", "warning");
		else ctx.ui.notify("Prompt queued for background session.", "info");
	}
	await dashboardAttachLoop(ctx, service, opts.root, adopted.viewId, opts.getThinkingLevel);
}

function modelRef(model: any): string | null {
	if (!model || typeof model !== "object") return null;
	if (typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
	if (typeof model.id === "string") return model.id;
	return null;
}
