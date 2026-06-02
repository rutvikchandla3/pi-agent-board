/** Live PTY attach surface for hosted agent-board rows. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isProbablyEmptyPiInputLine } from "../core/pty-input.mjs";
import { findHttpUrlAtCells, findWordRangeAtCells } from "../core/pty-links.mjs";
import { nextAttachRender, shouldScheduleAttachRenderForMessage } from "../core/pty-attach-render.mjs";
import { clampInt, parseMouseInputChunk, scrollViewportTop } from "../core/pty-scroll.mjs";

export type PtyAttachResult = { action: "detached" } | { action: "closed"; exitCode?: number | null };

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export interface PtyAttachOptions {
	socketPath: string;
	screenLogPath?: string;
	title: string;
}

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: new (opts: Record<string, unknown>) => XtermLike };

const DETACH_KEYS = new Set(["\x1d", "\x07"]); // ctrl+], ctrl+g
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const XTSHIFTESCAPE_SELECT = "\x1b[>0s";
const MOUSE_WHEEL_LINES = 5;
const DOUBLE_CLICK_MS = 260;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LOADING_TICK_MS = 120;
const OSC52_PREFIX = "\x1b]52;";
const OSC52_MAX_BYTES = 1_000_000;
const OSC52_CARRY_MAX_BYTES = OSC52_MAX_BYTES + 4096;
const TERMINAL_PASSTHROUGH_MAX_BYTES = 5_000_000;
const TERMINAL_PASSTHROUGH_CARRY_MAX_BYTES = TERMINAL_PASSTHROUGH_MAX_BYTES + 4096;
const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_FILE_PREFIX = "\x1b]1337;File=";

interface XtermLike {
	write(data: string, cb?: () => void): void;
	resize(cols: number, rows: number): void;
	buffer: {
		active: {
			baseY: number;
			cursorY?: number;
			length: number;
			getLine(index: number): BufferLineLike | undefined;
			getNullCell(): BufferCellLike;
		};
	};
	_core?: {
		_oscLinkService?: {
			getLinkData?: (id: number) => { uri?: string } | undefined;
			_dataByLinkId?: Map<number, { data?: { uri?: string } }>;
		};
	};
}

interface BufferLineLike {
	length: number;
	getCell(x: number, cell?: BufferCellLike): BufferCellLike | undefined;
	translateToString(trimRight?: boolean): string;
}

interface BufferCellLike {
	getWidth(): number;
	getChars(): string;
	extended?: { urlId?: number; _urlId?: number };
	getFgColor(): number;
	getBgColor(): number;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
	isFgDefault(): boolean;
	isBgDefault(): boolean;
	isBold(): number;
	isItalic(): number;
	isDim(): number;
	isUnderline(): number;
	isBlink(): number;
	isInverse(): number;
	isInvisible(): number;
	isStrikethrough(): number;
	isOverline(): number;
}

type MousePoint = { line: number; col: number };
type MouseSelection = { anchor: MousePoint; focus: MousePoint };
type NormalizedSelection = { start: MousePoint; end: MousePoint };

export class PtyAttachComponent implements Component {
	private socket: Socket | null = null;
	private connected = false;
	private closed = false;
	private status = "connecting";
	private parserBuffer = "";
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private loadingTimer: ReturnType<typeof setInterval> | null = null;
	private redrawTimer: ReturnType<typeof setTimeout> | null = null;
	private liveRedrawTimer: ReturnType<typeof setTimeout> | null = null;
	private forcedRedrawAfterLiveOutput = false;
	private mouseRefreshTimers: Array<ReturnType<typeof setTimeout>> = [];
	private osc52Carry = "";
	private passthroughCarry = "";
	private readonly connectStartedAt = Date.now();
	private readonly term: XtermLike;
	private cols = 120;
	private rows = 24;
	// Absolute buffer line shown at the top of the viewport. null means follow bottom.
	private viewportTop: number | null = null;
	private selection: MouseSelection | null = null;
	private selectionDragging = false;
	private pendingClickTimer: ReturnType<typeof setTimeout> | null = null;
	private lastClickPoint: MousePoint | null = null;
	private lastClickAt = 0;
	// Whether any PTY output (live or replayed) has been shown yet. Until then we paint a
	// loading banner instead of an empty buffer so a slow (cold) host start doesn't leave
	// the previous screen visible.
	private receivedOutput = false;
	// Force a single full-clear on the first paint so the prior session/dashboard can't
	// ghost behind this overlay; every later paint uses the TUI's coalesced, throttled,
	// differential renderer so wheel/output bursts don't each trigger a full repaint.
	private firstPaint = true;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		_keybindings: KeybindingsManager,
		private readonly done: (result: PtyAttachResult) => void,
		private readonly opts: PtyAttachOptions,
	) {
		const size = this.currentSize();
		this.cols = size.cols;
		this.rows = size.rows;
		this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 2000, allowProposedApi: true });
		// Keep mouse reporting enabled by default so wheel scrolling and local drag-to-copy
		// selection can coexist inside the attach surface. Set AGENT_BOARD_ATTACH_MOUSE=0
		// to fall back to terminal-native selection only.
		this.disableMouseScroll();
		this.enableMouseScroll();
		this.refreshMouseScrollMode();
		this.replayScreenLog();
		this.connect();
		this.startLoadingTicker();
		// Paint immediately (forced once) so the loading banner replaces the previous
		// surface the instant we attach, rather than after the first reconnect tick.
		this.scheduleRender();
	}

	handleInput(data: string): void {
		const mouseInput = parseMouseInputChunk(data);
		if (mouseInput && this.handleMouseInputChunk(mouseInput)) return;
		if (matchesKey(data, Key.pageUp)) {
			this.clearPendingClick();
			this.clearSelection();
			if (this.tryScrollBy(this.pageSize())) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.clearPendingClick();
			this.clearSelection();
			if (this.tryScrollBy(-this.pageSize())) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.clearPendingClick();
			this.clearSelection();
			if (this.tryScrollToTop()) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.clearPendingClick();
			this.clearSelection();
			if (this.tryScrollToBottom()) return;
			this.send({ type: "input", data });
			return;
		}
		if (
			DETACH_KEYS.has(data) ||
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.ctrl("]")) ||
			matchesKey(data, Key.ctrl("g"))
		) {
			if (this.childInputLooksEmpty()) {
				this.detach();
				return;
			}
			this.clearPendingClick();
			this.clearSelection();
			this.scrollToBottom();
			this.send({ type: "input", data });
			return;
		}
		this.clearPendingClick();
		this.clearSelection();
		this.scrollToBottom();
		this.send({ type: "input", data });
	}

	render(width: number): string[] {
		this.resizeIfNeeded(width);
		const height = this.tui.terminal?.rows ?? 24;
		const bodyHeight = Math.max(1, height - 2);
		let body: string[];
		if (this.receivedOutput) {
			body = this.project(bodyHeight, width);
			while (body.length < bodyHeight) body.unshift("");
		} else {
			body = this.renderLoading(bodyHeight, width);
		}
		const header =
			this.theme.fg("accent", this.theme.bold(` ${this.opts.title} `)) +
			this.theme.fg("muted", `${this.status} · click opens links · dblclick/drag selects+copies · ← detach · ctrl+] detach`);
		return [clip(header, width), ...body.map((l) => clipTerminalLine(l, width)), this.theme.fg("dim", "─".repeat(width))];
	}

	/** Centered "loading" surface shown until the first PTY output paints the session. */
	private renderLoading(height: number, width: number): string[] {
		const elapsedMs = Date.now() - this.connectStartedAt;
		const spinner = this.closed ? "·" : SPINNER[Math.floor(elapsedMs / LOADING_TICK_MS) % SPINNER.length];
		const title = `${spinner} Loading "${this.opts.title}"…`;
		const detail = this.loadingDetail(Math.max(0, Math.round(elapsedMs / 1000)));
		const out: string[] = [];
		const top = Math.max(0, Math.floor((height - 3) / 2));
		for (let i = 0; i < top; i++) out.push("");
		out.push(center(this.theme.fg("accent", this.theme.bold(title)), width));
		out.push(center(this.theme.fg("muted", detail), width));
		out.push("");
		out.push(center(this.theme.fg("dim", "← or ctrl+] to detach"), width));
		while (out.length < height) out.push("");
		return out.slice(0, height);
	}

	private loadingDetail(elapsedSeconds: number): string {
		if (this.status === "attached") return "Attached · waiting for the session to render…";
		if (this.status.startsWith("error") || this.status === "host exited") return this.status;
		if (this.status === "disconnected") return `Reconnecting to the session host… ${elapsedSeconds}s`;
		return `Starting the session host… ${elapsedSeconds}s`;
	}

	invalidate(): void {}

	dispose(): void {
		this.close();
	}

	private detach(): void {
		this.send({ type: "detach" });
		this.close();
		this.done({ action: "detached" });
	}

	private childInputLooksEmpty(): boolean {
		if (!this.receivedOutput) return true;
		const active = this.term.buffer.active;
		if (typeof active.cursorY !== "number") return false;
		const line = active.getLine(active.baseY + active.cursorY)?.translateToString(true) ?? "";
		return isProbablyEmptyPiInputLine(line);
	}

	private connect(): void {
		if (this.closed || this.connected || this.socket) return;
		if (!existsSync(this.opts.socketPath)) {
			this.status = `starting host… ${Math.ceil((Date.now() - this.connectStartedAt) / 1000)}s`;
			this.scheduleReconnect();
			return;
		}
		const socket = createConnection(this.opts.socketPath);
		this.socket = socket;
		socket.on("connect", () => {
			this.clearRetry();
			this.connected = true;
			this.status = "attached";
			this.send({ type: "hello", clientId: `ui-${Date.now()}`, wantOutput: true });
			this.sendResize();
			this.forceChildRedraw();
			this.enableMouseScroll();
			this.scheduleRender();
		});
		socket.on("data", (chunk) => this.onSocketData(chunk.toString("utf8")));
		socket.on("close", () => {
			this.socket = null;
			this.connected = false;
			if (!this.closed && this.status !== "host exited") {
				this.status = "disconnected";
				this.scheduleReconnect();
			}
			if (!this.closed) this.scheduleRender();
		});
		socket.on("error", (err) => {
			this.socket = null;
			this.connected = false;
			if (this.closed) return;
			this.status = `waiting for host… ${err.message}`;
			this.scheduleReconnect();
			this.scheduleRender();
		});
	}

	/**
	 * Request a repaint. The first paint is forced (clears any prior screen so the previous
	 * session can't ghost behind us); all later paints are coalesced + throttled + differential
	 * by the TUI, so bursts of wheel/output events don't each clear-and-repaint the whole screen.
	 */
	private scheduleRender(force = false): void {
		const next = nextAttachRender(this.firstPaint, force);
		this.firstPaint = next.firstPaint;
		this.tui.requestRender(next.force);
	}

	private scheduleReconnect(): void {
		if (this.closed || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
			this.scheduleRender();
		}, 150);
	}

	/** Animate the loading banner until the first PTY output arrives (or we close). */
	private startLoadingTicker(): void {
		if (this.loadingTimer || this.receivedOutput || this.closed) return;
		this.loadingTimer = setInterval(() => {
			if (this.closed || this.receivedOutput) return this.stopLoadingTicker();
			this.tui.requestRender();
		}, LOADING_TICK_MS);
		this.loadingTimer.unref?.();
	}

	private stopLoadingTicker(): void {
		if (!this.loadingTimer) return;
		clearInterval(this.loadingTimer);
		this.loadingTimer = null;
	}

	private clearRedrawTimer(): void {
		if (this.redrawTimer) {
			clearTimeout(this.redrawTimer);
			this.redrawTimer = null;
		}
		if (this.liveRedrawTimer) {
			clearTimeout(this.liveRedrawTimer);
			this.liveRedrawTimer = null;
		}
	}

	private clearMouseRefreshTimers(): void {
		for (const timer of this.mouseRefreshTimers) clearTimeout(timer);
		this.mouseRefreshTimers = [];
	}

	private clearRetry(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	private enableMouseScroll(): void {
		if (!this.mouseScrollEnabled()) return;
		try {
			this.tui.terminal.write(XTSHIFTESCAPE_SELECT);
			this.tui.terminal.write(MOUSE_ENABLE);
		} catch {}
	}

	private mouseScrollEnabled(): boolean {
		const mode = (process.env.AGENT_BOARD_ATTACH_MOUSE ?? "").trim().toLowerCase();
		if (mode === "0" || mode === "off" || mode === "false") return false;
		if (mode === "1" || mode === "on" || mode === "true" || mode === "classic") return true;
		if ((process.env.AGENT_BOARD_ENABLE_MOUSE_SCROLL ?? "").trim() === "0") return false;
		return true;
	}

	private refreshMouseScrollMode(): void {
		this.clearMouseRefreshTimers();
		if (!this.mouseScrollEnabled()) return;
		for (const delay of [0, 50, 250]) {
			const timer = setTimeout(() => {
				if (!this.closed) this.enableMouseScroll();
			}, delay);
			timer.unref?.();
			this.mouseRefreshTimers.push(timer);
		}
	}

	private disableMouseScroll(): void {
		try {
			this.tui.terminal.write(MOUSE_DISABLE);
		} catch {}
	}

	private handleMouseInputChunk(events: Array<{ raw: string; mouse: { button: number; row: number; col: number; action: string } }>): boolean {
		let handled = false;
		for (const entry of events) {
			const { mouse, raw } = entry;
			if ((mouse.button & 64) !== 0) {
				handled = true;
				const wheelButton = mouse.button & 3;
				const wheel = wheelButton === 0 ? 1 : wheelButton === 1 ? -1 : 0;
				if (wheel === 0) continue;
				this.clearPendingClick();
				this.clearSelection();
				if (!this.tryScrollBy(wheel * MOUSE_WHEEL_LINES)) this.send({ type: "input", data: raw });
				continue;
			}
			handled = true;
			this.handleLocalMouseEvent(mouse);
		}
		return handled;
	}

	private handleLocalMouseEvent(mouse: { button: number; row: number; col: number; action: string }): void {
		const primary = (mouse.button & 3) === 0;
		if (mouse.action === "press") {
			if (!primary) {
				this.clearPendingClick();
				this.clearSelection();
				return;
			}
			const point = this.mousePointForEvent(mouse.row, mouse.col, false);
			if (!point) {
				this.clearPendingClick();
				this.clearSelection();
				return;
			}
			if (this.isDoubleClickCandidate(point)) this.clearPendingClick();
			this.selection = { anchor: point, focus: point };
			this.selectionDragging = false;
			this.scheduleRender();
			return;
		}
		if (!this.selection) return;
		if (mouse.action === "move") {
			if (!primary) return;
			const point = this.mousePointForEvent(mouse.row, mouse.col, true);
			if (!point) return;
			this.selection.focus = point;
			this.selectionDragging = true;
			this.scheduleRender();
			return;
		}
		if (mouse.action === "release") {
			const point = this.mousePointForEvent(mouse.row, mouse.col, true);
			if (point) this.selection.focus = point;
			const shouldCopy = this.selectionDragging;
			this.selectionDragging = false;
			if (shouldCopy) {
				this.clearPendingClick();
				this.lastClickPoint = null;
				this.lastClickAt = 0;
				this.copySelectionToClipboard();
				this.scheduleRender();
				return;
			}
			if (!point) {
				this.clearPendingClick();
				this.clearSelection();
				return;
			}
			if (this.isDoubleClickCandidate(point)) {
				this.clearPendingClick();
				this.lastClickPoint = null;
				this.lastClickAt = 0;
				if (!this.selectWordAtPoint(point)) this.selection = null;
				this.scheduleRender();
				return;
			}
			this.lastClickPoint = point;
			this.lastClickAt = Date.now();
			this.schedulePendingClick(point);
		}
	}

	private mousePointForEvent(row: number, col: number, clampToBody: boolean): MousePoint | null {
		const height = this.bodyHeight();
		const bodyRow = row - 2;
		if (!clampToBody && (bodyRow < 0 || bodyRow >= height)) return null;
		const clampedRow = clampInt(bodyRow, 0, Math.max(0, height - 1));
		this.clampViewportTop(height);
		const start = this.viewportTop ?? this.bottomViewportTop(height);
		const line = clampInt(start + clampedRow, 0, Math.max(0, this.term.buffer.active.length - 1));
		const cellCol = clampInt(col - 1, 0, Math.max(0, this.cols - 1));
		return { line, col: cellCol };
	}

	private isDoubleClickCandidate(point: MousePoint): boolean {
		return !!this.lastClickPoint && Date.now() - this.lastClickAt <= DOUBLE_CLICK_MS && sameMousePoint(this.lastClickPoint, point);
	}

	private schedulePendingClick(point: MousePoint): void {
		this.clearPendingClick();
		this.pendingClickTimer = setTimeout(() => {
			this.pendingClickTimer = null;
			this.lastClickPoint = null;
			this.lastClickAt = 0;
			if (this.closed) return;
			this.openLinkAtPoint(point);
			this.selection = null;
			this.selectionDragging = false;
			this.tui.requestRender();
		}, DOUBLE_CLICK_MS);
		this.pendingClickTimer.unref?.();
	}

	private clearPendingClick(): void {
		if (!this.pendingClickTimer) return;
		clearTimeout(this.pendingClickTimer);
		this.pendingClickTimer = null;
	}

	private selectWordAtPoint(point: MousePoint): boolean {
		const buf = this.term.buffer.active;
		const line = buf.getLine(point.line);
		if (!line) return false;
		const reusable = buf.getNullCell();
		const range = findWordRangeAtCells(asciiCellsForBufferLine(line, reusable), point.col);
		if (!range) return false;
		this.selection = {
			anchor: { line: point.line, col: range.start },
			focus: { line: point.line, col: range.end },
		};
		this.selectionDragging = false;
		this.copySelectionToClipboard();
		return true;
	}

	private openLinkAtPoint(point: MousePoint): boolean {
		const target = this.linkAtPoint(point);
		return target ? openExternalTarget(target) : false;
	}

	private linkAtPoint(point: MousePoint): string | null {
		const buf = this.term.buffer.active;
		const line = buf.getLine(point.line);
		if (!line) return null;
		const reusable = buf.getNullCell();
		const cell = line.getCell(point.col, reusable);
		const osc8 = cell ? osc8UriForCell(this.term, cell) : "";
		if (osc8) return osc8;
		return findHttpUrlAtCells(asciiCellsForBufferLine(line, reusable), point.col);
	}

	private clearSelection(): void {
		if (!this.selection && !this.selectionDragging) return;
		this.selection = null;
		this.selectionDragging = false;
		this.tui.requestRender();
	}

	private copySelectionToClipboard(): void {
		const text = this.selectionText();
		if (!text) return;
		const seq = osc52CopySequence(text);
		if (!seq) return;
		try {
			this.tui.terminal.write(seq);
		} catch {}
	}

	private selectionText(): string {
		const range = normalizeSelection(this.selection);
		if (!range) return "";
		const buf = this.term.buffer.active;
		const reusable = buf.getNullCell();
		const parts: string[] = [];
		for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex++) {
			const line = buf.getLine(lineIndex);
			if (!line) {
				parts.push("");
				continue;
			}
			const from = lineIndex === range.start.line ? range.start.col : 0;
			const to = lineIndex === range.end.line ? range.end.col : line.length - 1;
			let text = "";
			for (let x = Math.max(0, from); x <= Math.max(from, to); x++) {
				const cell = line.getCell(x, reusable);
				if (!cell || cell.getWidth() === 0) continue;
				text += cell.getChars() || " ";
			}
			parts.push(text.replace(/\s+$/u, ""));
		}
		return parts.join("\n").replace(/^\n+|\n+$/gu, "");
	}

	private currentSize(): { cols: number; rows: number } {
		const term = this.tui.terminal as unknown as { cols?: number; columns?: number; rows?: number } | undefined;
		return {
			cols: Math.max(20, term?.cols ?? term?.columns ?? 120),
			rows: Math.max(5, (term?.rows ?? 24) - 2),
		};
	}

	private resizeIfNeeded(width: number): void {
		const size = this.currentSize();
		// Render width is authoritative inside ctx.ui.custom; terminal.cols is not
		// consistently exposed by all Pi TUI versions.
		size.cols = Math.max(20, width);
		if (size.cols === this.cols && size.rows === this.rows) return;
		this.cols = size.cols;
		this.rows = size.rows;
		this.term.resize(this.cols, this.rows);
		this.sendResize();
		this.enableMouseScroll();
	}

	private sendResize(cols = this.cols, rows = this.rows): void {
		this.send({ type: "resize", cols, rows });
		this.clampViewportTop(this.bodyHeight());
	}

	private forceChildRedraw(): void {
		this.clearRedrawTimer();
		if (!this.connected) return;
		const cols = this.cols;
		const rows = this.rows;
		const jiggle = localResizeJiggleSize(cols, rows);
		if (!jiggle) return;
		// A completed-session reattach often starts from an old screen.log recorded at
		// a different terminal size. Real terminal zoom fixes that by causing SIGWINCH;
		// do the same proactively so the child Pi redraws for the attach viewport.
		this.sendResize(jiggle.cols, jiggle.rows);
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = null;
			if (!this.closed && this.connected) this.sendResize(cols, rows);
		}, 40);
		this.redrawTimer.unref?.();
	}

	private tryScrollBy(linesUp: number): boolean {
		const result = scrollViewportTop(this.viewportTop, this.bottomViewportTop(this.bodyHeight()), linesUp);
		this.viewportTop = result.viewportTop;
		if (result.changed) this.requestScrollRender();
		return result.changed;
	}

	private tryScrollToTop(): boolean {
		if (this.bottomViewportTop(this.bodyHeight()) <= 0 || this.viewportTop === 0) return false;
		this.viewportTop = 0;
		this.requestScrollRender();
		return true;
	}

	private tryScrollToBottom(): boolean {
		if (this.viewportTop === null) return false;
		this.viewportTop = null;
		this.requestScrollRender();
		return true;
	}

	private scrollToBottom(): void {
		this.viewportTop = null;
		this.requestScrollRender();
	}

	private requestScrollRender(): void {
		this.scheduleRender();
	}

	private bodyHeight(): number {
		return Math.max(1, (this.tui.terminal?.rows ?? 24) - 2);
	}

	private pageSize(): number {
		return Math.max(1, this.bodyHeight() - 2);
	}

	private bottomViewportTop(height: number): number {
		const buf = this.term.buffer.active;
		const bottom = Math.min(buf.length, buf.baseY + this.rows);
		return Math.max(0, bottom - height);
	}

	private clampViewportTop(height: number): void {
		if (this.viewportTop === null) return;
		this.viewportTop = clampInt(this.viewportTop, 0, this.bottomViewportTop(height));
	}

	private send(msg: Record<string, unknown>): void {
		if (!this.socket || !this.connected) return;
		this.socket.write(JSON.stringify(msg) + "\n");
	}

	private onSocketData(text: string): void {
		this.parserBuffer += text;
		const lines = this.parserBuffer.split("\n");
		this.parserBuffer = lines.pop() ?? "";
		let needsRender = false;
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.type === "output" && typeof msg.data === "string") {
					this.pushOutput(msg.data, { forwardProtocols: true });
					this.forceChildRedrawAfterLiveOutput();
					continue;
				}
				if (msg.type === "hello" || msg.type === "status") this.status = "attached";
				else if (msg.type === "exit") {
					this.status = "host exited";
					this.done({ action: "closed", exitCode: msg.exitCode ?? null });
				} else if (msg.type === "error") this.status = `error: ${msg.message ?? "host error"}`;
				if (shouldScheduleAttachRenderForMessage(msg.type)) needsRender = true;
			} catch {
				// Ignore malformed protocol lines; raw PTY data is only legal inside output.data.
			}
		}
		if (needsRender) this.scheduleRender();
	}

	private forceChildRedrawAfterLiveOutput(): void {
		if (this.forcedRedrawAfterLiveOutput || this.liveRedrawTimer || this.closed) return;
		this.liveRedrawTimer = setTimeout(() => {
			this.liveRedrawTimer = null;
			if (this.closed || !this.connected) return;
			this.forcedRedrawAfterLiveOutput = true;
			this.forceChildRedraw();
		}, 120);
		this.liveRedrawTimer.unref?.();
	}

	private forwardTerminalProtocols(data: string): void {
		const toWrite: string[] = [];
		if (process.env.AGENT_BOARD_FORWARD_OSC52 !== "0") {
			const { sequences, carry } = extractOsc52Sequences(this.osc52Carry + data);
			this.osc52Carry = carry;
			toWrite.push(...sequences);
		}
		if (process.env.AGENT_BOARD_FORWARD_IMAGES !== "0") {
			const { sequences, carry } = extractTerminalPassthroughSequences(this.passthroughCarry + data);
			this.passthroughCarry = carry;
			toWrite.push(...sequences);
		}
		for (const seq of toWrite) {
			try {
				this.tui.terminal.write(seq);
			} catch {}
		}
	}

	private replayScreenLog(): void {
		if (!this.opts.screenLogPath || !existsSync(this.opts.screenLogPath)) return;
		try {
			const raw = readFileSync(this.opts.screenLogPath, "utf8");
			this.pushOutput(raw.slice(-100_000));
		} catch {}
	}

	private pushOutput(data: string, opts: { forwardProtocols?: boolean } = {}): void {
		if (data.length === 0) return;
		if (opts.forwardProtocols) this.forwardTerminalProtocols(data);
		// @xterm/headless parses asynchronously; the buffer is only populated once this
		// callback fires. Flip out of the loading state here (not synchronously) so a warm
		// (replayed) attach never paints the banner over a not-yet-parsed buffer.
		this.term.write(data, () => {
			if (!this.receivedOutput) {
				this.receivedOutput = true;
				this.stopLoadingTicker();
			}
			this.scheduleRender();
		});
	}

	private project(height: number, width: number): string[] {
		const out: string[] = [];
		const buf = this.term.buffer.active;
		const selection = normalizeSelection(this.selection);
		this.clampViewportTop(height);
		const start = this.viewportTop ?? this.bottomViewportTop(height);
		const end = Math.min(buf.length, start + height);
		const reusable = buf.getNullCell();
		for (let i = start; i < end; i++) {
			out.push(clipTerminalLine(lineToAnsi(buf.getLine(i), reusable, this.term, i, selection), width));
		}
		if (out.length === 0) out.push("Waiting for PTY output…");
		return out.slice(-height);
	}

	private close(): void {
		this.closed = true;
		this.disableMouseScroll();
		this.clearMouseRefreshTimers();
		this.clearPendingClick();
		this.clearRetry();
		this.clearRedrawTimer();
		this.stopLoadingTicker();
		try {
			this.socket?.destroy();
		} catch {}
		this.socket = null;
		this.connected = false;
	}
}

function localResizeJiggleSize(cols: number, rows: number): { cols: number; rows: number } | null {
	if (cols > 21 && rows > 6) return { cols: cols - 1, rows: rows - 1 };
	if (rows > 6) return { cols, rows: rows - 1 };
	if (cols > 21) return { cols: cols - 1, rows };
	return null;
}

function sameMousePoint(a: MousePoint, b: MousePoint): boolean {
	return a.line === b.line && Math.abs(a.col - b.col) <= 1;
}

function asciiCellsForBufferLine(line: BufferLineLike, reusable: BufferCellLike): string[] {
	const cells: string[] = [];
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) {
			cells.push(" ");
			continue;
		}
		const chars = cell.getChars() || " ";
		cells.push(chars.length === 1 && chars >= " " && chars <= "~" ? chars : " ");
	}
	return cells;
}

function openExternalTarget(target: string): boolean {
	const sanitized = sanitizeOscPayload(target).trim();
	if (!sanitized) return false;
	try {
		if (process.platform === "darwin") {
			spawn("open", [sanitized], { detached: true, stdio: "ignore" }).unref();
			return true;
		}
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", sanitized], { detached: true, stdio: "ignore" }).unref();
			return true;
		}
		spawn("xdg-open", [sanitized], { detached: true, stdio: "ignore" }).unref();
		return true;
	} catch {
		return false;
	}
}

function compareMousePoints(a: MousePoint, b: MousePoint): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function normalizeSelection(selection: MouseSelection | null): NormalizedSelection | null {
	if (!selection) return null;
	return compareMousePoints(selection.anchor, selection.focus) <= 0
		? { start: selection.anchor, end: selection.focus }
		: { start: selection.focus, end: selection.anchor };
}

function pointWithinSelection(line: number, col: number, selection: NormalizedSelection | null): boolean {
	if (!selection) return false;
	if (line < selection.start.line || line > selection.end.line) return false;
	if (selection.start.line === selection.end.line) return col >= selection.start.col && col <= selection.end.col;
	if (line === selection.start.line) return col >= selection.start.col;
	if (line === selection.end.line) return col <= selection.end.col;
	return true;
}

function osc52CopySequence(text: string): string {
	if (!text) return "";
	const data = Buffer.from(text, "utf8").toString("base64");
	const seq = `\x1b]52;c;${data}\x07`;
	return Buffer.byteLength(seq, "utf8") <= OSC52_MAX_BYTES ? seq : "";
}

function lineToAnsi(
	line: BufferLineLike | undefined,
	reusable: BufferCellLike,
	term: XtermLike,
	lineIndex: number,
	selection: NormalizedSelection | null,
): string {
	if (!line) return "";
	let last = -1;
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) continue;
		if (cell.getChars()) last = x;
	}
	if (last < 0) return "";

	let out = "";
	let prevAttr = "";
	let prevUri = "";
	for (let x = 0; x <= last; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) continue;
		const uri = osc8UriForCell(term, cell);
		if (uri !== prevUri) {
			if (prevUri) out += closeOsc8();
			if (uri) out += openOsc8(uri);
			prevUri = uri;
		}
		const selected = pointWithinSelection(lineIndex, x, selection);
		const key = attrKey(cell, selected);
		if (key !== prevAttr) {
			out += attrsToAnsi(cell, selected);
			prevAttr = key;
		}
		out += cell.getChars() || " ";
	}
	if (prevUri) out += closeOsc8();
	return out + "\x1b[0m";
}

function attrKey(cell: BufferCellLike, selected = false): string {
	return [
		selected ? 1 : 0,
		cell.isBold(),
		cell.isDim(),
		cell.isItalic(),
		cell.isUnderline(),
		cell.isBlink(),
		cell.isInverse(),
		cell.isInvisible(),
		cell.isStrikethrough(),
		cell.isOverline(),
		cell.isFgRGB(),
		cell.isFgPalette(),
		cell.getFgColor(),
		cell.isBgRGB(),
		cell.isBgPalette(),
		cell.getBgColor(),
	].join(";");
}

function attrsToAnsi(cell: BufferCellLike, selected = false): string {
	const codes: string[] = ["0"];
	if (cell.isBold()) codes.push("1");
	if (cell.isDim()) codes.push("2");
	if (cell.isItalic()) codes.push("3");
	if (cell.isUnderline()) codes.push("4");
	if (cell.isBlink()) codes.push("5");
	if (cell.isInverse() || selected) codes.push("7");
	if (cell.isInvisible()) codes.push("8");
	if (cell.isStrikethrough()) codes.push("9");
	if (cell.isOverline()) codes.push("53");
	codes.push(...colorCodes(cell, "fg"));
	codes.push(...colorCodes(cell, "bg"));
	return `\x1b[${codes.join(";")}m`;
}

function colorCodes(cell: BufferCellLike, kind: "fg" | "bg"): string[] {
	const isFg = kind === "fg";
	const color = isFg ? cell.getFgColor() : cell.getBgColor();
	if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
		return [isFg ? "38" : "48", "2", String((color >> 16) & 255), String((color >> 8) & 255), String(color & 255)];
	}
	if (isFg ? cell.isFgPalette() : cell.isBgPalette()) {
		if (color >= 0 && color <= 7) return [String((isFg ? 30 : 40) + color)];
		if (color >= 8 && color <= 15) return [String((isFg ? 90 : 100) + color - 8)];
		return [isFg ? "38" : "48", "5", String(color)];
	}
	return [isFg ? "39" : "49"];
}

function clip(line: string, width: number): string {
	return truncateToWidth(line, width, "");
}

function clipTerminalLine(line: string, width: number): string {
	// pi-tui's width helpers are ANSI-aware, but OSC sequences are terminal
	// protocols rather than SGR styling. Avoid truncating inside OSC 8 hyperlinks;
	// these lines are already projected from an xterm buffer sized to the viewport.
	return line.includes("\x1b]") ? line : clip(line, width);
}

function osc8UriForCell(term: XtermLike, cell: BufferCellLike): string {
	const id = cell.extended?.urlId ?? cell.extended?._urlId ?? 0;
	if (!id) return "";
	const service = term._core?._oscLinkService;
	const uri = service?.getLinkData?.(id)?.uri ?? service?._dataByLinkId?.get(id)?.data?.uri;
	return sanitizeOscPayload(uri ?? "");
}

function openOsc8(uri: string): string {
	return uri ? `\x1b]8;;${uri}\x07` : "";
}

function closeOsc8(): string {
	return "\x1b]8;;\x07";
}

function extractOsc52Sequences(input: string): { sequences: string[]; carry: string } {
	const sequences: string[] = [];
	let scanFrom = 0;
	let carryStart = -1;
	while (scanFrom < input.length) {
		const start = input.indexOf(OSC52_PREFIX, scanFrom);
		if (start < 0) break;
		const bel = input.indexOf("\x07", start + OSC52_PREFIX.length);
		const st = input.indexOf("\x1b\\", start + OSC52_PREFIX.length);
		const end = firstTerminator(bel, st);
		if (!end) {
			carryStart = start;
			break;
		}
		const [endIndex, terminatorLength] = end;
		const seq = input.slice(start, endIndex + terminatorLength);
		if (isForwardableOsc52(seq)) sequences.push(seq);
		scanFrom = endIndex + terminatorLength;
	}
	const carry = carryStart >= 0 ? input.slice(carryStart).slice(-OSC52_CARRY_MAX_BYTES) : osc52PrefixSuffix(input);
	return { sequences, carry };
}

function osc52PrefixSuffix(input: string): string {
	const max = Math.min(input.length, OSC52_PREFIX.length - 1);
	for (let len = max; len > 0; len--) {
		const suffix = input.slice(-len);
		if (OSC52_PREFIX.startsWith(suffix)) return suffix;
	}
	return "";
}

function firstTerminator(bel: number, st: number): [number, number] | null {
	if (bel < 0 && st < 0) return null;
	if (bel >= 0 && (st < 0 || bel < st)) return [bel, 1];
	return [st, 2];
}

function extractTerminalPassthroughSequences(input: string): { sequences: string[]; carry: string } {
	const sequences: string[] = [];
	let scanFrom = 0;
	let carryStart = -1;
	while (scanFrom < input.length) {
		const kitty = input.indexOf(KITTY_IMAGE_PREFIX, scanFrom);
		const iterm = input.indexOf(ITERM2_FILE_PREFIX, scanFrom);
		const start = firstIndex(kitty, iterm);
		if (start < 0) break;
		const prefix = start === kitty ? KITTY_IMAGE_PREFIX : ITERM2_FILE_PREFIX;
		const bel = prefix === ITERM2_FILE_PREFIX ? input.indexOf("\x07", start + prefix.length) : -1;
		const st = input.indexOf("\x1b\\", start + prefix.length);
		const end = firstTerminator(bel, st);
		if (!end) {
			carryStart = start;
			break;
		}
		const [endIndex, terminatorLength] = end;
		const seq = input.slice(start, endIndex + terminatorLength);
		if (seq.length <= TERMINAL_PASSTHROUGH_MAX_BYTES) sequences.push(seq);
		scanFrom = endIndex + terminatorLength;
	}
	const carry = carryStart >= 0 ? input.slice(carryStart).slice(-TERMINAL_PASSTHROUGH_CARRY_MAX_BYTES) : terminalPassthroughPrefixSuffix(input);
	return { sequences, carry };
}

function firstIndex(a: number, b: number): number {
	if (a < 0) return b;
	if (b < 0) return a;
	return Math.min(a, b);
}

function terminalPassthroughPrefixSuffix(input: string): string {
	let best = "";
	for (const prefix of [KITTY_IMAGE_PREFIX, ITERM2_FILE_PREFIX]) {
		const max = Math.min(input.length, prefix.length - 1);
		for (let len = max; len > best.length; len--) {
			const suffix = input.slice(-len);
			if (prefix.startsWith(suffix)) best = suffix;
		}
	}
	return best;
}

function isForwardableOsc52(seq: string): boolean {
	if (seq.length > OSC52_MAX_BYTES) return false;
	const terminatorLength = seq.endsWith("\x1b\\") ? 2 : 1;
	const body = seq.slice(2, -terminatorLength); // strip ESC] and BEL/ST
	const firstSemi = body.indexOf(";");
	const secondSemi = body.indexOf(";", firstSemi + 1);
	if (!body.startsWith("52;") || secondSemi < 0) return false;
	const payload = body.slice(secondSemi + 1).replace(/[\r\n]/g, "");
	// Do not forward clipboard-read requests (OSC 52 ; ... ; ?) to the outer terminal.
	if (payload === "?") return false;
	return /^[A-Za-z0-9+/=]*$/.test(payload);
}

function sanitizeOscPayload(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, "");
}

function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return clip(text, width);
	return " ".repeat(Math.floor((width - w) / 2)) + text;
}
