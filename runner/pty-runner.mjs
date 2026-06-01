#!/usr/bin/env node
/**
 * Detached PTY host runner.
 *
 * Owns one long-lived interactive Pi child, captures raw terminal output, and exposes
 * a small JSONL-over-Unix-socket protocol for live attach from the dashboard.
 * Uses node-pty when available; falls back to stdio pipes so tests and installs without
 * native deps still exercise the control protocol.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { readState, writeHost, writeState } from "../src/core/store.mjs";

const requireForPty = createRequire(import.meta.url);
ensureNodePtySpawnHelperExecutable();

/** @type {any|null} */
let pty = null;
try {
	pty = await import("node-pty");
} catch {
	pty = null;
}

const HEARTBEAT_MS = 1000;

function main() {
	const configPath = process.argv[2];
	if (!configPath) failEarly("pty-runner: missing config path");
	/** @type {import("../src/core/types.mjs").HostConfig|null} */
	const config = readJson(configPath, null);
	if (!config) failEarly(`pty-runner: cannot read config ${configPath}`);

	const socketPath = P.controlSocketPath(config.root, config.viewId);
	const screenLog = P.screenLogPath(config.root, config.viewId);
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {}

	/** @type {Set<import("node:net").Socket>} */
	const clients = new Set();
	let childPid = null;
	let exitCode = null;
	let stopping = false;
	/** @type {import("../src/core/types.mjs").HostStatus} */
	let host = {
		version: 1,
		viewId: config.viewId,
		mode: "pty",
		runnerPid: process.pid,
		childPid: null,
		socketPath,
		state: "starting",
		startedAt: Date.now(),
		lastSeenAt: Date.now(),
		endedAt: null,
		exitCode: null,
		error: null,
		cols: config.cols || 120,
		rows: config.rows || 36,
		attachedClients: 0,
		attachedEver: false,
	};
	const persist = () => writeHost(config.root, host);
	const broadcast = (msg) => {
		const line = JSON.stringify(msg) + "\n";
		for (const c of clients) c.write(line);
	};
	const update = (patch = {}) => {
		host = { ...host, ...patch, lastSeenAt: Date.now(), attachedClients: clients.size };
		persist();
		broadcast({ type: "status", status: host });
	};
	persist();

	const args = [...config.piArgsPrefix, "--session", config.sessionFile];
	if (config.model) args.push("--model", config.model);
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	if (config.tools) args.push("--tools", config.tools);
	if (config.initialPrompt) args.push(config.initialPrompt);

	const env = {
		...process.env,
		...(config.env || {}),
		AGENT_BOARD_ROOT: config.root,
		AGENT_BOARD_VIEW_ID: config.viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: config.root,
		AGENT_VIEW_VIEW_ID: config.viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};

	let child;
	try {
		child = spawnInteractive(config.piCommand, args, {
			cwd: config.cwd,
			env,
			cols: host.cols,
			rows: host.rows,
			allowPipeFallback: config.env?.AGENT_BOARD_ALLOW_PIPE_FALLBACK === "1" || config.env?.AGENT_VIEW_ALLOW_PIPE_FALLBACK === "1",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		update({ state: "failed", endedAt: Date.now(), exitCode: 1, error: message });
		markRowFailed(config.root, config.viewId, `PTY host failed: ${message}`);
		process.exit(1);
	}
	childPid = child.pid ?? null;
	update({ childPid, state: "alive" });

	child.onData((data) => {
		try {
			appendFileSync(screenLog, data);
		} catch {}
		broadcast({ type: "output", data });
	});
	child.onExit((code) => {
		exitCode = code ?? 0;
		update({ state: stopping ? "exited" : "exited", endedAt: Date.now(), exitCode, childPid: null });
		broadcast({ type: "exit", exitCode });
		setTimeout(() => process.exit(exitCode ?? 0), 50).unref?.();
	});
	child.onError((err) => {
		update({ state: "failed", endedAt: Date.now(), exitCode: 1, error: err instanceof Error ? err.message : String(err) });
		broadcast({ type: "error", message: host.error || "child error" });
		setTimeout(() => process.exit(1), 50).unref?.();
	});

	const server = createServer((socket) => {
		clients.add(socket);
		update({ attachedEver: true });
		socket.write(JSON.stringify({ type: "hello", status: host }) + "\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleClientLine(line, socket);
		});
		socket.on("close", () => {
			clients.delete(socket);
			update();
		});
		socket.on("error", () => {
			clients.delete(socket);
			update();
		});
	});
	server.on("error", (err) => {
		update({ state: "failed", endedAt: Date.now(), error: err instanceof Error ? err.message : String(err), exitCode: 1 });
		try { child.kill("SIGTERM"); } catch {}
		process.exit(1);
	});
	server.listen(socketPath, () => update({ socketPath, state: "alive" }));

	function handleClientLine(line, socket) {
		if (!line.trim()) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return send(socket, { type: "error", message: "invalid json" }); }
		switch (msg.type) {
			case "hello":
				send(socket, { type: "hello", status: host });
				break;
			case "input":
				if (typeof msg.data === "string") child.write(msg.data);
				break;
			case "resize": {
				const cols = clampInt(msg.cols, 20, 300, host.cols);
				const rows = clampInt(msg.rows, 5, 120, host.rows);
				child.resize(cols, rows);
				update({ cols, rows });
				break;
			}
			case "interrupt":
				child.write("\x1b");
				break;
			case "terminate":
				stopping = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 4000).unref?.();
				break;
			case "detach":
				socket.end();
				break;
			case "get_status":
				send(socket, { type: "status", status: host });
				break;
		}
	}

	const heartbeat = setInterval(() => {
		if (host.state === "alive") update();
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	const shutdown = () => {
		stopping = true;
		try { server.close(); } catch {}
		try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
		try { child.kill("SIGTERM"); } catch {}
		setTimeout(() => process.exit(0), 100).unref?.();
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

function spawnInteractive(command, args, opts) {
	ensureNodePtySpawnHelperExecutable();
	if (pty?.spawn) {
		try {
			const proc = pty.spawn(command, args, {
				name: "xterm-256color",
				cols: opts.cols,
				rows: opts.rows,
				cwd: opts.cwd,
				env: opts.env,
			});
			return {
				pid: proc.pid ?? null,
				write: (s) => proc.write(s),
				resize: (cols, rows) => proc.resize(cols, rows),
				kill: (signal) => proc.kill(signal),
				onData: (fn) => proc.onData(fn),
				onExit: (fn) => proc.onExit((e) => fn(e.exitCode ?? 0)),
				onError: () => {},
			};
		} catch (err) {
			if (!opts.allowPipeFallback) throw err;
		}
	}
	if (!opts.allowPipeFallback) throw new Error("node-pty is unavailable");

	const proc = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
	return {
		pid: proc.pid ?? null,
		write: (s) => proc.stdin.write(s),
		resize: () => {},
		kill: (signal) => proc.kill(signal),
		onData: (fn) => {
			proc.stdout.on("data", (c) => fn(c.toString()));
			proc.stderr.on("data", (c) => fn(c.toString()));
		},
		onExit: (fn) => proc.on("close", (code) => fn(code ?? 0)),
		onError: (fn) => proc.on("error", fn),
	};
}

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function ensureNodePtySpawnHelperExecutable() {
	try {
		const pkg = requireForPty.resolve("node-pty/package.json");
		const root = pkg.slice(0, -"package.json".length);
		for (const rel of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, "build/Release/spawn-helper"]) {
			const helper = root + rel;
			if (existsSync(helper)) chmodSync(helper, 0o755);
		}
	} catch {
		/* node-pty optional/unavailable */
	}
}

function markRowFailed(root, viewId, message) {
	const now = Date.now();
	const state = readState(root, viewId) ?? {
		version: 1,
		viewId,
		currentRunId: null,
		semanticState: "queued",
		processState: "exited",
		summary: "Queued",
		lastActivityAt: now,
		updatedAt: now,
		needsInput: false,
		hasError: false,
		latestAssistantPreview: "",
		latestTool: null,
		question: null,
		error: null,
	};
	state.semanticState = "failed";
	state.processState = "exited";
	state.summary = message;
	state.hasError = true;
	state.needsInput = false;
	state.error = message;
	state.updatedAt = now;
	state.lastActivityAt = now;
	writeState(root, state);
}

function failEarly(message) {
	try { appendLine("/tmp/pi-agent-board-pty-runner.err", message); } catch {}
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

main();
