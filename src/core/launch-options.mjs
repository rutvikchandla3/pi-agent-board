/**
 * Launch dialog helpers: resolve cwd suggestions, scoped model choices, and thinking options.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** @typedef {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"} ThinkingLevel */

/**
 * @typedef {Object} LaunchModelLike
 * @property {string} provider
 * @property {string} id
 * @property {string=} name
 * @property {boolean=} reasoning
 * @property {Partial<Record<ThinkingLevel, string|null>>=} thinkingLevelMap
 */

/**
 * @typedef {Object} LaunchModelChoice
 * @property {LaunchModelLike} model
 * @property {ThinkingLevel=} thinkingLevel
 */

/**
 * @typedef {Object} LaunchContext
 * @property {LaunchModelChoice[]} choices
 * @property {LaunchModelLike|null} selectedModel
 * @property {ThinkingLevel} thinking
 * @property {ThinkingLevel[]} thinkingOptions
 * @property {"scoped"|"all"} scopeSource
 */

export const THINKING_LEVELS = /** @type {const} */ (["off", "minimal", "low", "medium", "high", "xhigh"]);

/** @param {unknown} value @returns {value is ThinkingLevel} */
export function isThinkingLevel(value) {
	return typeof value === "string" && THINKING_LEVELS.includes(/** @type {ThinkingLevel} */ (value));
}

/** @param {LaunchModelLike|null|undefined} model */
export function canonicalModelRef(model) {
	return model ? `${model.provider}/${model.id}` : "";
}

/** @param {LaunchModelLike|null|undefined} a @param {LaunchModelLike|null|undefined} b */
export function sameModel(a, b) {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

/** @param {LaunchModelLike|null|undefined} model @returns {ThinkingLevel[]} */
export function supportedThinkingLevels(model) {
	if (!model?.reasoning) return ["off"];
	const map = model.thinkingLevelMap ?? {};
	const levels = THINKING_LEVELS.filter((level) => map[level] !== null);
	return levels.length ? levels : [...THINKING_LEVELS];
}

/**
 * @param {LaunchModelLike|null|undefined} model
 * @param {ThinkingLevel|undefined|null} requested
 * @param {ThinkingLevel=} fallback
 * @returns {ThinkingLevel}
 */
export function clampThinkingLevel(model, requested, fallback = "off") {
	const supported = supportedThinkingLevels(model);
	if (requested && supported.includes(requested)) return requested;
	if (supported.includes(fallback)) return fallback;
	return supported[0] ?? "off";
}

/**
 * Resolve the model choices for a cwd using pi's scoped-model settings semantics.
 * Falls back to all available models when no scoped models are configured or none resolve.
 *
 * @param {string} cwd
 * @param {LaunchModelLike[]} availableModels
 * @param {LaunchModelLike|null|undefined} preferredModel
 * @param {ThinkingLevel|undefined|null} preferredThinking
 * @returns {LaunchContext}
 */
export function resolveLaunchContext(cwd, availableModels, preferredModel, preferredThinking) {
	const settings = SettingsManager.create(cwd);
	const patterns = settings.getEnabledModels();
	const scoped = resolveScopedModels(patterns, availableModels);
	const fallbackChoices = sortModels(availableModels, preferredModel).map((model) => ({ model }));
	const choices = scoped.length ? scoped : fallbackChoices;
	const scopeSource = scoped.length ? "scoped" : "all";
	const defaultThinking = normalizeThinking(settings.getDefaultThinkingLevel()) ?? preferredThinking ?? "off";
	const selectedChoice = preferredModel ? choices.find((choice) => sameModel(choice.model, preferredModel)) : undefined;
	const selectedModel = selectedChoice?.model ?? choices[0]?.model ?? preferredModel ?? null;
	const thinkingBase = selectedChoice?.thinkingLevel ?? preferredThinking ?? defaultThinking;
	const thinking = clampThinkingLevel(selectedModel, thinkingBase, defaultThinking);
	return {
		choices,
		selectedModel,
		thinking,
		thinkingOptions: supportedThinkingLevels(selectedModel),
		scopeSource,
	};
}

/**
 * @param {string|undefined} value
 * @returns {ThinkingLevel|undefined}
 */
function normalizeThinking(value) {
	return isThinkingLevel(value) ? value : undefined;
}

/** @param {LaunchModelLike[]} models @param {LaunchModelLike|null|undefined} current */
function sortModels(models, current) {
	return [...models].sort((a, b) => {
		const aCurrent = sameModel(a, current);
		const bCurrent = sameModel(b, current);
		if (aCurrent && !bCurrent) return -1;
		if (!aCurrent && bCurrent) return 1;
		const providerCmp = a.provider.localeCompare(b.provider);
		return providerCmp !== 0 ? providerCmp : a.id.localeCompare(b.id);
	});
}

/** @param {string|undefined} patterns @param {LaunchModelLike[]} _available */
function resolveScopedModels(patterns, _available) {
	const available = Array.isArray(_available) ? _available : [];
	if (!patterns?.length) return [];
	/** @type {LaunchModelChoice[]} */
	const scoped = [];
	for (const rawPattern of patterns) {
		const pattern = String(rawPattern || "").trim();
		if (!pattern) continue;
		if (hasGlob(pattern)) {
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			/** @type {ThinkingLevel|undefined} */
			let thinkingLevel;
			if (colonIdx !== -1) {
				const suffix = pattern.slice(colonIdx + 1);
				if (isThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.slice(0, colonIdx);
				}
			}
			const matches = available.filter((model) => matchGlob(`${model.provider}/${model.id}`, globPattern) || matchGlob(model.id, globPattern));
			for (const model of matches) pushUnique(scoped, { model, thinkingLevel });
			continue;
		}
		const parsed = parseModelPattern(pattern, available);
		if (parsed.model) pushUnique(scoped, { model: parsed.model, thinkingLevel: parsed.thinkingLevel });
	}
	return scoped;
}

/** @param {LaunchModelChoice[]} choices @param {LaunchModelChoice} choice */
function pushUnique(choices, choice) {
	if (!choices.find((entry) => sameModel(entry.model, choice.model))) choices.push(choice);
}

/** @param {string} pattern */
function hasGlob(pattern) {
	return /[*?[]/.test(pattern);
}

/** @param {string} text @param {string} glob */
function matchGlob(text, glob) {
	try {
		return new RegExp(`^${globToRegExp(glob)}$`, "i").test(text);
	} catch {
		return false;
	}
}

/** @param {string} glob */
function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			out += ".*";
			continue;
		}
		if (ch === "?") {
			out += ".";
			continue;
		}
		if (ch === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end > i) {
				out += glob.slice(i, end + 1);
				i = end;
				continue;
			}
		}
		out += escapeRegExp(ch);
	}
	return out;
}

/** @param {string} text */
function escapeRegExp(text) {
	return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

/** @param {string} id */
function isAlias(id) {
	if (id.endsWith("-latest")) return true;
	return !/-\d{8}$/.test(id);
}

/** @param {string} modelReference @param {LaunchModelLike[]} availableModels */
function findExactModelReferenceMatch(modelReference, availableModels) {
	const trimmed = modelReference.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	const canonicalMatches = availableModels.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmed.slice(0, slashIndex).trim();
		const modelId = trimmed.slice(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter((model) => model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase());
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}
	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === lower);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/** @param {string} modelPattern @param {LaunchModelLike[]} availableModels */
function tryMatchModel(modelPattern, availableModels) {
	const exact = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exact) return exact;
	const lower = modelPattern.toLowerCase();
	const matches = availableModels.filter((model) => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower));
	if (!matches.length) return undefined;
	const aliases = matches.filter((model) => isAlias(model.id));
	const dated = matches.filter((model) => !isAlias(model.id));
	if (aliases.length) return aliases.sort((a, b) => b.id.localeCompare(a.id))[0];
	return dated.sort((a, b) => b.id.localeCompare(a.id))[0];
}

/** @param {string} pattern @param {LaunchModelLike[]} availableModels */
function parseModelPattern(pattern, availableModels) {
	const exact = tryMatchModel(pattern, availableModels);
	if (exact) return { model: exact, thinkingLevel: undefined };
	const lastColon = pattern.lastIndexOf(":");
	if (lastColon === -1) return { model: undefined, thinkingLevel: undefined };
	const prefix = pattern.slice(0, lastColon);
	const suffix = pattern.slice(lastColon + 1);
	if (isThinkingLevel(suffix)) {
		const result = parseModelPattern(prefix, availableModels);
		if (result.model) return { model: result.model, thinkingLevel: suffix };
		return result;
	}
	return parseModelPattern(prefix, availableModels);
}

/** @param {string} input */
function expandHome(input) {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return input;
	if (input === "~") return home;
	if (input.startsWith(`~${path.sep}`)) return path.join(home, input.slice(2));
	return input;
}

/** @param {string} value @param {string} baseCwd */
export function resolveDirectoryValue(value, baseCwd) {
	const raw = String(value || "").trim();
	if (!raw) return existsDir(baseCwd) ? path.resolve(baseCwd) : null;
	const expanded = expandHome(raw);
	const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded);
	return existsDir(resolved) ? resolved : null;
}

/**
 * @param {string} query
 * @param {string} baseCwd
 * @param {number=} limit
 * @returns {string[]}
 */
export function listDirectorySuggestions(query, baseCwd, limit = 8) {
	const raw = String(query || "").trim();
	const expanded = expandHome(raw);
	const resolved = raw ? (path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseCwd, expanded)) : path.resolve(baseCwd);
	let searchDir = resolved;
	let fragment = "";
	if (!existsDir(resolved) || !raw.endsWith(path.sep)) {
		searchDir = existsDir(resolved) ? resolved : path.dirname(resolved);
		fragment = existsDir(resolved) ? "" : path.basename(resolved);
	}
	/** @type {string[]} */
	const out = [];
	if (existsDir(resolved)) out.push(path.resolve(resolved));
	if (existsDir(searchDir)) {
		const lowerFragment = fragment.toLowerCase();
		const children = readdirSync(searchDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !lowerFragment || name.toLowerCase().includes(lowerFragment))
			.sort((a, b) => a.localeCompare(b));
		for (const name of children) out.push(path.join(searchDir, name));
	}
	return Array.from(new Set(out)).slice(0, Math.max(1, limit));
}

/** @param {string} dir */
function existsDir(dir) {
	try {
		return existsSync(dir) && statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
