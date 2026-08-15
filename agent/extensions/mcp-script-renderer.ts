import {
	highlightCode,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/**
 * The MCP adapter owns mcpScript's execution, so re-registering the tool would
 * either shadow it or depend on the adapter's private state. Instead, decorate
 * Pi's public tool-execution component. This changes only the TUI renderer and
 * leaves the adapter's worker, approvals, and result handling untouched.
 */

const MCP_SCRIPT = "mcpScript";
const MAX_COLLAPSED_CODE_LINES = 4;
const MAX_EXPANDED_CODE_LINES = 160;
const MAX_COLLAPSED_TRACE_LINES = 6;
const MAX_EXPANDED_TRACE_LINES = 100;
const MAX_COLLAPSED_OUTPUT_LINES = 6;
const MAX_EXPANDED_OUTPUT_LINES = 300;
const PATCH = Symbol.for("pi.mcp-script-renderer.patch");

type FrameStatus = "pending" | "success" | "error";

type RenderTheme = Pick<Theme, "fg" | "bold">;

type RenderContext = {
	expanded?: boolean;
	isError?: boolean;
	isPartial?: boolean;
};

type ScriptArgs = {
	code?: unknown;
	timeoutMs?: unknown;
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

type InternalToolExecution = {
	toolName?: unknown;
};

type Renderer = (
	args: unknown,
	theme: Theme,
	context: RenderContext,
) => Component;

type ResultRenderer = (
	result: ScriptResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
) => Component;

type ToolExecutionPrototype = Record<string | symbol, unknown>;
type PatchState = {
	originalCallRenderer: (...args: unknown[]) => unknown;
	originalResultRenderer: (...args: unknown[]) => unknown;
	originalRenderShell: (...args: unknown[]) => unknown;
	callRenderer: Renderer;
	resultRenderer: ResultRenderer;
};

/** A width-aware component for a renderer that needs to draw its own frame. */
class DynamicText implements Component {
	constructor(private readonly renderText: (width: number) => string) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		return this.renderText(safeWidth)
			.split("\n")
			.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {}
}

function statusFor(context: RenderContext): FrameStatus {
	if (context.isError) return "error";
	if (context.isPartial) return "pending";
	return "success";
}

function statusColor(status: FrameStatus): "warning" | "success" | "error" {
	if (status === "pending") return "warning";
	if (status === "error") return "error";
	return "success";
}

function border(theme: RenderTheme, status: FrameStatus, text: string): string {
	return theme.fg(statusColor(status), text);
}

function frameTop(theme: RenderTheme, status: FrameStatus, title: string, width: number): string {
	if (width < 6) return truncateToWidth(title, width, "");

	const maxTitleWidth = Math.max(1, width - 6);
	const fittedTitle = truncateToWidth(title, maxTitleWidth, "…");
	const trailing = Math.max(1, width - visibleWidth(fittedTitle) - 5);
	return `${border(theme, status, "╭──")} ${fittedTitle} ${border(theme, status, "─".repeat(trailing))}`;
}

function frameBodyLine(theme: RenderTheme, status: FrameStatus, line: string, width: number): string {
	if (width === 1) return border(theme, status, "│");
	const innerWidth = Math.max(1, width - 2);
	return `${border(theme, status, "│")} ${truncateToWidth(line, innerWidth, "…")}`;
}

function frameBottom(theme: RenderTheme, status: FrameStatus, label: string, width: number): string {
	if (width < 2) return border(theme, status, "╰");

	const fittedLabel = truncateToWidth(label, Math.max(1, width - 6), "…");
	const trailing = Math.max(1, width - visibleWidth(fittedLabel) - 5);
	return `${border(theme, status, "╰──")} ${fittedLabel} ${border(theme, status, "─".repeat(trailing))}`;
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

function outputLines(result: ScriptResult, theme: RenderTheme): string[] {
	const lines: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") {
			for (const line of prettyOutputText(block.text ?? "")) {
				if (line.startsWith("[console.error]")) {
					lines.push(theme.fg("error", line));
				} else if (line.startsWith("[console.warn]")) {
					lines.push(theme.fg("warning", line));
				} else if (line.startsWith("[console.")) {
					lines.push(theme.fg("accent", line));
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

		body.push(frameBodyLine(theme, status, theme.fg("muted", "output"), width));
		body.push(...allOutput.slice(0, outputLimit).map((line) => frameBodyLine(theme, status, line, width)));
		if (allOutput.length > outputLimit) {
			body.push(frameBodyLine(theme, status, theme.fg("muted", `… ${allOutput.length - outputLimit} more output lines · Ctrl+O to expand`), width));
		}

		const callLabel = calls.length === 0 ? "complete" : `${calls.length} MCP call${calls.length === 1 ? "" : "s"}`;
		const resultLabel = failed ? `✗ ${callLabel}` : `✓ ${callLabel}`;
		return [...body, frameBottom(theme, status, resultLabel, width)].join("\n");
	});
}

function installPatch(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	const existing = prototype[PATCH] as PatchState | undefined;
	if (existing) {
		// `/reload` re-evaluates this extension while Pi keeps the TUI class
		// module alive. Update the closures so source changes take effect without
		// stacking another prototype patch.
		existing.callRenderer = renderCall;
		existing.resultRenderer = renderResult;
		return;
	}

	const originalCallRenderer = prototype.getCallRenderer;
	const originalResultRenderer = prototype.getResultRenderer;
	const originalRenderShell = prototype.getRenderShell;
	if (
		typeof originalCallRenderer !== "function" ||
		typeof originalResultRenderer !== "function" ||
		typeof originalRenderShell !== "function"
	) {
		console.warn("mcp-script-renderer: Pi's tool renderer API is unavailable; leaving the default mcpScript renderer in place.");
		return;
	}

	const state: PatchState = {
		originalCallRenderer: originalCallRenderer as (...args: unknown[]) => unknown,
		originalResultRenderer: originalResultRenderer as (...args: unknown[]) => unknown,
		originalRenderShell: originalRenderShell as (...args: unknown[]) => unknown,
		callRenderer: renderCall,
		resultRenderer: renderResult,
	};
	Object.defineProperty(prototype, PATCH, { value: state, configurable: false });

	prototype.getRenderShell = function (this: InternalToolExecution): unknown {
		if (this.toolName === MCP_SCRIPT) return "self";
		return state.originalRenderShell.call(this);
	};
	prototype.getCallRenderer = function (this: InternalToolExecution): unknown {
		if (this.toolName === MCP_SCRIPT) return state.callRenderer;
		return state.originalCallRenderer.call(this);
	};
	prototype.getResultRenderer = function (this: InternalToolExecution): unknown {
		if (this.toolName === MCP_SCRIPT) return state.resultRenderer;
		return state.originalResultRenderer.call(this);
	};
}

export default function (_pi: ExtensionAPI): void {
	installPatch();
}

export const __mcpScriptRendererInternals = {
	formatCallSubject,
	formatDuration,
	prettyOutputText,
};
