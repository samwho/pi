import { highlightCode, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { DynamicText } from "./shared/dynamic-text.ts";
import {
	frameBodyLines,
	frameBottom as sharedFrameBottom,
	frameBottomWithLabel,
	frameTop as sharedFrameTop,
	getFrameStatus,
	type FrameStatus,
} from "./shared/tool-frame.ts";
import { registerToolRenderer, type ToolRenderContext } from "./shared/tool-renderer-patch.ts";

/**
 * The MCP adapter owns mcpScript's execution, so re-registering the tool would
 * either shadow it or depend on the adapter's private state. Instead, decorate
 * Pi's public tool-execution component. This changes only the TUI renderer and
 * leaves the adapter's worker, approvals, and result handling untouched.
 */

const MCP_SCRIPT = "mcpScript";
const MCP_PROXY = "mcp";
const MAX_COLLAPSED_CODE_LINES = 4;
const MAX_EXPANDED_CODE_LINES = 160;
const MAX_COLLAPSED_TRACE_LINES = 6;
const MAX_EXPANDED_TRACE_LINES = 100;
const MAX_COLLAPSED_OUTPUT_LINES = 6;
const MAX_EXPANDED_OUTPUT_LINES = 300;
type RenderTheme = Pick<Theme, "fg" | "bold">;
type RenderContext = ToolRenderContext;

type ScriptArgs = {
	code?: unknown;
	timeoutMs?: unknown;
};

type ProxyArgs = {
	tool?: unknown;
	args?: unknown;
	connect?: unknown;
	describe?: unknown;
	instructions?: unknown;
	search?: unknown;
	server?: unknown;
	action?: unknown;
};

type ScriptContent = {
	type: string;
	text?: string;
	mimeType?: string;
};

type ScriptResult = {
	content: ScriptContent[];
	details?: unknown;
};

type ScriptCall = {
	operation?: unknown;
	path?: unknown;
	query?: unknown;
	ok?: unknown;
	error?: unknown;
	durationMs?: unknown;
};

function statusFor(context: RenderContext): FrameStatus {
	return getFrameStatus(context);
}

function frameTop(theme: Theme, status: FrameStatus, title: string, width: number): string {
	return sharedFrameTop(title, status, theme, width);
}

function frameBodyLine(theme: Theme, status: FrameStatus, line: string, width: number): string {
	return frameBodyLines(line, status, theme, width, { paddingX: 1 });
}

function frameBottom(theme: Theme, status: FrameStatus, label: string, width: number): string {
	return label
		? frameBottomWithLabel(label, status, theme, width)
		: sharedFrameBottom(status, theme, width);
}

/** A clear in-frame boundary between the call request above and its result. */
function outputDivider(theme: RenderTheme, width: number): string {
	const label = "┄┄ output ";
	const tail = "┄".repeat(Math.max(1, width - visibleWidth(label)));
	return `${theme.fg("muted", label)}${theme.fg("dim", tail)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asCalls(value: unknown): ScriptCall[] {
	return Array.isArray(value)
		? value.filter((call): call is ScriptCall => asRecord(call) !== undefined)
		: [];
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1_000);
	return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatTimeout(value: unknown): string {
	const timeoutMs = asNumber(value);
	if (timeoutMs === undefined) return "default timeout";
	if (timeoutMs < 1_000) return `${Math.round(timeoutMs)}ms timeout`;
	return `${(timeoutMs / 1_000).toFixed(timeoutMs % 1_000 === 0 ? 0 : 1)}s timeout`;
}

function formatCallSubject(call: ScriptCall): string {
	const operation = asString(call.operation) ?? "operation";
	if (operation === "search") {
		return `search ${JSON.stringify(asString(call.query) ?? "")}`;
	}
	if (operation === "describe") return `describe ${asString(call.path) ?? "?"}`;
	if (operation === "call") return `call ${asString(call.path) ?? "?"}`;
	return operation;
}

function formatTraceLine(call: ScriptCall, theme: RenderTheme): string {
	const failed = call.ok === false;
	const marker = failed ? "✗" : "✓";
	const markerColor = failed ? "error" : "success";
	const duration = formatDuration(asNumber(call.durationMs));
	const error = failed && asString(call.error) ? ` · ${asString(call.error)}` : "";
	const suffix = [duration, error.slice(3)].filter(Boolean).join(" · ");
	const detail = suffix ? ` ${suffix}` : "";
	return `${theme.fg(markerColor, marker)} ${theme.fg("muted", formatCallSubject(call))}${theme.fg("dim", detail)}`;
}

function prettyOutputText(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const trimmed = normalized.trim();
	if (!trimmed) return [""];

	// MCP tools often return JSON as a text block. Reformat compact JSON while
	// leaving prose, Markdown, and already-pretty output alone.
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const pretty = JSON.stringify(parsed, null, 2);
			if (pretty) return pretty.split("\n");
		} catch {
			// It is ordinary text that merely starts and ends like JSON.
		}
	}

	return normalized.split("\n");
}

function isJson(text: string): boolean {
	const trimmed = text.trim();
	if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function outputLanguage(text: string, mimeType?: string): "json" | "markdown" | undefined {
	if (mimeType?.includes("json") || isJson(text)) return "json";
	const trimmed = text.trim();
	if (/^(#{1,6}\s|[-*+]\s|>\s|```|\[[^\]]+\]\([^\)]+\))/m.test(trimmed)) return "markdown";
	return undefined;
}

function highlightLines(lines: string[], language: "json" | "markdown" | undefined): string[] {
	if (!language) return lines;
	try {
		return highlightCode(lines.join("\n"), language);
	} catch {
		return lines;
	}
}

function outputLines(result: ScriptResult, theme: RenderTheme): string[] {
	const lines: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") {
			const plain = prettyOutputText(block.text ?? "");
			const highlighted = highlightLines(plain, outputLanguage(block.text ?? "", block.mimeType));
			for (let index = 0; index < highlighted.length; index++) {
				const original = plain[index] ?? "";
				const line = highlighted[index] ?? original;
				if (original.startsWith("[console.error]")) {
					lines.push(theme.fg("error", original));
				} else if (original.startsWith("[console.warn]")) {
					lines.push(theme.fg("warning", original));
				} else if (original.startsWith("[console.")) {
					lines.push(theme.fg("accent", original));
				} else {
					lines.push(theme.fg("toolOutput", line));
				}
			}
		} else if (block.type === "image") {
			lines.push(theme.fg("muted", `[image: ${block.mimeType ?? "unknown"}]`));
		}
	}
	return lines.length > 0 ? lines : [theme.fg("dim", "(no output)")];
}

function formatJson(value: unknown): string[] {
	if (typeof value === "string") {
		try {
			return JSON.stringify(JSON.parse(value), null, 2).split("\n");
		} catch {
			return value.split("\n");
		}
	}
	try {
		return JSON.stringify(value, null, 2).split("\n");
	} catch {
		return [String(value)];
	}
}

function proxyDescription(args: ProxyArgs): string {
	if (asString(args.tool)) return `call ${asString(args.tool)}${asString(args.server) ? ` @ ${asString(args.server)}` : ""}`;
	if (asString(args.connect)) return `connect ${asString(args.connect)}`;
	if (asString(args.describe)) return `describe ${asString(args.describe)}`;
	if (asString(args.instructions)) return `instructions ${asString(args.instructions)}`;
	if (asString(args.search)) return `search ${asString(args.search)}${asString(args.server) ? ` @ ${asString(args.server)}` : ""}`;
	if (asString(args.server)) return `list ${asString(args.server)}`;
	if (asString(args.action)) return asString(args.action)!;
	return "status";
}

function proxyInputLines(args: ProxyArgs, theme: RenderTheme, expanded: boolean): string[] {
	if (args.args === undefined) return [theme.fg("dim", "(no arguments)")];
	const lines = formatJson(args.args);
	const highlighted = highlightLines(lines, isJson(lines.join("\n")) ? "json" : undefined);
	const limit = expanded ? MAX_EXPANDED_CODE_LINES : MAX_COLLAPSED_CODE_LINES;
	const shown = highlighted.slice(0, limit).map((line) => theme.fg("toolOutput", line));
	if (lines.length > limit) {
		shown.push(theme.fg("muted", `… ${lines.length - limit} more line${lines.length - limit === 1 ? "" : "s"} · Ctrl+O to expand`));
	}
	return shown;
}

function codeLines(args: ScriptArgs, theme: RenderTheme, expanded: boolean): string[] {
	const code = asString(args.code)?.replace(/\r\n/g, "\n").replace(/\r/g, "\n") ?? "";
	if (!code) return [theme.fg("dim", "(empty script)")];

	const sourceLines = code.split("\n");
	const maxLines = expanded ? MAX_EXPANDED_CODE_LINES : MAX_COLLAPSED_CODE_LINES;
	const shown = sourceLines.slice(0, maxLines);
	let highlighted: string[];
	try {
		highlighted = highlightCode(shown.join("\n"), "javascript");
	} catch {
		highlighted = shown;
	}

	const numberWidth = String(Math.min(sourceLines.length, maxLines)).length;
	const lines = shown.map((line, index) => {
		const number = String(index + 1).padStart(numberWidth, " ");
		return `${theme.fg("dim", `${number} │`)} ${highlighted[index] ?? line}`;
	});

	if (sourceLines.length > maxLines) {
		const remaining = sourceLines.length - maxLines;
		lines.push(theme.fg("muted", `… ${remaining} more line${remaining === 1 ? "" : "s"} · ${expanded ? "preview capped" : "Ctrl+O to expand"}`));
	}
	return lines;
}

function renderCall(argsValue: unknown, theme: Theme, context: RenderContext): Component {
	const args = asRecord(argsValue) as ScriptArgs | undefined;
	const status = statusFor(context);
	const expanded = context.expanded === true;
	const title = `${theme.fg("toolTitle", theme.bold(MCP_SCRIPT))} ${theme.fg("muted", `· ${formatTimeout(args?.timeoutMs)}`)}`;

	return new DynamicText((width) => {
		const body = codeLines(args ?? {}, theme, expanded).map((line) => frameBodyLine(theme, status, line, width));
		return [frameTop(theme, status, title, width), ...body].join("\n");
	});
}

function renderProxyCall(argsValue: unknown, theme: Theme, context: RenderContext): Component {
	const args = (asRecord(argsValue) ?? {}) as ProxyArgs;
	const status = statusFor(context);
	const expanded = context.expanded === true;
	const title = `${theme.fg("toolTitle", theme.bold(MCP_PROXY))} ${theme.fg("muted", `· ${proxyDescription(args)}`)}`;

	return new DynamicText((width) => {
		const body = proxyInputLines(args, theme, expanded).map((line) => frameBodyLine(theme, status, line, width));
		return [frameTop(theme, status, title, width), ...body].join("\n");
	});
}

function renderResult(
	result: ScriptResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const expanded = options.expanded === true;
	const details = asRecord(result.details);
	const calls = asCalls(details?.calls);
	const allOutput = outputLines(result, theme);
	const errorMessage = asString(details?.message);
	const failed = context.isError === true || asString(details?.error) !== undefined;
	const status: FrameStatus = failed ? "error" : options.isPartial ? "pending" : "success";
	const traceLimit = expanded ? MAX_EXPANDED_TRACE_LINES : MAX_COLLAPSED_TRACE_LINES;
	const outputLimit = expanded ? MAX_EXPANDED_OUTPUT_LINES : MAX_COLLAPSED_OUTPUT_LINES;

	return new DynamicText((width) => {
		if (options.isPartial) {
			return [
				frameBodyLine(theme, status, theme.fg("warning", "Running MCP script…"), width),
				frameBottom(theme, status, "running", width),
			].join("\n");
		}

		const body: string[] = [];
		if (failed && errorMessage) {
			body.push(frameBodyLine(theme, status, theme.fg("error", `✗ ${errorMessage}`), width));
		}

		if (calls.length > 0) {
			const trace = calls.slice(0, traceLimit).map((call) => frameBodyLine(theme, status, formatTraceLine(call, theme), width));
			body.push(...trace);
			if (calls.length > traceLimit) {
				body.push(frameBodyLine(theme, status, theme.fg("muted", `… ${calls.length - traceLimit} more MCP calls · Ctrl+O to expand`), width));
			}
		}

		body.push(frameBodyLine(theme, status, outputDivider(theme, Math.max(1, width - 2)), width));
		body.push(...allOutput.slice(0, outputLimit).map((line) => frameBodyLine(theme, status, line, width)));
		if (allOutput.length > outputLimit) {
			body.push(frameBodyLine(theme, status, theme.fg("muted", `… ${allOutput.length - outputLimit} more output lines · Ctrl+O to expand`), width));
		}

		const callLabel = calls.length === 0 ? "complete" : `${calls.length} MCP call${calls.length === 1 ? "" : "s"}`;
		const resultLabel = failed ? `✗ ${callLabel}` : `✓ ${callLabel}`;
		return [...body, frameBottom(theme, status, resultLabel, width)].join("\n");
	});
}

function renderProxyResult(
	result: ScriptResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const failed = context.isError === true || asString(asRecord(result.details)?.error) !== undefined;
	const status: FrameStatus = failed ? "error" : options.isPartial ? "pending" : "success";
	const outputLimit = options.expanded ? MAX_EXPANDED_OUTPUT_LINES : MAX_COLLAPSED_OUTPUT_LINES;

	return new DynamicText((width) => {
		if (options.isPartial) {
			return [
				frameBodyLine(theme, status, theme.fg("warning", "Running MCP tool…"), width),
				frameBottom(theme, status, "running", width),
			].join("\n");
		}

		const output = outputLines(result, theme);
		const body = [
			frameBodyLine(theme, status, outputDivider(theme, Math.max(1, width - 2)), width),
			...output.slice(0, outputLimit).map((line) => frameBodyLine(theme, status, line, width)),
		];
		if (output.length > outputLimit) {
			body.push(frameBodyLine(theme, status, theme.fg("muted", `… ${output.length - outputLimit} more output lines · Ctrl+O to expand`), width));
		}
		return [...body, frameBottom(theme, status, failed ? "✗ failed" : "✓ complete", width)].join("\n");
	});
}

export default function (_pi: ExtensionAPI): void {
	registerToolRenderer([MCP_SCRIPT], {
		renderCall: (_toolName, args, theme, context) => renderCall(args, theme, context),
		renderResult: (_toolName, result, options, theme, context) => renderResult(result as ScriptResult, options, theme, context),
	});
	registerToolRenderer([MCP_PROXY], {
		renderCall: (_toolName, args, theme, context) => renderProxyCall(args, theme, context),
		renderResult: (_toolName, result, options, theme, context) => renderProxyResult(result as ScriptResult, options, theme, context),
	});
}

export const __mcpScriptRendererInternals = {
	formatCallSubject,
	formatDuration,
	prettyOutputText,
};
