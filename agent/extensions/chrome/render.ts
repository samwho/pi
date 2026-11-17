import { homedir } from "node:os";
import { relative, isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { estimateTokens, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	parseColor,
} from "@earendil-works/pi-tui";
import type { ShellRenderer } from "./shell.ts";
import type { CallHighlighting } from "./call-highlighting.ts";
import { CHROME_TOOL, type ChromeToolComponent } from "./tool-layout.ts";
import { toolFormatter } from "./formatters/index.ts";

export type Result = {
	content?: Array<{ type: string; text?: string; mimeType?: string }>;
	details?: unknown;
	structuredContent?: unknown;
};
export type ResultStats = {
	tokens: number;
	matches?: number;
	limited?: boolean;
	summary?: string;
	subject?: string;
};
export type ToolView = {
	id: string;
	name: string;
	args: unknown;
	status: "running" | "success" | "error" | "cancelled";
	result?: Result;
	complete: boolean;
	error?: string;
	argumentsUnavailable?: boolean;
	startedAt?: number;
	durationMs?: number;
	stats?: ResultStats;
};
export type RenderEnvironment = {
	theme: Theme;
	cwd: string;
	spinner: string;
	expanded: boolean;
	invalidate: () => void;
	shell: ShellRenderer;
	highlighting: CallHighlighting;
	children: (view: ToolView) => ToolView[];
	errorHint: string;
	width?: number;
};
type Line = { text: string; indent: number; wrap?: boolean };

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function clean(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function inline(value: unknown): string {
	return typeof value === "string" ? clean(value).replace(/\s+/g, " ").trim() : "";
}
const PATH_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep the beginning and filename, without splitting wide/combined characters. */
function middlePath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	if (width <= 0) return "";
	const available = width - 1;
	const filename = path.slice(path.lastIndexOf("/") + 1);
	const prefixMinimum = Math.min(8, Math.floor(available / 3));
	const tailBudget = Math.min(
		available - prefixMinimum,
		Math.max(Math.ceil(available * 0.6), visibleWidth(filename)),
	);
	const parts = Array.from(PATH_GRAPHEMES.segment(path), (part) => part.segment);
	const fit = (segments: string[], budget: number): string[] => {
		const result: string[] = [];
		let used = 0;
		for (const segment of segments) {
			const size = visibleWidth(segment);
			if (used + size > budget) break;
			result.push(segment);
			used += size;
		}
		return result;
	};
	const prefix = fit(parts, available - tailBudget).join("");
	const suffix = fit(parts.slice().reverse(), tailBudget).reverse().join("");
	return prefix + "…" + suffix;
}

function stylePath(path: string, theme: Theme, missing = false): string {
	return path
		.split("…")
		.map((chunk) => theme.fg(missing ? "error" : "accent", chunk))
		.join(theme.fg("muted", "…"));
}

function pathLabel(value: unknown, cwd: string, width = Infinity): string {
	return middlePath(shortPath(value, cwd), width);
}

function shortPath(value: unknown, cwd: string): string {
	const path = inline(value);
	if (!isAbsolute(path)) return path;
	const local = relative(cwd, path);
	if (!local.startsWith("../") && local !== "..") return local || ".";
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
function target(name: string, input: unknown, cwd: string, pathWidth = Infinity): string {
	const args = record(input);
	if (name === "codemode" || name === "bash" || name === "powershell") return "";
	if (name === "grep" || name === "find")
		return [inline(args.pattern), pathLabel(args.path ?? ".", cwd, pathWidth)]
			.filter(Boolean)
			.join(" · ");
	if (typeof args.path === "string") return pathLabel(args.path, cwd, pathWidth);
	return inline(args.query ?? args.pattern ?? args.url ?? args.name ?? args.id);
}
function textOutput(result: Result): string {
	return clean(
		(result.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	);
}
/** Use Pi's estimator on payload content, including its fixed image allowance. */
function payloadTokens(parts: Result["content"]): number {
	const content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	> = [];
	for (const part of parts ?? []) {
		if (part.type === "text") content.push({ type: "text", text: part.text ?? "" });
		else if (part.type === "image")
			content.push({ type: "image", data: "", mimeType: part.mimeType ?? "image/png" });
	}
	return estimateTokens({ role: "user", content, timestamp: 0 });
}
function tokenLabel(parts: Result["content"]): string {
	return `~${payloadTokens(parts).toLocaleString("en-US")} tokens`;
}
function grepCount(result: Result): { matches: number; limited: boolean } {
	const details = record(result.details);
	const output = textOutput(result);
	// Match rows use path:line: text; context rows use path-line- text.
	const displayed = output
		.split("\n")
		.filter((line) => Boolean(line.match(/^.*?(?:(:\d+: )|-\d+- )/)?.[1])).length;
	const count = typeof details.matchCount === "number" ? details.matchCount : displayed;
	const limited =
		Boolean(details.matchLimitReached) || record(details.truncation).truncated === true;
	return { matches: count, limited };
}
const RESULT_STATS = new WeakMap<Result, ResultStats>();
export function resultStats(name: string, result: Result, args?: unknown): ResultStats | undefined {
	const builtin = name === "read" || name === "grep" || name === "bash" || name === "codemode";
	const formatter = toolFormatter(name);
	if (!builtin && !formatter?.result) return undefined;
	const cached = RESULT_STATS.get(result);
	if (cached) return cached;
	const tokens = payloadTokens(result.content);
	let custom: { summary: string; subject?: string } | undefined;
	try {
		custom = formatter?.result?.(result, { name, args: record(args), tokens });
	} catch {
		/* Unsupported/broken formatters keep the generic view. */
	}
	if (!builtin && !custom) return undefined;
	const stats = {
		tokens,
		...(name === "grep" ? grepCount(result) : {}),
		subject: typeof custom?.subject === "string" ? inline(custom.subject).slice(0, 512) : undefined,
		summary: typeof custom?.summary === "string" ? inline(custom.summary).slice(0, 256) : undefined,
	};
	RESULT_STATS.set(result, stats);
	return stats;
}
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.floor(seconds);
	const minutes = Math.floor(whole / 60);
	return minutes < 60
		? `${minutes}m ${whole % 60}s`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m ${whole % 60}s`;
}
function summary(view: ToolView, theme: Theme): string {
	if (view.name === "bash" || view.name === "codemode") {
		const args = record(view.args);
		const timeout = view.name === "bash" ? args.timeout : undefined;
		const elapsed =
			view.status === "running" && view.startedAt !== undefined
				? performance.now() - view.startedAt
				: view.durationMs;
		const parts: string[] = [];
		if (typeof elapsed === "number" && Number.isFinite(elapsed))
			parts.push(`${formatElapsed(elapsed)} elapsed`);
		if (typeof timeout === "number" && Number.isFinite(timeout)) parts.push(`${timeout}s timeout`);
		if (view.name === "codemode" && view.status === "running") {
			const input = payloadTokens([
				{ type: "text", text: typeof args.code === "string" ? args.code : "" },
			]);
			parts.push(`~${input.toLocaleString("en-US")} input tokens`);
		}
		const stats = view.result ? resultStats(view.name, view.result) : view.stats;
		if (stats || view.status !== "running")
			parts.push(`~${stats ? stats.tokens.toLocaleString("en-US") : "?"} output tokens`);
		return theme.fg("muted", parts.join(" · "));
	}
	if (view.status === "running") {
		const args = record(view.args);
		const text = (value: unknown) => (typeof value === "string" ? value : "");
		let payload: string[] | undefined;
		if (view.name === "write") payload = [text(args.content)];
		else if (view.name === "edit") {
			// Count matching and replacement text, so both phases show activity.
			const edits = Array.isArray(args.edits) ? (args.edits as unknown[]) : [args];
			payload = edits.flatMap((edit) => {
				const change = record(edit);
				return [text(change.oldText), text(change.newText)];
			});
		}
		if (payload)
			return theme.fg("muted", tokenLabel(payload.map((value) => ({ type: "text", text: value }))));
	}
	if (view.status !== "success") return "";
	const formatter = toolFormatter(view.name);
	if (formatter) {
		const stats =
			view.stats ?? (view.result ? resultStats(view.name, view.result, view.args) : undefined);
		const custom = stats?.summary ?? (!view.result ? formatter.unavailableSummary : undefined);
		if (custom !== undefined) return theme.fg("muted", inline(custom));
	}
	if (view.name === "read" || view.name === "grep") {
		const stats = view.stats ?? (view.result ? resultStats(view.name, view.result) : undefined);
		const tokens = `~${stats ? stats.tokens.toLocaleString("en-US") : "?"} tokens`;
		if (view.name === "read") return theme.fg("muted", tokens);
		const count = stats?.matches;
		const matches = `${count === undefined ? "?" : count.toLocaleString("en-US")}${stats?.limited ? "+" : ""} ${count === 1 && !stats?.limited ? "match" : "matches"}`;
		return theme.fg("muted", `${matches} · ${tokens}`);
	}
	if (!view.result) return "";
	const details = record(view.result.details);
	if (view.name === "edit" && typeof details.diff === "string") {
		const lines = details.diff.split("\n");
		const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
		return `${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}`;
	}
	if (view.name === "write") {
		const content = record(view.args).content;
		if (typeof content === "string")
			return theme.fg(
				"muted",
				`${content === "" ? 0 : content.replace(/\n$/, "").split("\n").length} lines`,
			);
	}
	if (view.name === "find" || view.name === "ls") {
		const output = textOutput(view.result).trim();
		return theme.fg(
			"muted",
			/^No (files|entries|results)/i.test(output)
				? "0 results"
				: `${output ? output.split("\n").length : 0} rows`,
		);
	}
	return "";
}
function expandedOutput(view: ToolView): string[] {
	if (!view.result) return [];
	const args = record(view.args);
	const details = record(view.result.details);
	const source =
		view.name === "codemode" && typeof args.code === "string"
			? args.code
			: view.name === "bash" || view.name === "powershell"
				? ""
				: JSON.stringify(args, null, 2);
	const blocks = [
		source,
		typeof details.diff === "string" ? clean(details.diff) : "",
		textOutput(view.result),
	];
	if (typeof details.fullOutputPath === "string")
		blocks.push(`Full output: ${clean(details.fullOutputPath)}`);
	return blocks
		.filter(Boolean)
		.flatMap((block) => block.split("\n").map((line) => clean(line).replace(/\t/g, "  ")));
}

/** The single content renderer for top-level calls and every nested call. */
export function renderTool(
	view: ToolView,
	env: RenderEnvironment,
	indent = 0,
	ancestors = new Set<string>(),
): Line[] {
	if (ancestors.has(view.id)) return [];
	const branch = new Set(ancestors).add(view.id);
	const { theme } = env;
	const marker =
		view.status === "running"
			? theme.fg("warning", env.spinner)
			: view.status === "error"
				? theme.fg("error", "✗")
				: view.status === "cancelled"
					? theme.fg("warning", "⊘")
					: theme.fg("success", "✓");
	const args = record(view.args);
	let customCall: { label?: string; subject?: string } | undefined;
	try {
		customCall = toolFormatter(view.name)?.call?.(args, { name: view.name });
	} catch {
		/* Keep the generic heading. */
	}
	const label = inline(customCall?.label ?? view.name.replace(/^mcp__(.*?)__/, "$1/"));
	const detail = summary(view, theme);
	const savedSubject =
		view.status !== "running" && toolFormatter(view.name)
			? (view.stats ?? (view.result ? resultStats(view.name, view.result, view.args) : undefined))
					?.subject
			: undefined;
	const prefix = `${marker} ${theme.fg("toolTitle", label)}`;
	let range = "";
	if (view.name === "read" && (typeof args.offset === "number" || typeof args.limit === "number")) {
		const start = typeof args.offset === "number" ? args.offset : 1;
		range = typeof args.limit === "number" ? `${start}–${start + args.limit - 1}` : `${start}–`;
	}
	// Reserve the trailing metadata first, then share the remaining subject
	// width between a search pattern and its path. Neither can crowd out stats.
	const subjectWidth = Math.max(
		0,
		(env.width ?? Infinity) -
			indent -
			visibleWidth(prefix) -
			1 -
			(detail ? visibleWidth(detail) + 3 : 0),
	);
	const remaining = Math.max(0, subjectWidth - (range ? visibleWidth(range) + 3 : 0));
	const search = view.name === "grep" || view.name === "find";
	const pathReserve = search
		? Math.min(visibleWidth(shortPath(args.path ?? ".", env.cwd)), 24, Math.floor(remaining / 2))
		: 0;
	const patternWidth = search
		? Math.min(visibleWidth(inline(args.pattern)), Math.max(0, remaining - 3 - pathReserve))
		: 0;
	const pathWidth = Math.max(0, remaining - (search ? patternWidth + 3 : 0));
	const subject =
		(savedSubject ??
			(customCall?.subject !== undefined
				? inline(customCall.subject)
				: target(view.name, view.args, env.cwd, pathWidth))) ||
		(view.argumentsUnavailable ? "[arguments unavailable]" : "");
	let styledSubject =
		typeof args.path === "string"
			? stylePath(subject, theme)
			: theme.fg(view.argumentsUnavailable ? "muted" : "accent", subject);
	if ((view.name === "grep" || view.name === "find") && typeof args.pattern === "string") {
		const pattern = inline(args.pattern);
		const styledPattern =
			view.name === "find" || args.literal === true
				? theme.fg("accent", pattern)
				: env.highlighting.regex(pattern, view.id, env.invalidate, theme);
		styledSubject =
			truncateToWidth(styledPattern, patternWidth, theme.fg("muted", "…")) +
			theme.fg("muted", " · ") +
			stylePath(pathLabel(args.path ?? ".", env.cwd, pathWidth), theme);
	} else if (view.name === "read" && typeof args.path === "string") {
		const missing =
			view.complete && env.highlighting.missing(args.path, env.cwd, view.id, env.invalidate);
		styledSubject = stylePath(subject, theme, missing);
		if (range) {
			const blue = parseColor(theme.appearance === "light" ? "#0969da" : "#79b8ff");
			const [start, end] = range.split("–");
			styledSubject +=
				theme.fg("muted", " · ") +
				theme.style(start, { fg: blue }) +
				theme.fg("muted", "–") +
				theme.style(end, { fg: blue });
		}
	}
	styledSubject = truncateToWidth(styledSubject, subjectWidth, theme.fg("muted", "…"));
	const title = `${prefix}${subject ? ` ${styledSubject}` : ""}${detail ? `${theme.fg("muted", " · ")}${detail}` : ""}`;
	const lines: Line[] = [{ text: title, indent }];
	const command = record(view.args).command;
	if (typeof command === "string" && (view.name === "bash" || view.name === "powershell")) {
		const source = clean(command);
		const highlighted =
			view.name === "bash"
				? env.shell.lines(source, env.cwd, view.complete, view.id, env.invalidate, theme)
				: highlightCode(source, "powershell");
		lines.push(...highlighted.map((text) => ({ text, indent: indent + 2, wrap: true })));
	}
	if (view.name === "codemode") {
		for (const child of env.children(view))
			lines.push(...renderTool(child, env, indent + 2, branch));
	}
	if (env.expanded && view.status !== "running") {
		lines.push(
			...expandedOutput(view).map((text) => ({
				text: theme.fg("toolOutput", text),
				indent: indent + 2,
				wrap: true,
			})),
		);
	} else if (view.status === "error") {
		const error = view.error ?? (view.result ? textOutput(view.result) : "");
		const errors = clean(error).trim().split("\n");
		lines.push(
			...errors
				.slice(0, 4)
				.filter(Boolean)
				.map((text) => ({ text: theme.fg("error", text), indent: indent + 2, wrap: true })),
		);
		if (errors.length > 4)
			lines.push({ text: theme.fg("muted", env.errorHint), indent: indent + 2 });
	}
	return lines;
}

/** Render content only; transcript layout owns the padding around tool groups. */
export function toolComponent(
	view: () => ToolView,
	environment: () => RenderEnvironment,
): ChromeToolComponent {
	return {
		[CHROME_TOOL]: (width, image) => {
			// ECH paints the image's protocol row without advancing the cursor or
			// interfering with iTerm's cursor-up image positioning.
			const columns = Math.max(1, width);
			const content = image === undefined ? " ".repeat(columns) : `\x1b[${columns}X${image}`;
			return environment().theme.bg("toolPendingBg", content);
		},
		render(width) {
			const columns = Math.max(1, width);
			const env = { ...environment(), width: columns };
			const lines = renderTool(view(), env);
			return lines.flatMap((line) => {
				const indent = Math.min(line.indent, Math.max(0, columns - 1));
				const available = columns - indent;
				const content = line.wrap
					? wrapTextWithAnsi(line.text.replace(/\t/g, "  "), available)
					: [truncateToWidth(line.text, available, env.theme.fg("muted", "…"))];
				return content.map((part) => {
					// Truncation inserts a full reset before its ellipsis. Keep the row's
					// background through that reset (and any wrapped/highlighted resets).
					const background = env.theme.getBgAnsi("toolPendingBg");
					const painted = part.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background);
					const row = " ".repeat(indent) + painted;
					return env.theme.bg(
						"toolPendingBg",
						row + " ".repeat(Math.max(0, columns - visibleWidth(row))),
					);
				});
			});
		},
		invalidate() {},
	};
}
