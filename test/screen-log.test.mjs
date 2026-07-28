import assert from "node:assert/strict";
import { once } from "node:events";
import {
	appendFileSync,
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
	appendBoundedScreenLog,
	defaultScreenLogFs,
	readScreenLogTail,
	readScreenLogTailBytes,
	reconcileScreenLog,
} from "../src/core/screen-log.mjs";

function freshDir() {
	return mkdtempSync(join(tmpdir(), "agent-board-screen-log-"));
}

test("missing screen logs have an empty replay tail", () => {
	const dir = freshDir();
	try {
		const file = join(dir, "missing.log");
		assert.equal(readScreenLogTail(file), "");
		assert.equal(reconcileScreenLog(file), 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tail reads stay bounded for multi-gigabyte sparse logs", () => {
	const dir = freshDir();
	try {
		const file = join(dir, "screen.log");
		const fd = openSync(file, "w");
		const marker = Buffer.from("terminal-tail");
		writeSync(fd, marker, 0, marker.length, 5 * 1024 ** 3);
		closeSync(fd);
		const tail = readScreenLogTailBytes(file, 64);
		assert.equal(tail.length, 64);
		assert.equal(tail.subarray(-marker.length).toString(), marker.toString());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tail limits and compaction use bytes for multibyte text", () => {
	const dir = freshDir();
	try {
		const file = join(dir, "screen.log");
		writeFileSync(file, "🙂".repeat(20));
		assert.equal(readScreenLogTailBytes(file, 9).length, 9);
		const size = reconcileScreenLog(file, { maxBytes: 32, retainBytes: 8 });
		assert.equal(size, 8);
		assert.equal(statSync(file).size, 8);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bounded appends compact repeatedly and reduce a single oversized chunk", () => {
	const dir = freshDir();
	try {
		const file = join(dir, "screen.log");
		let size = 0;
		for (let i = 0; i < 20; i++) {
			size = appendBoundedScreenLog(file, `chunk-${i}-`, size, { maxBytes: 48, retainBytes: 12 });
			assert.ok(size <= 48);
			assert.equal(statSync(file).size, size);
		}
		size = appendBoundedScreenLog(file, Buffer.alloc(100, "z"), size, { maxBytes: 48, retainBytes: 12 });
		assert.equal(size, 12);
		assert.equal(readFileSync(file).toString(), "z".repeat(12));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed reads or replacement keep accurate over-limit size for retry", () => {
	const dir = freshDir();
	try {
		const file = join(dir, "screen.log");
		appendFileSync(file, "a".repeat(80));
		const readFailingFs = { ...defaultScreenLogFs, readSync() { throw new Error("injected read failure"); } };
		assert.equal(reconcileScreenLog(file, { maxBytes: 32, retainBytes: 8, fs: readFailingFs }), 80);
		assert.equal(statSync(file).size, 80);

		const renameFailingFs = { ...defaultScreenLogFs, renameSync() { throw new Error("injected rename failure"); } };
		const failedSize = reconcileScreenLog(file, { maxBytes: 32, retainBytes: 8, fs: renameFailingFs });
		assert.equal(failedSize, 80);
		assert.equal(statSync(file).size, 80);
		assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
		const recoveredSize = appendBoundedScreenLog(file, "b", failedSize, { maxBytes: 32, retainBytes: 8 });
		assert.equal(recoveredSize, 9);
		assert.equal(statSync(file).size, 9);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomic compaction readers observe only complete old or new tails", async () => {
	const dir = freshDir();
	try {
		const file = join(dir, "screen.log");
		writeFileSync(file, "A".repeat(8));
		const script = String.raw`
			const fs = require("node:fs");
			const file = process.argv[1];
			let done = false;
			let reads = 0;
			process.stdin.on("data", () => { done = true; });
			process.stdout.write("READY\n");
			function inspect() {
				for (let i = 0; i < 100; i++) {
					const value = fs.readFileSync(file, "utf8");
					if (value !== "AAAAAAAA" && value !== "BBBBBBBB") process.exit(2);
					reads++;
				}
				if (done) { process.stdout.write("OK " + reads + "\n"); process.exit(0); }
				setImmediate(inspect);
			}
			inspect();
		`;
		const child = spawn(process.execPath, ["-e", script, file], { stdio: ["pipe", "pipe", "inherit"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		while (!output.includes("READY\n")) await once(child.stdout, "data");
		let size = 8;
		for (let i = 0; i < 200; i++) {
			const byte = i % 2 === 0 ? "B" : "A";
			size = appendBoundedScreenLog(file, byte.repeat(100), size, { maxBytes: 32, retainBytes: 8 });
		}
		child.stdin.write("STOP\n");
		const [code] = await once(child, "exit");
		assert.equal(code, 0, output);
		assert.match(output, /OK \d+/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
