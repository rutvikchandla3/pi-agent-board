#!/usr/bin/env node
import { appendFileSync } from "node:fs";

process.stdout.write("fake pi ready\n");
if (process.env.FAKE_PTY_ARGV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ARGV_CAPTURE_PATH, `${process.argv.at(-1) ?? ""}`);
	} catch {}
}
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (chunk) => {
	const text = chunk.toString();
	const visible = text
		.replace(/\x1b\[200~/g, "<BP>")
		.replace(/\x1b\[201~/g, "<EP>")
		.replace(/\r/g, "<CR>")
		.replace(/\n/g, "<NL>");
	process.stdout.write(`echo:${visible}\n`);
	if (text.includes("exit")) process.exit(0);
});
setInterval(() => {}, 1000);
