/**
 * The agent-view dashboard: a single full-screen `ctx.ui.custom` component that owns the
 * list, peek/reply, dispatch, filter, rename, and confirm modes plus a live poll loop.
 *
 * It resolves (`done`) only for actions the command handler must run after the surface
 * closes — attaching to a session (tears down the current session) or quitting. Everything
 * else (dispatch, reply, stop, pin, rename, archive) is handled in-place against the store.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { firstSentence, truncate } from "../core/heuristics.mjs";
import { filterRows, groupRows, rowState, stateGlyph } from "../core/rows.mjs";
import { loadSessionView } from "../core/session-view.mjs";
import { GROUP_LABELS } from "../core/types.mjs";
import { readState, writeState, type Row } from "../core/store.mjs";
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

type InputNoticeColor = "accent" | "success" | "warning" | "muted" | "dim";
type FlashLevel = "info" | "warn" | "error";

interface InputNotice {
	text: string;
	color: InputNoticeColor;
	expiresAt: number;
}

export interface DashboardDeps {
	service: Service;
	defaultCwd: string;
	initialSelectedId?: string | null;
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
	private prewarmedId: string | null = null;
	private flash: { text: string; level: FlashLevel } | null = null;
	private inputNotice: InputNotice | null = null;
	private readonly editor: CustomEditor;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		keybindings: KeybindingsManager,
		private readonly done: (result: DashboardResult) => void,
		private readonly deps: DashboardDeps,
	) {
		this.editor = new CustomEditor(tui, editorTheme(theme), keybindings as never, { paddingX: 0 });
		this.editor.onChange = (text) => {
			this.input = text;
			if (this.mode === "filter") {
				this.filterQuery = text;
				this.refresh();
			}
		};
		this.editor.onSubmit = (text) => this.submitEditor(text);
		this.selectedId = deps.initialSelectedId ?? null;
		this.refresh();
		this.prewarmSelected();
	}

	// ---- data ---------------------------------------------------------------

	refresh(): void {
		const previousSelected = this.selectedId;
		const all = this.deps.service.rows();
		this.rows = this.filterQuery ? filterRows(all, this.filterQuery) : all;
		const groups = groupRows(this.rows, Date.now());
		this.orderedIds = groups.flatMap((g) => g.rows.map((r) => r.id));
		if (this.orderedIds.length === 0) {
			this.selectedId = null;
		} else if (!this.selectedId || !this.orderedIds.includes(this.selectedId)) {
			this.selectedId = this.orderedIds[0];
		}
		if (this.selectedId && this.selectedId !== previousSelected) this.prewarmSelected();
	}

	private selectedRow(): Row | null {
		const id = this.mode === "peek" || this.mode === "reply" ? this.peekId : this.selectedId;
		return id ? (this.rows.find((r) => r.meta.id === id) ?? this.deps.service.row(id)) : null;
	}

	private moveSelection(delta: number): void {
		if (this.orderedIds.length === 0) return;
		const cur = this.selectedId ? this.orderedIds.indexOf(this.selectedId) : 0;
		const next = Math.max(0, Math.min(this.orderedIds.length - 1, (cur < 0 ? 0 : cur) + delta));
		const nextId = this.orderedIds[next];
		if (nextId === this.selectedId) return;
		this.selectedId = nextId;
		this.prewarmSelected();
	}

	private prewarmSelected(): void {
		const id = this.selectedId;
		if (!id || id === this.prewarmedId) return;
		const row = this.selectedRow();
		if (!row || row.hostAlive || isAgentBusy(row)) return;
		const res = this.deps.service.prewarmHost?.(id);
		if (res?.ok) this.prewarmedId = id;
	}

	private notice(text: string, level: FlashLevel = "info"): void {
		this.flash = { text, level };
	}

	private notifyInputState(text: string, color: InputNoticeColor): void {
		this.inputNotice = { text, color, expiresAt: Date.now() + 3_000 };
	}

	private currentInputNotice(): InputNotice | null {
		if (this.inputNotice && this.inputNotice.expiresAt <= Date.now()) this.inputNotice = null;
		return this.inputNotice;
	}

	// ---- input --------------------------------------------------------------

	handleInput(data: string): void {
		switch (this.mode) {
			case "list":
				this.handleListKey(data);
				break;
			case "dispatch":
				this.handleTextMode(data, () => this.submitDispatch(), () => this.leaveDispatchMode(), { tabToggle: true });
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
		this.requestFullRender();
	}

	private requestFullRender(): void {
		// The dashboard replaces the user's whole mental screen, but Pi's custom UI
		// renderer is still embedded in the interactive TUI/scrollback. Differential
		// redraw can append repeated dashboard snapshots when the viewport/cursor has
		// drifted (notably on ↑/↓). Force a clear+home redraw for dashboard updates.
		this.tui.requestRender(true);
	}

	private handleListKey(data: string): void {
		if (matchesKey(data, Key.up)) return void this.moveSelection(-1);
		if (matchesKey(data, Key.down)) return void this.moveSelection(1);
		if (matchesKey(data, Key.right) || data === ">") return this.attachSelected();
		if (data === "v") return this.openSessionView();
		if (matchesKey(data, Key.enter)) {
			if (this.input.trim()) return this.submitDispatch();
			return this.attachSelected();
		}
		if (matchesKey(data, Key.tab)) {
			this.worktreeNext = !this.worktreeNext;
			return;
		}
		if (matchesKey(data, Key.space)) return this.openPeek();
		if (data === "/") return this.startFilter();
		if (data === "?") return void (this.mode = "help");
		if (data === "i") return this.startDispatch();
		if (matchesKey(data, Key.ctrl("r"))) return this.startRename();
		if (matchesKey(data, Key.ctrl("t"))) return this.togglePin();
		if (matchesKey(data, Key.ctrl("s"))) return this.stopSelected();
		if (data === "d") return this.confirmDone();
		if (matchesKey(data, Key.ctrl("x"))) return this.confirmDelete();
		if (data === "X") return this.confirmDeleteState();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.input.length > 0) {
				this.setInput("");
				return;
			}
			return this.done({ action: "exit" });
		}
		if (isPrintable(data) || isBracketedPaste(data)) {
			this.notifyInputState("Press i to enter INSERT mode, then type or paste", "accent");
			return;
		}
	}

	private handlePeekKey(data: string): void {
		if (matchesKey(data, Key.escape)) return void (this.mode = "list");
		if (matchesKey(data, Key.right) || data === ">") return this.attachPeek();
		if (data === "v") return this.openSessionView();
		if (matchesKey(data, Key.up)) {
			this.peekStep(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.peekStep(1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "r") return this.startReply();
		if (data === "d") return this.confirmDone();
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
			this.startReply();
			return;
		}
		if (data === "d") return this.confirmDone();
		if (data === "a" || matchesKey(data, Key.enter)) return this.attachSelected();
	}

	private handleConfirmKey(data: string): void {
		if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
			const action = this.pending?.onYes;
			this.pending = null;
			this.mode = "list";
			try {
				action?.();
			} catch (err) {
				this.notice(err instanceof Error ? err.message : String(err), "error");
			}
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
		void opts.live; // live filtering is driven by editor.onChange.
		if (matchesKey(data, Key.enter)) return onSubmit();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return onCancel();
		if (opts.tabToggle && matchesKey(data, Key.tab)) {
			this.worktreeNext = !this.worktreeNext;
			return;
		}
		this.handleEditorInput(data);
	}

	private handleEditorInput(data: string): void {
		this.editor.handleInput(data);
		this.input = this.editor.getText();
	}

	private startDispatch(initialText = ""): void {
		this.mode = "dispatch";
		this.notifyInputState("INSERT mode — dashboard shortcuts paused; / is literal", "success");
		if (initialText) this.handleEditorInput(initialText);
	}

	private leaveDispatchMode(): void {
		this.mode = "list";
		this.notifyInputState(this.input.trim() ? "NORMAL mode — draft kept; Enter dispatches" : "NORMAL mode — dashboard shortcuts active", "muted");
	}

	private setInput(text: string): void {
		this.input = text;
		this.editor.setText(text);
	}

	private submitEditor(textOverride?: string): void {
		if (textOverride !== undefined) this.input = textOverride;
		switch (this.mode) {
			case "filter":
				return this.toListMode();
			case "rename":
				return this.submitRename();
			case "reply":
				return this.submitReply();
			case "list":
			case "dispatch":
				return this.input.trim() ? this.submitDispatch() : this.attachSelected();
		}
	}

	// ---- actions ------------------------------------------------------------

	private toListMode(): void {
		this.mode = "list";
		this.setInput("");
	}

	private startFilter(): void {
		this.setInput(this.filterQuery);
		this.mode = "filter";
		this.notifyInputState("FILTER mode — type query; Esc clears", "warning");
	}

	private clearFilter(): void {
		this.setInput("");
		this.filterQuery = "";
		this.refresh();
		this.mode = "list";
		this.notifyInputState("Filter cleared — NORMAL mode", "muted");
	}

	private submitDispatch(): void {
		const text = this.input.trim();
		if (!text) return this.toListMode();
		const res = this.deps.service.dispatch(text, { cwd: this.deps.defaultCwd, worktree: this.worktreeNext });
		if (!res.ok) this.notice(res.error ?? "Dispatch failed", "error");
		else {
			this.selectedId = res.viewId ?? this.selectedId;
			if (res.hostMode === "json-runner") {
				this.notice(`Dispatched with non-live fallback${res.usedWorktree ? " (worktree)" : ""}: ${res.fallbackReason ?? "PTY unavailable"}`, "warn");
			} else {
				this.notice(`Dispatched${res.usedWorktree ? " (worktree)" : ""}: ${truncate(text, 40)}`, "info");
			}
		}
		this.setInput("");
		this.worktreeNext = false;
		this.mode = "list";
		this.inputNotice = null;
		this.refresh();
	}

	private submitReply(): void {
		const text = this.input.trim();
		const row = this.selectedRow();
		if (!text || !row) {
			this.mode = "peek";
			this.setInput("");
			return;
		}
		const res = this.deps.service.reply(row.meta.id, text);
		if (!res.ok) this.notice(res.error ?? "Reply failed", "error");
		else if (res.hostMode === "json-runner") this.notice(`Reply sent with non-live fallback: ${res.fallbackReason ?? "PTY unavailable"}`, "warn");
		else this.notice("Reply sent", "info");
		this.setInput("");
		this.mode = "peek";
		this.inputNotice = null;
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
		this.setInput(row.meta.name);
		this.mode = "rename";
		this.notifyInputState("RENAME mode — Enter saves; Esc cancels", "accent");
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
		if (!row.alive && !row.hostAlive) return this.notice("No active run or host to stop", "warn");
		const res = this.deps.service.stop(row.meta.id);
		this.notice(res.ok ? "Stopping…" : (res.error ?? "Stop failed"), res.ok ? "info" : "warn");
	}

	private confirmDone(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (isAgentBusy(row)) return this.notice("Wait for the active run to finish before marking done", "warn");
		if (row.state?.semanticState === "completed") return this.notice("Already marked done", "info");
		this.pending = {
			prompt: `Mark "${row.meta.name}" as done? (y/N)`,
			onYes: () => {
				const res = this.markCompleted(row);
				if (!res.ok) this.notice(res.error ?? "Mark done failed", "error");
				else this.notice("Marked done", "info");
				this.refresh();
			},
		};
		this.mode = "confirm";
	}

	private markCompleted(row: Row): { ok: boolean; error?: string } {
		const service = this.deps.service as Service & { markCompleted?: (viewId: string) => { ok: boolean; error?: string } };
		if (typeof service.markCompleted === "function") return service.markCompleted(row.meta.id);

		// Compatibility guard for an already-open dashboard whose service object came
		// from an older module instance. The service owns this path normally.
		const state = readState(service.root, row.meta.id) ?? row.state ?? {
			version: 1,
			viewId: row.meta.id,
			currentRunId: null,
			semanticState: "idle",
			processState: "exited",
			summary: "Idle",
			lastActivityAt: Date.now(),
			updatedAt: Date.now(),
			needsInput: false,
			hasError: false,
			latestAssistantPreview: "",
			latestTool: null,
			question: null,
			error: null,
		};
		state.semanticState = "completed";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.error = null;
		state.summary = completedSummary(state.summary, state.latestAssistantPreview);
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(service.root, state);
		return { ok: true };
	}

	private confirmDelete(): void {
		const row = this.selectedRow();
		if (!row) return;
		const hasWorktree = row.meta.worktreeMode === "worktree" && !!row.meta.worktreePath;
		const busy = isAgentBusy(row);
		this.pending = {
			prompt: `Delete "${row.meta.name}"?${busy ? " Active run will be stopped." : ""} Session file is preserved.${hasWorktree ? " Worktree will be removed." : ""} (y/N)`,
			onYes: () => {
				const res = this.deps.service.archive(row.meta.id, { removeWorktree: hasWorktree });
				if (!res.ok) this.notice(res.error ?? "Delete failed", "error");
				else this.notice("Deleted", "info");
				this.refresh();
			},
		};
		this.mode = "confirm";
	}

	private confirmDeleteState(): void {
		const row = this.selectedRow();
		if (!row) return;
		const state = rowState(row);
		const matching = this.deps.service.rows().filter((r) => rowState(r) === state);
		const deletable = matching.filter((r) => !isAgentBusy(r)).length;
		const skipped = matching.length - deletable;
		if (deletable === 0) return this.notice(`No inactive ${GROUP_LABELS[state].toLowerCase()} sessions to delete`, "warn");
		this.pending = {
			prompt: `Delete ${deletable} ${GROUP_LABELS[state].toLowerCase()} session${deletable === 1 ? "" : "s"}?${skipped ? ` ${skipped} live skipped.` : ""} (y/N)`,
			onYes: () => {
				const res = this.deps.service.archiveByState(state);
				if (!res.ok) this.notice(res.error ?? "Delete failed", "error");
				else this.notice(`Deleted ${res.archived}${res.skipped ? ` · skipped ${res.skipped} live` : ""}`, "info");
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

	private startReply(): void {
		this.peekId = this.peekId ?? this.selectedId;
		this.setInput("");
		this.mode = "reply";
		this.notifyInputState("REPLY INSERT mode — arrows edit; Esc returns to peek", "success");
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
		if (row.hostAlive) {
			this.done({ action: "attach", viewId: row.meta.id, stopFirst: false });
		} else if (isAgentBusy(row)) {
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
		const working = allRows.filter((r) => r.state?.semanticState === "working").length;
		const completed = allRows.filter((r) => r.state?.semanticState === "completed").length;
		const lines: string[] = [];
		const focus = this.selectedRow() ?? allRows[0] ?? null;

		lines.push(...this.renderOverview(width, focus, { needs, working, completed }));
		if (this.flash) lines.push(...renderFlashBanner(this.flash, width, { bottomGap: true }));

		if (this.mode === "help") return this.fitToHeight(lines.concat(this.renderHelp(width)), width);
		if (this.mode === "peek" || this.mode === "reply") return this.fitToHeight(lines.concat(this.renderPeek(width)), width);
		if (this.mode === "session") return this.fitToHeight(lines.concat(this.renderSession(width)), width);

		// Body: grouped rows with a scroll viewport.
		const footer = this.renderFooter(width);
		const capacity = Math.max(1, (this.tui.terminal?.rows ?? 24) - lines.length - footer.length);
		const body = this.renderRows(width);
		const windowed = this.windowBody(body, capacity);
		lines.push(...windowed.lines);
		// Keep the compose box visually docked to the bottom instead of glued to the
		// final session row. This matches the Claude-style layout: list at top,
		// large calm workspace, input/footer at bottom.
		const spacer = Math.max(0, capacity - windowed.lines.length);
		for (let i = 0; i < spacer; i++) lines.push("");

		lines.push(...footer);
		return this.fitToHeight(lines, width);
	}

	private fitToHeight(lines: string[], width: number): string[] {
		const height = this.tui.terminal?.rows ?? 24;
		const out = lines.slice(0, height).map((l) => clip(l, width));
		while (out.length < height) out.push("");
		return out;
	}

	private renderOverview(
		width: number,
		row: Row | null,
		counts: { needs: number; working: number; completed: number },
	): string[] {
		return renderAgentboardHeader(width, this.theme, row, counts, this.filterQuery, this.deps.defaultCwd);
	}

	private renderFooter(width: number): string[] {
		const t = this.theme;
		const modeColor = this.modeColor();
		const lines = [t.fg(modeColor, "─".repeat(width))];
		if (this.mode === "list" || this.mode === "dispatch") {
			lines.push(...this.taskInputLines(width));
			lines.push("");
			lines.push(clip(this.listHints(), width));
		} else if (this.mode === "filter") {
			lines.push(clip(`${this.modeBadge("FILTER", "warning")} ${t.fg("warning", "filter› ")}${singleLineInput(this.input)}${cursor()}`, width));
			lines.push("");
			lines.push(clip(this.hintLine("FILTER", "warning", ["enter apply", "esc clear"]), width));
		} else if (this.mode === "rename") {
			lines.push(clip(`${this.modeBadge("RENAME", "accent")} ${t.fg("accent", "rename› ")}${singleLineInput(this.input)}${cursor()}`, width));
			lines.push("");
			lines.push(clip(this.hintLine("RENAME", "accent", ["enter save", "esc cancel"]), width));
		} else if (this.mode === "confirm" && this.pending) {
			lines.push(...renderFlashBanner({ text: this.pending.prompt, level: "warn" }, width));
		} else {
			lines.push(clip(this.listHints(), width));
		}
		const notice = this.currentInputNotice();
		if (notice) lines.push(clip(t.fg(notice.color, `ⓘ ${notice.text}`), width));
		lines.push(t.fg(modeColor, "─".repeat(width)));
		return lines;
	}

	private listHints(): string {
		const selected = this.selectedRow();
		const live = selected ? selected.hostAlive && isAgentBusy(selected) : false;
		if (this.mode === "dispatch") {
			const hints = ["esc normal", "enter dispatch", "shift+enter newline", "←/→ edit", "ctrl/alt+←/→ word"];
			if (this.input.trim() || this.worktreeNext) hints.splice(2, 0, `tab worktree:${this.worktreeNext ? "on" : "off"}`);
			return this.hintLine("INSERT", "success", hints);
		}
		const primary = this.input.trim() ? "enter dispatch" : live ? "enter attach live" : "enter resume";
		const hints = ["i insert", primary, "→ attach", "d done", "space peek", "v transcript", "ctrl+r rename", "ctrl+x delete", "X delete state", "/ filter", "? help"];
		if (this.input.trim()) hints.splice(1, 0, "esc clear");
		if (this.input.trim() || this.worktreeNext) hints.splice(this.input.trim() ? 3 : 2, 0, `tab worktree:${this.worktreeNext ? "on" : "off"}`);
		return this.hintLine("NORMAL", "muted", hints);
	}

	private hintLine(label: string, color: InputNoticeColor, hints: string[]): string {
		return `${this.modeBadge(label, color)} ${this.theme.fg("dim", hints.join(" · "))}`;
	}

	private modeBadge(label: string, color: InputNoticeColor): string {
		return this.theme.fg(color, this.theme.bold(`[${label}]`));
	}

	private modeColor(): InputNoticeColor {
		switch (this.mode) {
			case "dispatch":
			case "reply":
				return "success";
			case "filter":
			case "confirm":
				return "warning";
			case "rename":
				return "accent";
			default:
				return "dim";
		}
	}

	private taskInputLines(width: number): string[] {
		const editing = this.mode === "dispatch";
		return this.renderEditorInputLines(width, {
			prompt: editing ? this.theme.fg("success", "┃ ") : this.theme.fg("muted", "› "),
			continuation: editing ? this.theme.fg("success", "┃ ") : this.theme.fg("dim", "│ "),
			editing,
			placeholder: editing ? "" : "describe a task for a new session",
		});
	}

	private renderEditorInputLines(
		width: number,
		opts: { prompt: string; continuation: string; editing: boolean; placeholder?: string; maxVisible?: number },
	): string[] {
		const text = this.input;
		const lines = this.editor.getLines();
		const cursorPos = this.editor.getCursor();
		const maxVisible = opts.maxVisible ?? this.maxEditorVisibleLines();
		const total = Math.max(1, lines.length);
		const cursorLine = Math.max(0, Math.min(cursorPos.line, total - 1));
		const start = Math.max(0, Math.min(cursorLine - maxVisible + 1, total - maxVisible));
		const end = Math.min(total, start + maxVisible);
		const out: string[] = [];

		if (!text) {
			const contentWidth = Math.max(1, width - visibleWidth(opts.prompt));
			const rendered = opts.editing
				? renderInputContent("", 0, contentWidth)
				: this.theme.fg("muted", opts.placeholder ?? "");
			return [clip(`${opts.prompt}${rendered}`, width)];
		}

		if (start > 0) out.push(clip(`${opts.prompt}${this.theme.fg("dim", `↑ ${start} more`)}`, width));
		for (let i = start; i < end; i++) {
			const prefix = i === 0 && start === 0 ? opts.prompt : opts.continuation;
			const contentWidth = Math.max(1, width - visibleWidth(prefix));
			const cursorCol = opts.editing && i === cursorPos.line ? cursorPos.col : null;
			out.push(clip(`${prefix}${renderInputContent(lines[i] ?? "", cursorCol, contentWidth)}`, width));
		}
		if (end < total) out.push(clip(`${opts.continuation}${this.theme.fg("dim", `↓ ${total - end} more`)}`, width));
		return out;
	}

	private maxEditorVisibleLines(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		return Math.max(1, Math.min(6, Math.floor(rows * 0.25)));
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
			if (out.length > 0) out.push("");
			const glyph = stateGlyph(g.state, g.state === "working");
			out.push(clip(`${stageFg(g.state, `${glyph} ${g.label}`)}${t.fg("dim", ` · ${g.rows.length}`)}`, width));
			for (const rv of g.rows) {
				out.push(this.renderRow(rv, width));
			}
		}
		return out;
	}

	private renderRow(rv: ReturnType<typeof import("../core/rows.mjs")["rowView"]>, width: number): string {
		const t = this.theme;
		const selected = rv.id === this.selectedId;
		const marker = stageFg(rv.state, selected ? "›" : stateGlyph(rv.state, rv.alive, rv.hostAlive));
		const badge = `${rv.pinned ? "★ " : ""}${rv.worktree ? "⌥ " : ""}`;
		const ageRaw = ` ${rv.age}`;
		const nameW = clamp(Math.floor(width * 0.34), 18, 30);
		const folderW = width >= 72 ? clamp(Math.floor(width * 0.16), 10, 22) : width >= 56 ? 10 : 0;
		const availableName = Math.max(8, nameW - visibleWidth(badge));
		const nameText = `${badge}${truncate(rv.name, availableName)}`.padEnd(nameW);
		const folderText = folderW > 0 ? truncate(rv.place, folderW).padEnd(folderW) : "";
		const folder = folderW > 0 ? ` ${t.fg("dim", folderText)}` : "";
		const summaryW = Math.max(8, width - nameW - visibleWidth(folder) - visibleWidth(ageRaw) - 4);
		const summary = truncate(rv.summary, summaryW);
		let line = `${marker} ${t.fg(selected ? "text" : "muted", selected ? t.bold(nameText) : nameText)}${folder} ${t.fg(selected ? "text" : "muted", summary)}`;
		line = padTo(line, width - visibleWidth(ageRaw));
		line += t.fg("dim", ageRaw);
		return clip(line, width);
	}

	private renderPeek(width: number): string[] {
		const t = this.theme;
		const row = this.selectedRow();
		if (!row) return [t.fg("muted", "  (no session)")];
		const st = rowState(row);
		const out: string[] = [];
		out.push(`${stageFg(st, stateGlyph(st, row.alive, row.hostAlive))} ${t.fg("accent", t.bold(row.meta.name))} ${t.fg("muted", `[${st}${row.alive ? " · alive" : ""}${row.hostAlive ? " · hosted" : ""}]`)}`);
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
		out.push(t.fg(this.mode === "reply" ? "success" : "dim", "─".repeat(width)));
		if (this.mode === "reply") {
			out.push(
				...this.renderEditorInputLines(width, {
					prompt: `${this.modeBadge("REPLY", "success")} ${t.fg("success", "› ")}`,
					continuation: t.fg("success", "reply┃ "),
					editing: true,
					placeholder: "",
				}),
			);
			out.push(clip(this.hintLine("REPLY INSERT", "success", ["enter send", "shift+enter newline", "esc back"]), width));
			const notice = this.currentInputNotice();
			if (notice) out.push(clip(t.fg(notice.color, `ⓘ ${notice.text}`), width));
		} else {
			out.push(clip(t.fg("dim", "↑↓ prev/next · →/> attach · d done · v transcript · r reply · esc back"), width));
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
		out.push(`${stageFg(st, stateGlyph(st, row.alive, row.hostAlive))} ${t.fg("accent", t.bold(row.meta.name))} ${t.fg("muted", `[session view${row.alive ? " · live" : ""}${row.hostAlive ? " · hosted" : ""}]`)}`);
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
		out.push(clip(t.fg("dim", "←/< back · ↑↓ scroll · pgup/pgdn page · enter attach · d done · r reply · space peek"), width));
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
			["normal", "Dashboard owns keys; i enters insert mode"],
			["insert", "Editor owns text keys; / is literal, arrows move cursor"],
			["i", "Enter insert/compose mode; then / is literal for slash commands"],
			["enter", "Normal: attach/resume or dispatch draft; Insert: dispatch/send"],
			["shift+enter", "Insert a newline while in insert/reply"],
			["esc", "Insert → normal; Normal with draft clears; empty quits standalone dashboard"],
			["↑/↓", "Normal: move selection; Insert: move cursor"],
			["ctrl/alt+←/→", "Jump by word in insert mode"],
			["→ or >", "Attach to the selected real Pi session"],
			["d", "Confirm and mark selected inactive session done"],
			["space", "Peek when input is empty"],
			["tab", "Toggle worktree for the next dispatch"],
			["/", "Filter in normal mode; use i then / for slash commands"],
			["ctrl+r/t/s/x", "Rename · pin · stop · delete selected"],
			["X", "Delete all inactive sessions in selected state"],
			["v", "Open read-only transcript view"],
			["In peek", "→ attach · v transcript · r reply · ↑↓ adjacent"],
			["In session", "← back · ↑↓ scroll · enter attach · r reply"],
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

const AGENTBOARD_VERSION = "v0.1.0";
// ANSI rendering of /Users/rutvik/Downloads/pi-logo-on-dark.svg.
// The SVG is a 4x4 grid mark: P-shaped left form plus a separate lower-right stem.
const PI_ICON = [
	"██████  ",
	"██  ██  ",
	"████  ██",
	"██    ██",
] as const;
const PI_ICON_WIDTH = Math.max(...PI_ICON.map((line) => visibleWidth(line)));
const HEADER_LEFT_PADDING = 2;
const HEADER_TEXT_GAP = 4;
const HEADER_TOP_PADDING = 1;
const HEADER_BOTTOM_PADDING = 2;
const AGENTBOARD_HEADER_MIN_WIDTH = HEADER_LEFT_PADDING + PI_ICON_WIDTH + HEADER_TEXT_GAP + 24;

type HeaderCounts = { needs: number; working: number; completed: number };

function renderAgentboardHeader(
	width: number,
	theme: ThemeLike,
	row: Row | null,
	counts: HeaderCounts,
	filterQuery: string,
	defaultCwd: string,
): string[] {
	if (width < AGENTBOARD_HEADER_MIN_WIDTH) {
		const raw = [
			...blankLines(HEADER_TOP_PADDING),
			clip(`${" ".repeat(HEADER_LEFT_PADDING)}${ansiFg(56, 189, 248, "◉")} ${ansiFg(248, 250, 252, theme.bold("AgentBoard"))} ${ansiFg(148, 163, 184, AGENTBOARD_VERSION)}`, width),
			clip(headerStageSummary(theme, counts, filterQuery, true), width),
			...blankLines(HEADER_BOTTOM_PADDING),
		];
		return raw.map((line, i) => headerBgLine(line, width, i));
	}

	const textRows = headerTextRows(theme, row, counts, filterQuery, defaultCwd);
	const textStart = Math.max(0, Math.round((PI_ICON.length - textRows.length) / 2));
	const raw = blankLines(HEADER_TOP_PADDING);
	raw.push(
		...PI_ICON.map((iconLine, i) =>
			clip(`${" ".repeat(HEADER_LEFT_PADDING)}${renderPiIconLine(iconLine)}${" ".repeat(HEADER_TEXT_GAP)}${textRows[i - textStart] ?? ""}`, width),
		),
	);
	raw.push(...blankLines(HEADER_BOTTOM_PADDING));
	return raw.map((line, i) => headerBgLine(line, width, i));
}

function headerTextRows(theme: ThemeLike, row: Row | null, counts: HeaderCounts, filterQuery: string, defaultCwd: string): string[] {
	const title = `${ansiFg(248, 250, 252, theme.bold("AgentBoard"))} ${ansiFg(148, 163, 184, AGENTBOARD_VERSION)}`;
	const contextBits: string[] = [];
	let contextPrefix = ansiFg(148, 163, 184, "Background Pi sessions");
	if (row) {
		const state = rowState(row);
		contextPrefix = `${stageFg(state, stateGlyph(state, row.alive, row.hostAlive))} ${ansiFg(226, 232, 240, row.meta.name)}`;
		if (row.meta.defaultModel) contextBits.push(row.meta.defaultModel);
		contextBits.push(GROUP_LABELS[state]);
		if (row.alive) contextBits.push("live");
		if (row.hostAlive) contextBits.push("hosted");
		if (row.meta.worktreeMode === "worktree") contextBits.push("worktree");
	}
	const path = displayPath(row ? row.meta.repoCwd || row.meta.cwd : defaultCwd);
	contextBits.push(path);
	return [
		title,
		`${contextPrefix} ${ansiFg(100, 116, 139, contextBits.join(" · "))}`,
		headerStageSummary(theme, counts, filterQuery, false),
	];
}

function headerStageSummary(theme: ThemeLike, counts: HeaderCounts, filterQuery: string, compact: boolean): string {
	const joiner = theme.fg("dim", " · ");
	const parts = [
		headerStagePart(theme, "needs_input", counts.needs, compact ? "awaiting" : "awaiting input"),
		headerStagePart(theme, "working", counts.working, "working"),
		headerStagePart(theme, "completed", counts.completed, "done"),
	];
	if (filterQuery) parts.push(theme.fg("warning", `filter:${filterQuery}`));
	return parts.join(joiner);
}

function headerStagePart(theme: ThemeLike, state: keyof typeof GROUP_LABELS, count: number, label: string): string {
	return `${stageFg(state, String(count))} ${theme.fg("dim", label)}`;
}

const STAGE_RGB = {
	queued: [148, 163, 184],
	working: [56, 189, 248],
	needs_input: [245, 158, 11],
	idle: [129, 140, 248],
	completed: [34, 197, 94],
	failed: [248, 113, 113],
	stopped: [100, 116, 139],
} as const satisfies Record<keyof typeof GROUP_LABELS, readonly [number, number, number]>;

function stageFg(state: keyof typeof GROUP_LABELS, text: string): string {
	const [r, g, b] = STAGE_RGB[state];
	return ansiFg(r, g, b, text);
}

function renderPiIconLine(line: string): string {
	return ansiFg(248, 250, 252, line);
}

function ansiFg(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function ansiBg(r: number, g: number, b: number): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

function headerBgLine(content: string, width: number, row: number): string {
	const clipped = clip(content, width);
	const rest = Math.max(0, width - visibleWidth(clipped));
	return `${ansiBg(15, 23, 42)}${clipped}${gridFill(row, width - rest, rest)}\x1b[49m`;
}

function gridFill(row: number, startCol: number, count: number): string {
	let out = "";
	for (let i = 0; i < count; i++) {
		const col = startCol + i;
		out += row % 2 === 0 && col % 4 === 0 ? ansiFg(51, 65, 85, "·") : " ";
	}
	return out;
}

function blankLines(count: number): string[] {
	return Array.from({ length: count }, () => "");
}

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	// Accept multi-char paste of printable text; reject control/escape sequences.
	return [...data].every((ch) => ch >= " " && ch !== "\x7f");
}

function isBracketedPaste(data: string): boolean {
	return data.includes("\x1b[200~");
}

function cursor(): string {
	return "\x1b[7m \x1b[27m";
}

function renderInputContent(text: string, cursorCol: number | null, width: number): string {
	const safeWidth = Math.max(1, width);
	let start = 0;
	if (cursorCol !== null && cursorCol >= safeWidth) start = cursorCol - safeWidth + 1;
	const visibleText = text.slice(start);
	if (cursorCol === null) return clip(visibleText, safeWidth);
	return clip(withInlineCursor(visibleText, Math.max(0, cursorCol - start)), safeWidth);
}

function withInlineCursor(text: string, col: number): string {
	const safeCol = Math.max(0, Math.min(col, text.length));
	const before = text.slice(0, safeCol);
	const after = text.slice(safeCol);
	if (!after) return `${before}${cursor()}`;
	const [first = ""] = [...after];
	return `${before}\x1b[7m${first}\x1b[27m${after.slice(first.length)}`;
}

function singleLineInput(text: string): string {
	return text.replace(/[\r\n]+/g, " ");
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

function isAgentBusy(row: Row): boolean {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working"));
}

function completedSummary(summary: string, _latestAssistantPreview: string): string {
	const generic = new Set(["", "Queued", "Working…", "Idle", "Needs input", "Completed", "Done"]);
	if (!generic.has(summary.trim())) return compactCompletedSummary(summary);
	return "Done";
}

function compactCompletedSummary(text: string): string {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return "Done";
	const first = firstSentence(cleaned);
	return truncate(first.length >= 12 ? first : cleaned, 80);
}

function displayPath(path: string): string {
	const home = process.env.HOME;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}` || "~";
	return path;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function editorTheme(theme: ThemeLike): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("muted", text),
			noMatch: (text: string) => theme.fg("muted", text),
		},
	};
}

function renderFlashBanner(flash: { text: string; level: FlashLevel }, width: number, opts: { bottomGap?: boolean } = {}): string[] {
	const style = flashStyle(flash.level);
	const contentWidth = Math.max(1, width - 1);
	const content = clip(` ${style.icon} ${flash.text} `, contentWidth);
	const line = clip(`${ansiFg(...style.accent, "▌")}${ansiBg(...style.bg)}${ansiFg(...style.fg, content)}\x1b[49m`, width);
	return opts.bottomGap ? [line, ""] : [line];
}

type FlashStyle = {
	icon: string;
	accent: readonly [number, number, number];
	bg: readonly [number, number, number];
	fg: readonly [number, number, number];
};

function flashStyle(level: FlashLevel): FlashStyle {
	switch (level) {
		case "warn":
			return { icon: "!", accent: [245, 158, 11], bg: [39, 31, 14], fg: [253, 230, 138] };
		case "error":
			return { icon: "×", accent: [248, 113, 113], bg: [45, 18, 23], fg: [254, 202, 202] };
		default:
			return { icon: "i", accent: [56, 189, 248], bg: [8, 31, 49], fg: [186, 230, 253] };
	}
}
