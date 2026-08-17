import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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

/** Give pi-web-search the same framed tool treatment as mcpScript without
 * replacing its tools or depending on its private implementation. */

const WEB_TOOLS = new Set(["web_search"]);
const DEFAULT_COLLAPSED_OUTPUT_LINES = 6;
const EXPANDED_OUTPUT_LINES = 180;

/** Keep the search preview consistent with the facelift configuration.
 * Invalid or absent values retain the previous compact default. */
function collapsedOutputLines(): number {
	const configured = Number.parseInt(process.env.FACELIFT_MAX_PREVIEW_LINES ?? "", 10);
	return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_COLLAPSED_OUTPUT_LINES;
}

type Status = FrameStatus;
type RecordValue = Record<string, unknown>;
type ToolResult = { content?: Array<{ type?: string; text?: string }>; details?: unknown };
type TimerState = { startedAt?: number; endedAt?: number; timeout?: ReturnType<typeof setTimeout> };
type RenderContext = Omit<ToolRenderContext, "state"> & { state?: TimerState };

function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function status(context: RenderContext, partial: boolean): Status {
	return getFrameStatus({ ...context, isPartial: partial || context.isPartial });
}
function top(theme: Theme, s: Status, title: string, width: number): string {
	return sharedFrameTop(title, s, theme, width);
}
function body(theme: Theme, s: Status, line: string, width: number): string {
	return frameBodyLines(line, s, theme, width, { paddingX: 1 });
}
function bodyLines(theme: Theme, s: Status, line: string, width: number): string[] {
	return wrapTextWithAnsi(line, Math.max(1, width - 2)).map(part => body(theme, s, part, width));
}
function bottom(theme: Theme, s: Status, label: string, width: number): string {
	return label ? frameBottomWithLabel(label, s, theme, width) : sharedFrameBottom(s, theme, width);
}
function compact(value: string, limit = 64): string { return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; }
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatDuration(ms: number): string {
	// Keep the value on the same tenth-second boundaries as the redraws.
	return `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`;
}

function timer(context: RenderContext, running: boolean): string {
	const state = context.state;
	if (!state) return "";
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	if (running && state.startedAt !== undefined && state.timeout === undefined && context.invalidate) {
		// Sleep only until the next wall-clock tenth-second boundary. Scheduling a
		// fixed 100ms delay after each render gradually drifts and skips bumps.
		const delay = 100 - (Date.now() % 100);
		state.timeout = setTimeout(() => {
			state.timeout = undefined;
			context.invalidate?.();
		}, delay);
	}
	if (!running) {
		if (state.startedAt !== undefined) state.endedAt ??= Date.now();
		if (state.timeout !== undefined) {
			clearTimeout(state.timeout);
			state.timeout = undefined;
		}
	}
	if (state.startedAt === undefined) return "";
	return formatDuration((state.endedAt ?? Date.now()) - state.startedAt);
}

function spinner(context: RenderContext): string {
	const startedAt = context.state?.startedAt;
	return SPINNER_FRAMES[Math.floor(((Date.now() - (startedAt ?? Date.now())) / 100)) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

function bottomLabel(label: string, duration: string): string {
	return duration ? `${label} · ${duration}` : label;
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
			return [
				body(theme, s, theme.fg("warning", spinner(context)), width),
				bottom(theme, s, bottomLabel("searching", duration), width),
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

export default function(_pi: ExtensionAPI): void {
	registerToolRenderer(WEB_TOOLS, {
		renderCall: (toolName, args, theme, context) => frameCall(toolName, record(args), theme, context as RenderContext),
		renderResult: (_toolName, result, options, theme, context) => renderResultFor(result as ToolResult, options, theme, context as RenderContext),
	});
}
