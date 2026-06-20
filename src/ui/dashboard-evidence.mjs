/** Pure evidence panel rendering helpers for dashboard evidence mode. */
import { relativeTime, truncate } from "../core/heuristics.mjs";

/**
 * @param {{ row:any, evidence:any, diagnostics:any[], paths?:Record<string,string>, width:number, now?:number }} opts
 * @returns {string[]}
 */
export function buildEvidencePanel(opts) {
	const width = opts.width ?? 80;
	const now = opts.now ?? Date.now();
	const evidence = opts.evidence ?? {};
	const diagnostics = Array.isArray(opts.diagnostics) ? opts.diagnostics : [];
	const paths = opts.paths ?? {};
	const lines = [];
	lines.push(`Evidence / diagnostics for ${opts.row?.meta?.name ?? "session"}`);
	lines.push(`State: ${opts.row?.state?.semanticState ?? "unknown"} · Outcome: ${evidence.outcome ?? "unknown"}${evidence.ready ? " · ready" : ""}`);
	if (evidence.summary) lines.push(...wrap(`Summary: ${evidence.summary}`, width));
	lines.push("");
	lines.push(`Changed files (${evidence.fileChanges?.length ?? 0})`);
	if (evidence.fileChanges?.length) {
		for (const f of evidence.fileChanges.slice(-12)) lines.push(`  ${f.action ?? "changed"} ${f.path}${f.count > 1 ? ` ×${f.count}` : ""}`);
	} else lines.push("  —");
	lines.push("");
	lines.push(`Commands (${evidence.commands?.length ?? 0})`);
	if (evidence.commands?.length) {
		for (const c of evidence.commands.slice(-12)) {
			const status = c.status === "failed" ? "✗" : c.status === "passed" ? "✓" : c.status === "started" ? "…" : "?";
			lines.push(...wrap(`  ${status} [${c.kind ?? "other"}] ${c.command || "command"}`, width, 2));
			if (c.outputPreview) lines.push(...wrap(`    ${c.outputPreview}`, width, 2));
		}
	} else lines.push("  —");
	lines.push("");
	lines.push(`Errors (${evidence.errors?.length ?? 0})`);
	if (evidence.errors?.length) {
		for (const e of evidence.errors.slice(-8)) lines.push(...wrap(`  ${e.source ?? "error"}: ${e.message}`, width, 2));
	} else lines.push("  —");
	lines.push("");
	lines.push("Latest assistant evidence");
	const latest = evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text;
	lines.push(...wrap(`  ${latest || "—"}`, width, 8));
	lines.push("");
	lines.push(`Diagnostics (${diagnostics.length} shown)`);
	if (diagnostics.length) {
		for (const d of diagnostics.slice(-12)) {
			const age = d.at ? relativeTime(d.at, now) : "?";
			lines.push(...wrap(`  ${age} ${String(d.level ?? "info").toUpperCase()} ${d.code ?? "event"}: ${d.message ?? ""}`, width, 2));
		}
	} else lines.push("  —");
	lines.push("");
	lines.push("Artifacts");
	for (const [name, value] of Object.entries(paths)) {
		if (value) lines.push(...wrap(`  ${name}: ${value}`, width, 2));
	}
	if (Object.keys(paths).length === 0) lines.push("  —");
	return lines.map((line) => clip(line, width));
}

/** @param {string} text @param {number} width @param {number} [maxLines] */
function wrap(text, width, maxLines = 10) {
	const words = String(text ?? "").split(/\s+/);
	const out = [];
	let line = "";
	for (const word of words) {
		if (!word) continue;
		const next = line ? `${line} ${word}` : word;
		if (visibleLength(next) > width && line) {
			out.push(line);
			line = word;
		} else line = next;
		if (out.length >= maxLines) break;
	}
	if (line && out.length < maxLines) out.push(line);
	if (out.length === maxLines && words.length > 0) out[out.length - 1] = truncate(out[out.length - 1], Math.max(1, width - 1));
	return out.length ? out : [""];
}

/** @param {string} line @param {number} width */
function clip(line, width) {
	return truncate(line, Math.max(1, width));
}

/** @param {string} s */
function visibleLength(s) {
	return String(s || "").replace(/\x1b\[[0-9;]*m/g, "").length;
}
