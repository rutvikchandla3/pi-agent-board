/**
 * The agent-view dashboard: a single full-screen `ctx.ui.custom` component that owns the
 * list, peek/reply, dispatch, filter, rename, and confirm modes plus a live poll loop.
 *
 * It resolves (`done`) only for actions the command handler must run after the surface
 * closes — attaching to a session (tears down the current session) or quitting. Everything
 * else (dispatch, reply, stop, pin, rename, archive) is handled in-place against the store.
 */
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { truncate } from "../core/heuristics.mjs";
import { filterRows, groupRows, rowState, stateColor, stateGlyph } from "../core/rows.mjs";
import { loadSessionView } from "../core/session-view.mjs";
import type { Row } from "../core/store.mjs";
import type { createService } from "../runtime/service.mjs";

type Service = ReturnType<typeof createService>;

interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	strikethrough(text: string): string;
}

export type DashboardResult = { action: "exit" } | { action: "attach"; viewId: string; stopFirst: boolean };

type Mode = "list" | "dispatch" | "filter" | "peek" | "reply" | "rename" | "confirm" | "help" | "session";

interface PendingConfirm {
	prompt: string;
	onYes: () => void;
}

export interface DashboardDeps {
	service: Service;
	defaultCwd: string;
}

export class DashboardComponent implements Component {
	private mode: Mode = "list";
	private rows: Row[] = [];
	private orderedIds: string[] = [];
	private selectedId: string | null = null;
	private input = "";
	private filterQuery = "";
	private worktreeNext = false;
	private pending: PendingConfirm | null = null;
	private peekId: string | null = null;
	private scrollTop = 0;
	private sessionScrollTop = 0;
	private flash: { text: string; level: "info" | "warning" | "error" } | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		_keybindings: KeybindingsManager,
		private readonly done: (result: DashboardResult) => void,
		private readonly deps: DashboardDeps,
	) {
		void _keybindings;
		this.refresh();
	}

	// ---- data ---------------------------------------------------------------

	refresh(): void {
		const all = this.deps.service.rows();
		this.rows = this.filterQuery ? filterRows(all, this.filterQuery) : all;
		const groups = groupRows(this.rows, Date.now());
		this.orderedIds = groups.flatMap((g) => g.rows.map((r) => r.id));
		if (this.orderedIds.length === 0) {
			this.selectedId = null;
		} else if (!this.selectedId || !this.orderedIds.includes(this.selectedId)) {
			this.selectedId = this.orderedIds[0];
		}
	}

	private selectedRow(): Row | null {
		const id = this.mode === "peek" || this.mode === "reply" ? this.peekId : this.selectedId;
		return id ? (this.rows.find((r) => r.meta.id === id) ?? this.deps.service.row(id)) : null;
	}

	private moveSelection(delta: number): void {
		if (this.orderedIds.length === 0) return;
		const cur = this.selectedId ? this.orderedIds.indexOf(this.selectedId) : 0;
		const next = Math.max(0, Math.min(this.orderedIds.length - 1, (cur < 0 ? 0 : cur) + delta));
		this.selectedId = this.orderedIds[next];
	}

	private notice(text: string, level: "info" | "warning" | "error" = "info"): void {
		this.flash = { text, level };
	}

	// ---- input --------------------------------------------------------------

	handleInput(data: string): void {
		switch (this.mode) {
			case "list":
				this.handleListKey(data);
				break;
			case "dispatch":
				this.handleTextMode(data, () => this.submitDispatch(), () => this.toListMode(), { tabToggle: true });
				break;
			case "filter":
				this.handleTextMode(data, () => this.toListMode(), () => this.clearFilter(), { live: true });
				break;
			case "rename":
				this.handleTextMode(data, () => this.submitRename(), () => this.toListMode());
				break;
			case "reply":
				this.handleTextMode(data, () => this.submitReply(), () => (this.mode = "peek"));
				break;
			case "peek":
				this.handlePeekKey(data);
				break;
			case "session":
				this.handleSessionKey(data);
				break;
			case "confirm":
				this.handleConfirmKey(data);
				break;
			case "help":
				this.mode = "list";
				break;
		}
		this.tui.requestRender();
	}

	private handleListKey(data: string): void {
		if (matchesKey(data, Key.up)) return void this.moveSelection(-1);
		if (matchesKey(data, Key.down)) return void this.moveSelection(1);
		if (matchesKey(data, Key.right) || data === ">") return this.openSessionView();
		if (matchesKey(data, Key.enter)) {
			if (this.input.trim()) return this.submitDispatch();
			return this.attachSelected();
		}
		if (matchesKey(data, Key.tab)) {
			this.worktreeNext = !this.worktreeNext;
			return;
		}
		if (matchesKey(data, Key.space)) {
			if (this.input.length === 0) return this.openPeek();
			this.input += " ";
			return;
		}
		if (data === "/" && this.input.length === 0) return void (this.mode = "filter");
		if (data === "?" && this.input.length === 0) return void (this.mode = "help");
		if (matchesKey(data, Key.ctrl("r"))) return this.startRename();
		if (matchesKey(data, Key.ctrl("t"))) return this.togglePin();
		if (matchesKey(data, Key.ctrl("s"))) return this.stopSelected();
		if (matchesKey(data, Key.ctrl("x"))) return this.confirmDelete();
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.input = this.input.slice(0, -1);
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.input = "";
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.input.length > 0) {
				this.input = "";
				return;
			}
			return this.done({ action: "exit" });
		}
		if (isPrintable(data)) this.input += data;
	}

	private handlePeekKey(data: string): void {
		if (matchesKey(data, Key.escape)) return void (this.mode = "list");
		if (matchesKey(data, Key.right) || data === ">") return this.openSessionView();
		if (matchesKey(data, Key.up)) {
			this.peekStep(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.peekStep(1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "r") return void (this.mode = "reply");
		if (data === "a") return this.attachPeek();
	}

	private handleSessionKey(data: string): void {
		const termRows = this.tui.terminal?.rows ?? 24;
		const page = Math.max(1, termRows - 8);
		if (matchesKey(data, Key.left) || matchesKey(data, Key.escape) || data === "<") {
			this.mode = "list";
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.sessionScrollTop = Math.max(0, this.sessionScrollTop - 1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.sessionScrollTop += 1;
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.sessionScrollTop = Math.max(0, this.sessionScrollTop - page);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.sessionScrollTop += page;
			return;
		}
		if (matchesKey(data, Key.space)) return this.openPeek();
		if (data === "r") {
			this.peekId = this.selectedId;
			this.mode = "reply";
			return;
		}
		if (data === "a" || matchesKey(data, Key.enter)) return this.attachSelected();
	}

	private handleConfirmKey(data: string): void {
		if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
			const action = this.pending?.onYes;
			this.pending = null;
			this.mode = "list";
			action?.();
			return;
		}
		// any other key cancels
		this.pending = null;
		this.mode = "list";
	}

	/** Shared text-editing for input modes. */
	private handleTextMode(
		data: string,
		onSubmit: () => void,
		onCancel: () => void,
		opts: { live?: boolean; tabToggle?: boolean } = {},
	): void {
		if (matchesKey(data, Key.enter)) return onSubmit();
		if (matchesKey(data, Key.escape)) return onCancel();
		if (opts.tabToggle && matchesKey(data, Key.tab)) {
			this.worktreeNext = !this.worktreeNext;
			return;
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.input = this.input.slice(0, -1);
		} else if (matchesKey(data, Key.ctrl("u"))) {
			this.input = "";
		} else if (isPrintable(data)) {
			this.input += data;
		}
		if (opts.live) {
			this.filterQuery = this.input;
			this.refresh();
		}
	}

	// ---- actions ------------------------------------------------------------

	private toListMode(): void {
		this.input = "";
		this.mode = "list";
	}

	private clearFilter(): void {
		this.input = "";
		this.filterQuery = "";
		this.refresh();
		this.mode = "list";
	}

	private submitDispatch(): void {
		const text = this.input.trim();
		if (!text) return this.toListMode();
		const res = this.deps.service.dispatch(text, { cwd: this.deps.defaultCwd, worktree: this.worktreeNext });
		if (!res.ok) this.notice(res.error ?? "Dispatch failed", "error");
		else {
			this.selectedId = res.viewId ?? this.selectedId;
			this.notice(`Dispatched${res.usedWorktree ? " (worktree)" : ""}: ${truncate(text, 40)}`, "info");
		}
		this.input = "";
		this.worktreeNext = false;
		this.mode = "list";
		this.refresh();
	}

	private submitReply(): void {
		const text = this.input.trim();
		const row = this.selectedRow();
		if (!text || !row) {
			this.mode = "peek";
			this.input = "";
			return;
		}
		const res = this.deps.service.reply(row.meta.id, text);
		if (!res.ok) this.notice(res.error ?? "Reply failed", "error");
		else this.notice("Reply sent", "info");
		this.input = "";
		this.mode = "peek";
		this.refresh();
	}

	private submitRename(): void {
		const name = this.input.trim();
		if (name && this.selectedId) {
			const res = this.deps.service.rename(this.selectedId, name);
			if (!res.ok) this.notice(res.error ?? "Rename failed", "error");
		}
		this.toListMode();
		this.refresh();
	}

	private startRename(): void {
		const row = this.selectedRow();
		if (!row) return;
		this.input = row.meta.name;
		this.mode = "rename";
	}

	private togglePin(): void {
		const row = this.selectedRow();
		if (!row) return;
		this.deps.service.setPinned(row.meta.id, !row.meta.pinned);
		this.refresh();
	}

	private stopSelected(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (!row.alive) return this.notice("No active run to stop", "warning");
		const res = this.deps.service.stop(row.meta.id);
		this.notice(res.ok ? "Stopping…" : (res.error ?? "Stop failed"), res.ok ? "info" : "warning");
	}

	private confirmDelete(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.alive) return this.notice("Stop the run before deleting", "warning");
		const hasWorktree = row.meta.worktreeMode === "worktree" && !!row.meta.worktreePath;
		this.pending = {
			prompt: `Delete "${row.meta.name}"? Session file is preserved.${hasWorktree ? " Worktree will be removed." : ""} (y/N)`,
			onYes: () => {
				const res = this.deps.service.archive(row.meta.id, { removeWorktree: hasWorktree });
				if (!res.ok) this.notice(res.error ?? "Delete failed", "error");
				else this.notice("Deleted", "info");
				this.refresh();
			},
		};
		this.mode = "confirm";
	}

	private openPeek(): void {
		if (!this.selectedId) return;
		this.peekId = this.selectedId;
		this.mode = "peek";
	}

	private openSessionView(): void {
		if (!this.selectedId) return;
		this.sessionScrollTop = 0;
		this.mode = "session";
	}

	private peekStep(delta: number): void {
		if (!this.peekId) return;
		const idx = this.orderedIds.indexOf(this.peekId);
		if (idx < 0) return;
		const next = Math.max(0, Math.min(this.orderedIds.length - 1, idx + delta));
		this.peekId = this.orderedIds[next];
		this.selectedId = this.peekId;
	}

	private attachSelected(): void {
		const row = this.selectedRow();
		if (!row) return;
		this.requestAttach(row);
	}

	private attachPeek(): void {
		const row = this.selectedRow();
		if (row) this.requestAttach(row);
	}

	private requestAttach(row: Row): void {
		if (row.alive) {
			this.pending = {
				prompt: `"${row.meta.name}" is running. Interrupt and attach? (y/N)`,
				onYes: () => this.done({ action: "attach", viewId: row.meta.id, stopFirst: true }),
			};
			this.mode = "confirm";
		} else {
			this.done({ action: "attach", viewId: row.meta.id, stopFirst: false });
		}
	}

	// ---- rendering ----------------------------------------------------------

	invalidate(): void {
		/* stateless render; nothing cached */
	}

	dispose(): void {
		/* poll interval is owned by the factory */
	}

	render(width: number): string[] {
		const t = this.theme;
		const allRows = this.deps.service.rows();
		const needs = allRows.filter((r) => r.state?.semanticState === "needs_input").length;
		const working = allRows.filter((r) => r.alive).length;
		const completed = allRows.filter((r) => r.state?.semanticState === "completed").length;
		const lines: string[] = [];

		// Header
		lines.push(clip(t.fg("accent", t.bold("Agent View")), width));
		lines.push(clip(t.fg("muted", displayPath(this.deps.defaultCwd)), width));
		let summary = `${needs} awaiting input · ${working} working · ${completed} completed`;
		if (this.filterQuery) summary += ` · filter:${this.filterQuery}`;
		lines.push(clip(t.fg(this.filterQuery ? "warning" : "dim", summary), width));
		if (this.flash) lines.push(clip(t.fg(flashColor(this.flash.level), this.flash.text), width));
		lines.push(t.fg("dim", "─".repeat(width)));

		if (this.mode === "help") return lines.concat(this.renderHelp(width));
		if (this.mode === "peek" || this.mode === "reply") return lines.concat(this.renderPeek(width));
		if (this.mode === "session") return lines.concat(this.renderSession(width));

		// Body: grouped rows with a scroll viewport.
		const capacity = Math.max(3, (this.tui.terminal?.rows ?? 24) - lines.length - 3);
		const body = this.renderRows(width);
		const windowed = this.windowBody(body, capacity);
		lines.push(...windowed.lines);

		// Footer / input
		lines.push(t.fg("dim", "─".repeat(width)));
		if (this.mode === "list" || this.mode === "dispatch") {
			lines.push(clip(this.taskInputLine(width), width));
			lines.push(clip(this.listHints(), width));
		} else if (this.mode === "filter") {
			lines.push(clip(`${t.fg("warning", "filter› ")}${this.input}${cursor()}`, width));
			lines.push(clip(t.fg("dim", "type s:<state> or text · enter apply · esc clear"), width));
		} else if (this.mode === "rename") {
			lines.push(clip(`${t.fg("accent", "rename› ")}${this.input}${cursor()}`, width));
			lines.push(clip(t.fg("dim", "enter save · esc cancel"), width));
		} else if (this.mode === "confirm" && this.pending) {
			lines.push(clip(t.fg("warning", this.pending.prompt), width));
		} else {
			lines.push(clip(this.listHints(), width));
		}
		return lines;
	}

	private listHints(): string {
		const t = this.theme;
		return t.fg(
			"dim",
			`enter create${this.input.trim() ? "" : "/attach"} · tab worktree:${this.worktreeNext ? "on" : "off"} · ↑↓ move · →/> session · ctrl+r rename · ctrl+t pin · ctrl+s stop · ctrl+x del · / filter · ? help`,
		);
	}

	private taskInputLine(width: number): string {
		const t = this.theme;
		if (this.input.length === 0) {
			return `${t.fg("accent", "› ")}${t.fg("muted", "describe a task for a new session")}${cursor()}`;
		}
		return `${t.fg("accent", "› ")}${this.input}${cursor()}`;
	}

	private renderRows(width: number): string[] {
		const t = this.theme;
		if (this.rows.length === 0) {
			return [t.fg("muted", this.filterQuery ? "  No sessions match the filter." : "  No background sessions yet. Type below and press Enter.")];
		}
		const now = Date.now();
		const groups = groupRows(this.rows, now);
		const out: string[] = [];
		for (const g of groups) {
			out.push(t.fg(stateColor(g.state), `▌ ${g.label} (${g.rows.length})`));
			for (const rv of g.rows) {
				out.push(this.renderRow(rv, width));
			}
		}
		return out;
	}

	private renderRow(rv: ReturnType<typeof import("../core/rows.mjs")["rowView"]>, width: number): string {
		const t = this.theme;
		const selected = rv.id === this.selectedId;
		const glyph = t.fg(stateColor(rv.state), stateGlyph(rv.state, rv.alive));
		const pin = rv.pinned ? t.fg("warning", "★") : " ";
		const name = truncate(rv.name, 22).padEnd(22);
		const meta = ` ${rv.age.padStart(3)} ${truncate(rv.place, 14)}`;
		const metaW = visibleWidth(meta) + 4;
		const summaryW = Math.max(8, width - 22 - metaW - 4);
		const summary = truncate(rv.summary, summaryW);
		const prefix = selected ? t.fg("accent", "›") : " ";
		let line = `${prefix}${pin}${glyph} ${t.fg(selected ? "accent" : "text", name)} ${t.fg("muted", summary)}`;
		line = padTo(line, width - visibleWidth(meta) - 1);
		line += t.fg("dim", meta);
		return clip(line, width);
	}

	private renderPeek(width: number): string[] {
		const t = this.theme;
		const row = this.selectedRow();
		if (!row) return [t.fg("muted", "  (no session)")];
		const st = rowState(row);
		const out: string[] = [];
		out.push(`${t.fg(stateColor(st), stateGlyph(st, row.alive))} ${t.fg("accent", t.bold(row.meta.name))} ${t.fg("muted", `[${st}${row.alive ? " · alive" : ""}]`)}`);
		out.push(t.fg("dim", `  ${row.meta.repoCwd}${row.meta.worktreeMode === "worktree" ? "  (worktree)" : ""}`));
		out.push("");
		out.push(t.fg("muted", "Summary"));
		out.push(clip(`  ${row.state?.summary ?? "—"}`, width));
		if (row.state?.question) {
			out.push("");
			out.push(t.fg("warning", "Question / blocker"));
			out.push(...wrap(`  ${row.state.question}`, width));
		}
		out.push("");
		out.push(t.fg("muted", "Latest output"));
		out.push(...wrap(`  ${row.state?.latestAssistantPreview || "—"}`, width, 8));
		if (row.state?.error) {
			out.push("");
			out.push(t.fg("error", "Error"));
			out.push(...wrap(`  ${row.state.error}`, width, 4));
		}
		out.push(t.fg("dim", "─".repeat(width)));
		if (this.mode === "reply") {
			out.push(clip(`${t.fg("accent", "reply› ")}${this.input}${cursor()}`, width));
			out.push(clip(t.fg("dim", "enter send · esc back"), width));
		} else {
			out.push(clip(t.fg("dim", "↑↓ prev/next · →/> session view · r reply · a attach · esc back"), width));
		}
		return out;
	}

	private renderSession(width: number): string[] {
		const t = this.theme;
		const row = this.selectedRow();
		if (!row) return [t.fg("muted", "  (no session)")];
		const st = rowState(row);
		const out: string[] = [];
		const session = loadSessionView(row.meta.sessionFile);
		out.push(`${t.fg(stateColor(st), stateGlyph(st, row.alive))} ${t.fg("accent", t.bold(row.meta.name))} ${t.fg("muted", `[session view${row.alive ? " · live" : ""}]`)}`);
		out.push(t.fg("dim", `  ${row.meta.repoCwd}${row.meta.worktreeMode === "worktree" ? "  (worktree)" : ""}`));
		if (session.header?.cwd && session.header.cwd !== row.meta.repoCwd) {
			out.push(t.fg("dim", `  session cwd: ${session.header.cwd}`));
		}
		out.push("");

		const body: string[] = [];
		if (session.error) {
			body.push(t.fg("error", `  ${session.error}`));
		} else if (session.items.length === 0) {
			body.push(t.fg("muted", "  Session transcript empty yet."));
		} else {
			for (const item of session.items) {
				body.push(this.renderSessionItemLabel(item, width));
				body.push(...wrap(`  ${item.text}`, width, 10_000));
				body.push("");
			}
			if (body[body.length - 1] === "") body.pop();
		}

		const capacity = Math.max(3, (this.tui.terminal?.rows ?? 24) - out.length - 3);
		out.push(...this.windowSession(body, capacity));
		out.push(t.fg("dim", "─".repeat(width)));
		out.push(clip(t.fg("dim", "←/< back · ↑↓ scroll · pgup/pgdn page · enter attach · r reply · space peek"), width));
		return out;
	}

	private renderSessionItemLabel(item: ReturnType<typeof loadSessionView>["items"][number], width: number): string {
		const t = this.theme;
		const label = `  ${item.label}`;
		switch (item.role) {
			case "user":
				return clip(t.fg("accent", label), width);
			case "assistant":
				return clip(t.fg("success", label), width);
			case "custom":
				return clip(t.fg("warning", label), width);
			default:
				return clip(t.fg("muted", label), width);
		}
	}

	private renderHelp(width: number): string[] {
		const t = this.theme;
		const rows: Array<[string, string]> = [
			["type + enter", "Create a new Pi session from the input box"],
			["enter", "Attach to selected session when input is empty"],
			["↑/↓", "Move selection"],
			["→ or >", "Open selected session in full-screen session view"],
			["space", "Peek when input is empty; otherwise inserts a space"],
			["tab", "Toggle worktree for the next dispatch"],
			["/", "Filter (s:<state> or free text)"],
			["ctrl+r/t/s/x", "Rename · pin · stop · delete"],
			["In peek", "→ session view · r reply · a attach · ↑↓ adjacent"],
			["In session", "← back · ↑↓ scroll · enter attach · r reply"],
			["esc", "Clear input; if empty, quit standalone dashboard"],
		];
		const out = [t.fg("accent", t.bold("  Keys"))];
		for (const [k, v] of rows) out.push(clip(`  ${t.fg("accent", k.padEnd(14))} ${t.fg("muted", v)}`, width));
		out.push("");
		out.push(clip(t.fg("dim", "  press any key to return"), width));
		return out;
	}

	/** Keep the selected row visible within `capacity` lines, with scroll markers. */
	private windowBody(body: string[], capacity: number): { lines: string[] } {
		if (body.length <= capacity) {
			this.scrollTop = 0;
			return { lines: body };
		}
		// Find the line index of the selected row (best effort: match its rendered prefix).
		let selLine = 0;
		if (this.selectedId) {
			const idx = body.findIndex((l) => l.includes("›"));
			selLine = idx >= 0 ? idx : 0;
		}
		if (selLine < this.scrollTop) this.scrollTop = selLine;
		if (selLine >= this.scrollTop + capacity - 1) this.scrollTop = selLine - capacity + 2;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, body.length - capacity));
		const slice = body.slice(this.scrollTop, this.scrollTop + capacity);
		const more = body.length - this.scrollTop - capacity;
		if (this.scrollTop > 0) slice[0] = this.theme.fg("dim", `  ↑ ${this.scrollTop} more`);
		if (more > 0) slice[slice.length - 1] = this.theme.fg("dim", `  ↓ ${more} more`);
		return { lines: slice };
	}

	private windowSession(body: string[], capacity: number): string[] {
		if (body.length <= capacity) {
			this.sessionScrollTop = 0;
			return body;
		}
		this.sessionScrollTop = Math.max(0, Math.min(this.sessionScrollTop, body.length - capacity));
		const slice = body.slice(this.sessionScrollTop, this.sessionScrollTop + capacity);
		const more = body.length - this.sessionScrollTop - capacity;
		if (this.sessionScrollTop > 0) slice[0] = this.theme.fg("dim", `  ↑ ${this.sessionScrollTop} more`);
		if (more > 0) slice[slice.length - 1] = this.theme.fg("dim", `  ↓ ${more} more`);
		return slice;
	}
}

// ---- helpers --------------------------------------------------------------

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	// Accept multi-char paste of printable text; reject control/escape sequences.
	return [...data].every((ch) => ch >= " " && ch !== "\x7f");
}

function cursor(): string {
	return "\x1b[7m \x1b[27m";
}

function clip(line: string, width: number): string {
	return truncateToWidth(line, width, "");
}

function padTo(line: string, width: number): string {
	const w = visibleWidth(line);
	return w >= width ? line : line + " ".repeat(width - w);
}

function wrap(text: string, width: number, max = 6): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		if (visibleWidth(cur) + visibleWidth(word) + 1 > width) {
			lines.push(cur);
			cur = `  ${word}`;
		} else {
			cur = cur ? `${cur} ${word}` : word;
		}
		if (lines.length >= max) break;
	}
	if (cur && lines.length < max) lines.push(cur);
	return lines.map((l) => clip(l, width));
}

function displayPath(path: string): string {
	const home = process.env.HOME;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}` || "~";
	return path;
}

function flashColor(level: "info" | "warning" | "error"): string {
	switch (level) {
		case "warning":
			return "warning";
		case "error":
			return "error";
		default:
			return "success";
	}
}
