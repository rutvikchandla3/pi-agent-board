/** Live PTY attach surface for hosted agent-board rows. */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clampInt, mouseWheelDirection, scrollViewportTop } from "../core/pty-scroll.mjs";

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
const MOUSE_WHEEL_LINES = 5;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LOADING_TICK_MS = 120;

interface XtermLike {
	write(data: string, cb?: () => void): void;
	resize(cols: number, rows: number): void;
	buffer: {
		active: {
			baseY: number;
			length: number;
			getLine(index: number): BufferLineLike | undefined;
			getNullCell(): BufferCellLike;
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
	private readonly connectStartedAt = Date.now();
	private readonly term: XtermLike;
	private cols = 120;
	private rows = 24;
	// Absolute buffer line shown at the top of the viewport. null means follow bottom.
	private viewportTop: number | null = null;
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
		const wheel = mouseWheelDirection(data);
		if (wheel !== 0) {
			if (this.tryScrollBy(wheel * MOUSE_WHEEL_LINES)) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			if (this.tryScrollBy(this.pageSize())) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			if (this.tryScrollBy(-this.pageSize())) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.home)) {
			if (this.tryScrollToTop()) return;
			this.send({ type: "input", data });
			return;
		}
		if (matchesKey(data, Key.end)) {
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
			this.detach();
			return;
		}
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
			this.theme.fg("muted", `${this.status} · ← detach · ctrl+] detach`);
		return [clip(header, width), ...body.map((l) => clip(l, width)), this.theme.fg("dim", "─".repeat(width))];
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
	private scheduleRender(): void {
		this.tui.requestRender(this.firstPaint);
		this.firstPaint = false;
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
		try {
			this.tui.terminal.write(MOUSE_ENABLE);
		} catch {}
	}

	private refreshMouseScrollMode(): void {
		this.clearMouseRefreshTimers();
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
		this.enableMouseScroll();
		this.tui.requestRender(true);
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
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.type === "output" && typeof msg.data === "string") {
					this.pushOutput(msg.data);
					this.forceChildRedrawAfterLiveOutput();
				} else if (msg.type === "hello" || msg.type === "status") this.status = "attached";
				else if (msg.type === "exit") {
					this.status = "host exited";
					this.done({ action: "closed", exitCode: msg.exitCode ?? null });
				} else if (msg.type === "error") this.status = `error: ${msg.message ?? "host error"}`;
			} catch {
				// Ignore malformed protocol lines; raw PTY data is only legal inside output.data.
			}
		}
		this.scheduleRender();
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

	private replayScreenLog(): void {
		if (!this.opts.screenLogPath || !existsSync(this.opts.screenLogPath)) return;
		try {
			const raw = readFileSync(this.opts.screenLogPath, "utf8");
			this.pushOutput(raw.slice(-100_000));
		} catch {}
	}

	private pushOutput(data: string): void {
		if (data.length === 0) return;
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
		this.clampViewportTop(height);
		const start = this.viewportTop ?? this.bottomViewportTop(height);
		const end = Math.min(buf.length, start + height);
		const reusable = buf.getNullCell();
		for (let i = start; i < end; i++) {
			out.push(clip(lineToAnsi(buf.getLine(i), reusable), width));
		}
		if (out.length === 0) out.push("Waiting for PTY output…");
		return out.slice(-height);
	}

	private close(): void {
		this.closed = true;
		this.disableMouseScroll();
		this.clearMouseRefreshTimers();
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

function lineToAnsi(line: BufferLineLike | undefined, reusable: BufferCellLike): string {
	if (!line) return "";
	let last = -1;
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) continue;
		if (cell.getChars()) last = x;
	}
	if (last < 0) return "";

	let out = "";
	let prev = "";
	for (let x = 0; x <= last; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) continue;
		const key = attrKey(cell);
		if (key !== prev) {
			out += attrsToAnsi(cell);
			prev = key;
		}
		out += cell.getChars() || " ";
	}
	return out + "\x1b[0m";
}

function attrKey(cell: BufferCellLike): string {
	return [
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

function attrsToAnsi(cell: BufferCellLike): string {
	const codes: string[] = ["0"];
	if (cell.isBold()) codes.push("1");
	if (cell.isDim()) codes.push("2");
	if (cell.isItalic()) codes.push("3");
	if (cell.isUnderline()) codes.push("4");
	if (cell.isBlink()) codes.push("5");
	if (cell.isInverse()) codes.push("7");
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

function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return clip(text, width);
	return " ".repeat(Math.floor((width - w) / 2)) + text;
}
