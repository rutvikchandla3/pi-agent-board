#!/usr/bin/env node
process.stdout.write("fake pi ready\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	const text = chunk.toString();
	process.stdout.write(`echo:${text.replace(/\r/g, "<CR>").replace(/\n/g, "<NL>")}\n`);
	if (text.includes("exit")) process.exit(0);
});
setInterval(() => {}, 1000);
