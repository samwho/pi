import {
	getMarkdownTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

/** Give pi-web-search the same framed tool treatment as mcpScript without
 * replacing its tools or depending on its private implementation. */

const WEB_TOOLS = new Set(["web_search"]);
const PATCH = Symbol.for("pi.web-search-renderer.patch");
const DEFAULT_COLLAPSED_OUTPUT_LINES = 6;
const EXPANDED_OUTPUT_LINES = 180;

/** Keep the search preview consistent with the facelift configuration.
 * Invalid or absent values retain the previous compact default. */
function collapsedOutputLines(): number {
	const configured = Number.parseInt(process.env.FACELIFT_MAX_PREVIEW_LINES ?? "", 10);
	return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_COLLAPSED_OUTPUT_LINES;
}

type Status = "pending" | "success" | "error";
type RecordValue = Record<string, unknown>;
type ToolResult = { content?: Array<{ type?: string; text?: string }>; details?: unknown };
type TimerState = { startedAt?: number; endedAt?: number; interval?: ReturnType<typeof setInterval> };
type RenderContext = {
	expanded?: boolean;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	state?: TimerState;
	invalidate?: () => void;
};
type Renderer = (args: unknown, theme: Theme, context: RenderContext) => Component;
type ResultRenderer = (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) => Component;
type InternalToolExecution = { toolName?: unknown };
type ToolExecutionPrototype = Record<string | symbol, unknown>;
type PatchState = {
	originalCallRenderer: (...args: unknown[]) => unknown;
	originalResultRenderer: (...args: unknown[]) => unknown;
	originalRenderShell: (...args: unknown[]) => unknown;
	callRenderer: Renderer;
	resultRenderer: ResultRenderer;
};

class DynamicText implements Component {
	constructor(private readonly renderText: (width: number) => string | string[]) {}
	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const rendered = this.renderText(safeWidth);
		const lines = typeof rendered === "string" ? rendered.split("\n") : rendered;
		return lines.map(line => truncateToWidth(line, safeWidth, ""));
	}
	invalidate(): void {}
}

function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function status(context: RenderContext, partial: boolean): Status { return context.isError ? "error" : partial || context.isPartial ? "pending" : "success"; }
function color(s: Status): "warning" | "success" | "error" { return s === "pending" ? "warning" : s; }
function edge(theme: Theme, s: Status, value: string): string { return theme.fg(color(s), value); }

function top(theme: Theme, s: Status, title: string, width: number): string {
	if (width < 6) return truncateToWidth(title, width, "");
	const fitted = truncateToWidth(title, Math.max(1, width - 6), "…");
	return `${edge(theme, s, "╭──")} ${fitted} ${edge(theme, s, "─".repeat(Math.max(1, width - visibleWidth(fitted) - 5)))}`;
}
function body(theme: Theme, s: Status, line: string, width: number): string {
	if (width === 1) return edge(theme, s, "│");
	return `${edge(theme, s, "│")} ${truncateToWidth(line, Math.max(1, width - 2), "…")}`;
}
function bodyLines(theme: Theme, s: Status, line: string, width: number): string[] {
	if (width === 1) return [body(theme, s, line, width)];
	return wrapTextWithAnsi(line, Math.max(1, width - 2)).map(part => body(theme, s, part, width));
}
function bottom(theme: Theme, s: Status, label: string, width: number): string {
	if (width < 2) return edge(theme, s, "╰");
	// An unlabeled bottom border should be continuous, not leave the empty
	// label gap that is normally reserved after ╰──.
	if (!label) return edge(theme, s, `╰${"─".repeat(Math.max(1, width - 1))}`);
	const fitted = truncateToWidth(label, Math.max(1, width - 6), "…");
	return `${edge(theme, s, "╰──")} ${fitted} ${edge(theme, s, "─".repeat(Math.max(1, width - visibleWidth(fitted) - 5)))}`;
}
function compact(value: string, limit = 64): string { return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; }
function formatDuration(ms: number): string {
	return `${(Math.max(0, ms) / 1_000).toFixed(1)}s`;
}

function timer(context: RenderContext, running: boolean): string {
	const state = context.state;
	if (!state) return "";
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	if (running && state.startedAt !== undefined && state.interval === undefined && context.invalidate) {
		// `invalidate()` rebuilds and redraws the entire interactive tool row.
		// A 100ms interval therefore drives expensive full-screen redraws; refresh
		// once per second while retaining a tenth-of-a-second final duration.
		state.interval = setInterval(context.invalidate, 1_000);
	}
	if (!running) {
		if (state.startedAt !== undefined) state.endedAt ??= Date.now();
		if (state.interval !== undefined) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	if (state.startedAt === undefined) return "";
	return formatDuration((state.endedAt ?? Date.now()) - state.startedAt);
}

function bottomLabel(label: string, duration: string): string {
	return duration ? `${label} · ${duration}` : label;
}

function renderCall(argsValue: unknown, theme: Theme, context: RenderContext): Component {
	const args = record(argsValue);
	const toolName = text((context as RecordValue).toolName) ?? "web";
	// ToolExecutionComponent binds the renderer per tool; the name is captured below.
	return frameCall(toolName, args, theme, context);
}
function frameCall(toolName: string, args: RecordValue, theme: Theme, context: RenderContext): Component {
	const s = status(context, false);
	return new DynamicText(width => {
		const query = compact(text(args.query) ?? "no query");
		const title = theme.fg("toolTitle", theme.bold(toolName)) + theme.fg("muted", " · ") + theme.fg("muted", query);
		return top(theme, s, title, width);
	});
}

function outputMarkdown(result: ToolResult): string {
	return (result.content ?? [])
		.filter(item => item.type === "text")
		.map(item => (item.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
		.join("\n\n")
		.trim();
}

/** Pi's Markdown component renders links, lists, and Shiki-highlighted code fences. */
function renderMarkdown(markdown: string, width: number): string[] {
	if (!markdown) return [];
	return new Markdown(markdown, 0, 0, getMarkdownTheme()).render(Math.max(1, width));
}
function resultSummary(details: RecordValue): string {
	const sources = Array.isArray(details.sources) ? details.sources.length : number(details.resultCount) ?? 0;
	const provider = text(details.providerKind) ?? "native";
	const grounded = details.grounded === true ? "grounded" : "ungrounded";
	return `${provider} · ${sources} source${sources === 1 ? "" : "s"} · ${grounded}`;
}

function renderResultFor(result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext): Component {
	const details = record(result.details);
	const failed = context.isError === true || details.error === true || text(details.error) !== undefined;
	const s: Status = failed ? "error" : status(context, options.isPartial);
	const duration = timer(context, options.isPartial && !failed);
	return new DynamicText(width => {
		if (options.isPartial) {
			// Keep live execution information within the frame rather than using
			// the bottom border as a status line.
			return [
				body(theme, s, theme.fg("warning", bottomLabel("running", duration)), width),
				bottom(theme, s, "", width),
			].join("\n");
		}
		const error = text(details.error);
		const raw = outputMarkdown(result);
		const limit = options.expanded ? EXPANDED_OUTPUT_LINES : collapsedOutputLines();
		const lines = failed
			? [error ? theme.fg("error", `✗ ${error}`) : theme.fg("error", "✗ failed"), ...raw.split("\n").filter(line => line !== error)]
			: [theme.fg("success", `✓ ${resultSummary(details)}`), ...renderMarkdown(raw, Math.max(1, width - 2))];
		const shown = lines.slice(0, limit);
		if (lines.length > limit) shown.push(theme.fg("muted", `… ${lines.length - limit} more lines · Ctrl+O to expand`));
		return [...shown.flatMap(line => bodyLines(theme, s, line, width)), bottom(theme, s, bottomLabel(failed ? "failed" : "complete", duration), width)].join("\n");
	});
}

function installPatch(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	const existing = prototype[PATCH] as PatchState | undefined;
	if (existing) { existing.callRenderer = renderCall; existing.resultRenderer = renderResultFor as unknown as ResultRenderer; return; }
	const originalCallRenderer = prototype.getCallRenderer;
	const originalResultRenderer = prototype.getResultRenderer;
	const originalRenderShell = prototype.getRenderShell;
	if (typeof originalCallRenderer !== "function" || typeof originalResultRenderer !== "function" || typeof originalRenderShell !== "function") return;
	const state: PatchState = {
		originalCallRenderer: originalCallRenderer as (...args: unknown[]) => unknown,
		originalResultRenderer: originalResultRenderer as (...args: unknown[]) => unknown,
		originalRenderShell: originalRenderShell as (...args: unknown[]) => unknown,
		callRenderer: renderCall,
		resultRenderer: renderResultFor as unknown as ResultRenderer,
	};
	Object.defineProperty(prototype, PATCH, { value: state, configurable: false });
	prototype.getRenderShell = function(this: InternalToolExecution): unknown { return WEB_TOOLS.has(String(this.toolName)) ? "self" : state.originalRenderShell.call(this); };
	prototype.getCallRenderer = function(this: InternalToolExecution): unknown {
		const toolName = String(this.toolName);
		return WEB_TOOLS.has(toolName) ? ((args: unknown, theme: Theme, context: RenderContext) => frameCall(toolName, record(args), theme, context)) : state.originalCallRenderer.call(this);
	};
	prototype.getResultRenderer = function(this: InternalToolExecution): unknown {
		const toolName = String(this.toolName);
		return WEB_TOOLS.has(toolName) ? ((result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) => renderResultFor(result, options, theme, context)) : state.originalResultRenderer.call(this);
	};
}

export default function(_pi: ExtensionAPI): void {
	installPatch();
}
