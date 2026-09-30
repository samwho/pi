import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath as defaultConfigPath, ensureFaceliftDir, legacyConfigPath } from "./paths.ts";

export const VALID_DIFF_LAYOUTS = ["consistent", "split", "unified", "per-edit"] as const;
export type DiffLayoutPreference = (typeof VALID_DIFF_LAYOUTS)[number];
export type ImageProtocolPreference = "auto" | "kitty" | "iterm2" | "none";

/** All visual preferences live in `<piAgentDir>/visuals/config.json`. */
export interface WierdFaceliftConfig {
	diffLayout: DiffLayoutPreference;
	showWorkingTime: boolean;
	/** The default applies to any tool without an explicit entry. */
	previewLines: Record<string, number> & { default: number };
	highlight: { theme: string; maxChars: number; cacheLimit: number };
	diff: {
		theme: string;
		preset: string;
		colors: Record<string, string>;
		maxChars: number;
		cacheLimit: number;
		splitMinWidth: number;
		splitMinCodeWidth: number;
	};
	icons: "nerd" | "none";
	imageProtocol: ImageProtocolPreference;
	quoteUrl: string;
}

export function defaultConfig(): WierdFaceliftConfig {
	return {
		diffLayout: "consistent",
		showWorkingTime: true,
		previewLines: { default: 40, read: 10, grep: 10 },
		highlight: { theme: "auto", maxChars: 80_000, cacheLimit: 128 },
		diff: {
			theme: "github-dark",
			preset: "default",
			colors: {},
			maxChars: 80_000,
			cacheLimit: 192,
			splitMinWidth: 150,
			splitMinCodeWidth: 60,
		},
		icons: "nerd",
		imageProtocol: "auto",
		quoteUrl: "https://quotes.samwho.dev/random",
	};
}

const positiveInt = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function sanitize(raw: unknown): WierdFaceliftConfig {
	const cfg = defaultConfig();
	const obj = record(raw);
	if ((VALID_DIFF_LAYOUTS as readonly unknown[]).includes(obj.diffLayout))
		cfg.diffLayout = obj.diffLayout as DiffLayoutPreference;
	if (typeof obj.showWorkingTime === "boolean") cfg.showWorkingTime = obj.showWorkingTime;
	for (const [key, value] of Object.entries(record(obj.previewLines))) {
		if (positiveInt(value)) cfg.previewLines[key] = value;
	}
	const highlight = record(obj.highlight);
	if (typeof highlight.theme === "string" && highlight.theme.trim())
		cfg.highlight.theme = highlight.theme;
	if (positiveInt(highlight.maxChars)) cfg.highlight.maxChars = highlight.maxChars;
	if (positiveInt(highlight.cacheLimit)) cfg.highlight.cacheLimit = highlight.cacheLimit;
	const diff = record(obj.diff);
	if (typeof diff.theme === "string" && diff.theme.trim()) cfg.diff.theme = diff.theme;
	if (typeof diff.preset === "string" && diff.preset.trim()) cfg.diff.preset = diff.preset;
	if (positiveInt(diff.maxChars)) cfg.diff.maxChars = diff.maxChars;
	if (positiveInt(diff.cacheLimit)) cfg.diff.cacheLimit = diff.cacheLimit;
	if (positiveInt(diff.splitMinWidth)) cfg.diff.splitMinWidth = diff.splitMinWidth;
	if (positiveInt(diff.splitMinCodeWidth)) cfg.diff.splitMinCodeWidth = diff.splitMinCodeWidth;
	for (const [key, value] of Object.entries(record(diff.colors))) {
		if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) cfg.diff.colors[key] = value;
	}
	if (obj.icons === "nerd" || obj.icons === "none") cfg.icons = obj.icons;
	if (["auto", "kitty", "iterm2", "none"].includes(String(obj.imageProtocol)))
		cfg.imageProtocol = obj.imageProtocol as ImageProtocolPreference;
	if (typeof obj.quoteUrl === "string" && obj.quoteUrl.trim()) cfg.quoteUrl = obj.quoteUrl;
	return cfg;
}

export function previewLineLimit(toolName: string): number {
	const lines = loadConfig().previewLines;
	return lines[toolName] ?? lines.default;
}

export function getConfigPath(): string {
	return defaultConfigPath();
}

/** Missing or invalid files use defaults; Pi's process environment never overrides visual settings. */
export function loadConfig(path: string = defaultConfigPath()): WierdFaceliftConfig {
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return defaultConfig();
	}
}

export function saveConfig(cfg: WierdFaceliftConfig, path: string = defaultConfigPath()): string {
	if (path === defaultConfigPath()) ensureFaceliftDir();
	else mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sanitize(cfg), null, 2)}\n`, "utf8");
	return path;
}

/** Copy old facelift settings once; missing fields acquire the new defaults. */
export function loadOrInitConfig(path: string = defaultConfigPath()): WierdFaceliftConfig {
	if (existsSync(path)) return loadConfig(path);
	const legacyPath = legacyConfigPath();
	const seeded =
		path === defaultConfigPath() && existsSync(legacyPath)
			? loadConfig(legacyPath)
			: defaultConfig();
	try {
		saveConfig(seeded, path);
	} catch {
		// Read-only directories should not prevent the extension from loading.
	}
	return seeded;
}
