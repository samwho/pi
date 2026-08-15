import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { extname, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type JsonObject = Record<string, unknown>;
type ResourceCounts = {
	contexts: number;
	skills: number;
	extensions: number;
};
type Quote = {
	text: string;
	author: string;
};

const EXTENSION_SUFFIXES = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const QUOTES: Quote[] = [
	{ text: "The best way out is always through.", author: "Robert Frost" },
	{
		text: "Great things are done by a series of small things brought together.",
		author: "Vincent van Gogh",
	},
	{ text: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe" },
	{ text: "Well begun is half done.", author: "Aristotle" },
	{ text: "Make it work, make it right, make it fast.", author: "Kent Beck" },
];

function readObject(path: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as JsonObject;
		}
	} catch {
		// Resource discovery is best effort; Pi remains usable if a settings file is malformed.
	}
	return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function expandHome(path: string): string {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
	return path;
}

function extensionDirectoryPaths(directory: string, paths: Set<string>): void {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		if (entry.isFile()) {
			if (EXTENSION_SUFFIXES.has(extname(entry.name))) paths.add(resolve(entryPath));
			continue;
		}
		if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;

		for (const suffix of EXTENSION_SUFFIXES) {
			const indexPath = join(entryPath, `index${suffix}`);
			if (existsSync(indexPath)) {
				paths.add(resolve(indexPath));
				break;
			}
		}
	}
}

function addExtensionPath(entry: string, baseDir: string, paths: Set<string>): void {
	const candidate = resolve(baseDir, expandHome(entry));
	let info;
	try {
		info = statSync(candidate);
	} catch {
		return;
	}

	if (info.isFile()) {
		if (EXTENSION_SUFFIXES.has(extname(candidate))) paths.add(candidate);
		return;
	}
	if (info.isDirectory()) extensionDirectoryPaths(candidate, paths);
}

function addPackageExtensions(packageDir: string, paths: Set<string>): void {
	const manifest = readObject(join(packageDir, "package.json"));
	const piManifest = objectValue(manifest?.pi);
	if (piManifest) {
		for (const entry of stringArray(piManifest.extensions)) {
			addExtensionPath(entry, packageDir, paths);
		}
		return;
	}
	extensionDirectoryPaths(join(packageDir, "extensions"), paths);
}

function addDirectPackageExtensions(packageRoot: string, paths: Set<string>): void {
	const manifest = readObject(join(packageRoot, "package.json"));
	if (!manifest) return;

	const dependencies = new Set([
		...Object.keys(objectValue(manifest.dependencies) ?? {}),
		...Object.keys(objectValue(manifest.devDependencies) ?? {}),
	]);
	for (const dependency of dependencies) {
		addPackageExtensions(join(packageRoot, "node_modules", dependency), paths);
	}
}

function addGitPackageExtensions(directory: string, paths: Set<string>): void {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
		const child = join(directory, entry.name);
		if (existsSync(join(child, "package.json"))) {
			addPackageExtensions(child, paths);
		} else {
			addGitPackageExtensions(child, paths);
		}
	}
}

function addConfiguredExtensions(settingsPath: string, baseDir: string, paths: Set<string>): void {
	const settings = readObject(settingsPath);
	for (const entry of stringArray(settings?.extensions)) {
		addExtensionPath(entry, baseDir, paths);
	}
}

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function contextFilePath(directory: string): string | undefined {
	for (const name of CONTEXT_FILE_NAMES) {
		const path = join(directory, name);
		try {
			if (statSync(path).isFile()) return resolve(path);
		} catch {
			// The next conventional filename may still exist.
		}
	}
	return undefined;
}

function systemPromptContextPaths(ctx: ExtensionContext): Set<string> {
	const paths = new Set<string>();
	const agentDir = agentDirectory();
	const projectConfigDir = join(resolve(ctx.cwd), CONFIG_DIR_NAME);
	const trusted = ctx.isProjectTrusted();
	const systemPrompt = trusted && existsSync(join(projectConfigDir, "SYSTEM.md"))
		? join(projectConfigDir, "SYSTEM.md")
		: join(agentDir, "SYSTEM.md");
	const appendSystemPrompt = trusted && existsSync(join(projectConfigDir, "APPEND_SYSTEM.md"))
		? join(projectConfigDir, "APPEND_SYSTEM.md")
		: join(agentDir, "APPEND_SYSTEM.md");
	for (const path of [systemPrompt, appendSystemPrompt]) {
		try {
			if (statSync(path).isFile()) paths.add(resolve(path));
		} catch {
			// Missing system prompt files are valid; Pi falls back to its built-in prompt.
		}
	}
	return paths;
}

function countContextFiles(ctx: ExtensionContext): number {
	const paths = systemPromptContextPaths(ctx);
	if (process.argv.includes("-nc") || process.argv.includes("--no-context-files")) return paths.size;

	const globalContext = contextFilePath(agentDirectory());
	if (globalContext) paths.add(globalContext);

	let directory = resolve(ctx.cwd);
	while (true) {
		const context = contextFilePath(directory);
		if (context) paths.add(context);
		const parent = resolve(directory, "..");
		if (parent === directory) break;
		directory = parent;
	}
	return paths.size;
}

function skillDirectoryPaths(directory: string, paths: Set<string>, includeRootFiles: boolean): void {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}

	const rootSkill = entries.find((entry) => entry.name === "SKILL.md");
	if (rootSkill) {
		const path = join(directory, rootSkill.name);
		try {
			if (statSync(path).isFile()) paths.add(resolve(path));
		} catch {
			// Ignore unreadable skill files.
		}
		return;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			skillDirectoryPaths(path, paths, false);
		} else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
			paths.add(resolve(path));
		}
	}
}

function addSkillPath(entry: string, baseDir: string, paths: Set<string>): void {
	const candidate = resolve(baseDir, expandHome(entry));
	let info;
	try {
		info = statSync(candidate);
	} catch {
		return;
	}
	if (info.isDirectory()) {
		skillDirectoryPaths(candidate, paths, true);
	} else if (info.isFile() && candidate.endsWith(".md")) {
		paths.add(candidate);
	}
}

function addPackageSkills(packageDir: string, paths: Set<string>): void {
	const manifest = readObject(join(packageDir, "package.json"));
	const piManifest = objectValue(manifest?.pi);
	if (piManifest) {
		for (const entry of stringArray(piManifest.skills)) addSkillPath(entry, packageDir, paths);
		return;
	}
	skillDirectoryPaths(join(packageDir, "skills"), paths, true);
}

function addDirectPackageSkills(packageRoot: string, paths: Set<string>): void {
	const manifest = readObject(join(packageRoot, "package.json"));
	if (!manifest) return;
	const dependencies = new Set([
		...Object.keys(objectValue(manifest.dependencies) ?? {}),
		...Object.keys(objectValue(manifest.devDependencies) ?? {}),
	]);
	for (const dependency of dependencies) {
		addPackageSkills(join(packageRoot, "node_modules", dependency), paths);
	}
}

function addGitPackageSkills(directory: string, paths: Set<string>): void {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
		const child = join(directory, entry.name);
		if (existsSync(join(child, "package.json"))) {
			addPackageSkills(child, paths);
		} else {
			addGitPackageSkills(child, paths);
		}
	}
}

function addConfiguredSkills(settingsPath: string, baseDir: string, paths: Set<string>): void {
	const settings = readObject(settingsPath);
	for (const entry of stringArray(settings?.skills)) addSkillPath(entry, baseDir, paths);
}

function countLoadedSkills(pi: ExtensionAPI, ctx: ExtensionContext): number {
	const paths = new Set<string>();
	const agentDir = agentDirectory();
	const cwd = resolve(ctx.cwd);

	if (!process.argv.includes("--no-skills")) {
		skillDirectoryPaths(join(agentDir, "skills"), paths, true);
		skillDirectoryPaths(join(os.homedir(), ".agents", "skills"), paths, false);
		addConfiguredSkills(join(agentDir, "settings.json"), agentDir, paths);
		addDirectPackageSkills(join(agentDir, "npm"), paths);
		addGitPackageSkills(join(agentDir, "git"), paths);

		if (ctx.isProjectTrusted()) {
			let directory = cwd;
			while (true) {
				const projectConfigDir = join(directory, CONFIG_DIR_NAME);
				skillDirectoryPaths(join(projectConfigDir, "skills"), paths, true);
				skillDirectoryPaths(join(directory, ".agents", "skills"), paths, false);
				const parent = resolve(directory, "..");
				if (parent === directory) break;
				directory = parent;
			}
			const projectConfigDir = join(cwd, CONFIG_DIR_NAME);
			addConfiguredSkills(join(projectConfigDir, "settings.json"), projectConfigDir, paths);
			addDirectPackageSkills(join(projectConfigDir, "npm"), paths);
			addGitPackageSkills(join(projectConfigDir, "git"), paths);
		}
	}

	for (const command of pi.getCommands()) {
		if (command.source === "skill") paths.add(command.sourceInfo.path);
	}
	return paths.size;
}

function addCommandLineExtensions(paths: Set<string>): void {
	for (let index = 2; index < process.argv.length; index += 1) {
		const argument = process.argv[index];
		if (argument === "-e" || argument === "--extension") {
			const entry = process.argv[index + 1];
			if (entry) addExtensionPath(entry, process.cwd(), paths);
			index += 1;
		} else if (argument.startsWith("--extension=")) {
			addExtensionPath(argument.slice("--extension=".length), process.cwd(), paths);
		}
	}
}

function addRegisteredExtensions(pi: ExtensionAPI, paths: Set<string>): void {
	for (const tool of pi.getAllTools()) {
		const sourceInfo = tool.sourceInfo;
		if (sourceInfo.source !== "builtin" && sourceInfo.source !== "sdk") {
			paths.add(sourceInfo.path);
		}
	}
	for (const command of pi.getCommands()) {
		if (command.source === "extension") paths.add(command.sourceInfo.path);
	}
}

function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return resolve(expandHome(configured || join(os.homedir(), ".pi", "agent")));
}

function countLoadedExtensions(pi: ExtensionAPI, ctx: ExtensionContext): number {
	const paths = new Set<string>();
	const agentDir = agentDirectory();
	const cwd = resolve(ctx.cwd);

	extensionDirectoryPaths(join(agentDir, "extensions"), paths);
	addConfiguredExtensions(join(agentDir, "settings.json"), agentDir, paths);
	addDirectPackageExtensions(join(agentDir, "npm"), paths);
	addGitPackageExtensions(join(agentDir, "git"), paths);
	addCommandLineExtensions(paths);

	if (ctx.isProjectTrusted()) {
		const projectConfigDir = join(cwd, CONFIG_DIR_NAME);
		extensionDirectoryPaths(join(projectConfigDir, "extensions"), paths);
		addConfiguredExtensions(join(projectConfigDir, "settings.json"), projectConfigDir, paths);
		addDirectPackageExtensions(join(projectConfigDir, "npm"), paths);
		addGitPackageExtensions(join(projectConfigDir, "git"), paths);
	}

	// This catches extension modules loaded from unusual package or CLI paths that
	// do not register a command and therefore cannot be found through the public API.
	addRegisteredExtensions(pi, paths);
	return paths.size;
}

function promptCountsFromOptions(
	options: BuildSystemPromptOptions | undefined,
): Pick<ResourceCounts, "contexts" | "skills"> {
	return {
		contexts: options?.contextFiles?.length ?? 0,
		skills: options?.skills?.length ?? 0,
	};
}

function displayPath(path: string): string {
	const home = os.homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
	return path;
}

function formatTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	}).format(date);
}

function wrapText(text: string, width: number): string[] {
	const words = text.split(/\s+/u).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (line && visibleWidth(candidate) > width) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

export default function (pi: ExtensionAPI): void {
	let activeCounts: ResourceCounts | undefined;
	let requestHeaderRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const startedAt = new Date();
		const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? QUOTES[0];
		const counts: ResourceCounts = {
			contexts: countContextFiles(ctx),
			skills: countLoadedSkills(pi, ctx),
			extensions: countLoadedExtensions(pi, ctx),
		};
		activeCounts = counts;
		const system = {
			os: `${os.type()} · ${os.arch()}`,
			host: os.hostname(),
			time: formatTime(startedAt),
			directory: displayPath(ctx.cwd),
		};

		ctx.ui.setHeader((tui, theme) => {
			const renderHeader = () => tui.requestRender();
			requestHeaderRender = renderHeader;

			return {
				render(width: number): string[] {
					const innerWidth = width - 4;
					if (innerWidth < 8) return [truncateToWidth(theme.fg("accent", "✦ PI"), width, "")];

					const border = (text: string) => theme.fg("borderAccent", text);
					const row = (content: string) => {
						const fitted = truncateToWidth(content, innerWidth, "");
						const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
						return `${border("│")} ${fitted}${padding} ${border("│")}`;
					};
					const label = (icon: string, name: string) =>
						`${theme.fg("accent", icon)} ${theme.bold(name.padEnd(9))}`;
					const number = (value: number) => theme.fg("success", String(value));

					const quoteText = `“${quote.text}” — ${quote.author}`;
					const quoteRows = wrapText(quoteText, Math.max(1, innerWidth - 2)).map((line, index) =>
						row(`${index === 0 ? theme.fg("warning", "❝") : " "} ${theme.fg("muted", line)}`),
					);

					return [
						border(`╭${"─".repeat(innerWidth + 2)}╮`),
						row(`${theme.fg("accent", "✦")} ${theme.bold("PI")} ${theme.fg("muted", "SESSION READY")}`),
						row(
							`${label("◈", "RESOURCES")} ${number(counts.contexts)} contexts  ${number(counts.skills)} skills  ${number(counts.extensions)} extensions`,
						),
						row(`${label("◉", "SYSTEM")} ${theme.fg("success", system.os)}`),
						row(`${label("◆", "HOST")} ${theme.fg("muted", system.host)}`),
						row(`${label("◷", "LOCAL")} ${theme.fg("warning", system.time)}`),
						row(`${label("⌂", "DIRECTORY")} ${theme.fg("text", system.directory)}`),
						row(theme.fg("borderMuted", "·".repeat(innerWidth))),
						...quoteRows,
						border(`╰${"─".repeat(innerWidth + 2)}╯`),
					];
				},
				invalidate() {},
				dispose() {
					if (requestHeaderRender === renderHeader) requestHeaderRender = undefined;
				},
			};
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !activeCounts) return;
		const promptCounts = promptCountsFromOptions(event.systemPromptOptions);
		activeCounts.contexts = systemPromptContextPaths(ctx).size + promptCounts.contexts;
		activeCounts.skills = promptCounts.skills;
		requestHeaderRender?.();
	});
}
