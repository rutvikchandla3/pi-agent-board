/** Live PTY attach surface for hosted agent-view rows. */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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
	private status = "connecting";
	private parserBuffer = "";
	private readonly term: XtermLike;
	private cols = 120;
	private rows = 24;

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
		this.replayScreenLog();
		this.connect();
	}

	handleInput(data: string): void {
		if (
			DETACH_KEYS.has(data) ||
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.ctrl("]")) ||
			matchesKey(data, Key.ctrl("g"))
		) {
			this.detach();
			return;
		}
		this.send({ type: "input", data });
	}

	render(width: number): string[] {
		this.resizeIfNeeded(width);
		const height = this.tui.terminal?.rows ?? 24;
		const bodyHeight = Math.max(1, height - 2);
		const body = this.project(bodyHeight, width);
		while (body.length < bodyHeight) body.unshift("");
		const header =
			this.theme.fg("accent", this.theme.bold(` ${this.opts.title} `)) +
			this.theme.fg("muted", `${this.status} · ← detach · ctrl+] detach · ctrl+g detach`);
		return [clip(header, width), ...body.map((l) => clip(l, width)), this.theme.fg("dim", "─".repeat(width))];
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
		if (!existsSync(this.opts.socketPath)) {
			this.status = "socket missing";
			return;
		}
		const socket = createConnection(this.opts.socketPath);
		this.socket = socket;
		socket.on("connect", () => {
			this.connected = true;
			this.status = "attached";
			this.send({ type: "hello", clientId: `ui-${Date.now()}`, wantOutput: true });
			this.sendResize();
			this.tui.requestRender(true);
		});
		socket.on("data", (chunk) => this.onSocketData(chunk.toString("utf8")));
		socket.on("close", () => {
			this.connected = false;
			this.status = "disconnected";
			this.tui.requestRender(true);
		});
		socket.on("error", (err) => {
			this.status = `error: ${err.message}`;
			this.tui.requestRender(true);
		});
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
	}

	private sendResize(): void {
		this.send({ type: "resize", cols: this.cols, rows: this.rows });
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
				if (msg.type === "output" && typeof msg.data === "string") this.pushOutput(msg.data);
				else if (msg.type === "hello" || msg.type === "status") this.status = "attached";
				else if (msg.type === "exit") {
					this.status = "host exited";
					this.done({ action: "closed", exitCode: msg.exitCode ?? null });
				} else if (msg.type === "error") this.status = `error: ${msg.message ?? "host error"}`;
			} catch {
				// Ignore malformed protocol lines; raw PTY data is only legal inside output.data.
			}
		}
		this.tui.requestRender(true);
	}

	private replayScreenLog(): void {
		if (!this.opts.screenLogPath || !existsSync(this.opts.screenLogPath)) return;
		try {
			const raw = readFileSync(this.opts.screenLogPath, "utf8");
			this.pushOutput(raw.slice(-100_000));
		} catch {}
	}

	private pushOutput(data: string): void {
		this.term.write(data, () => this.tui.requestRender(true));
	}

	private project(height: number, width: number): string[] {
		const out: string[] = [];
		const buf = this.term.buffer.active;
		const start = Math.max(0, buf.baseY + this.rows - height);
		const end = Math.min(buf.length, buf.baseY + this.rows);
		const reusable = buf.getNullCell();
		for (let i = start; i < end; i++) {
			out.push(clip(lineToAnsi(buf.getLine(i), reusable), width));
		}
		if (out.length === 0) out.push("Waiting for PTY output…");
		return out.slice(-height);
	}

	private close(): void {
		try {
			this.socket?.destroy();
		} catch {}
		this.socket = null;
		this.connected = false;
	}
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
