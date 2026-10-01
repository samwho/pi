import {
	highlightCode,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
	frameBodyLines,
	frameBottomWithLabel,
	getFrameStatus,
	type FrameStatus,
} from "./common/tool-frame/index.ts";
import { detectedCodeLanguage } from "./shared/code-language.ts";
import { DynamicText } from "./shared/dynamic-text.ts";
import { limitResultPreview } from "./shared/result-preview.ts";
import { frameToolCall } from "./shared/tool-heading.ts";
import {
	registerFallbackToolRenderer,
	type ToolRenderContext,
	type ToolResult,
} from "./shared/tool-renderer-patch.ts";

function valueText(value: unknown, expanded: boolean): string {
	if (typeof value === "string" && expanded) return value;
	try {
		return JSON.stringify(value, null, expanded ? 2 : undefined) ?? String(value);
	} catch {
		return "[unserialisable argument]";
	}
}

function bodyRows(
	text: string,
	status: FrameStatus,
	theme: Theme,
	width: number,
	wrap = false,
): string[] {
	const source = text.replace(/\t/g, "   ");
	const lines = wrap ? wrapTextWithAnsi(source, Math.max(1, width - 2)) : source.split("\n");
	return lines.map((line) => frameBodyLines(line, status, theme, width, { paddingX: 1 }));
}

export function renderFallbackCall(
	toolName: string,
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const entries: Array<[string, unknown]> =
		args == null
			? []
			: typeof args === "object" && !Array.isArray(args)
				? Object.entries(args)
				: [["args", args]];
	const status = getFrameStatus(context);
	return new DynamicText((width) => {
		const expanded = context.expanded === true;
		const header = frameToolCall(
			{
				name: context.displayName ?? toolName,
				arguments: expanded
					? []
					: entries.map(([key, value]) => ({
							value: `${key}=${valueText(value, false)}`,
							color: "muted",
						})),
			},
			status,
			theme,
			width,
		);
		return [
			header,
			...(expanded
				? entries.flatMap(([key, value]) =>
						bodyRows(
							theme.fg("muted", `${key}: ${valueText(value, true)}`),
							status,
							theme,
							width,
							true,
						),
					)
				: []),
			...(context.hasResult === false
				? [
						frameBottomWithLabel(
							context.executionStarted ? "running" : "waiting",
							status,
							theme,
							width,
						),
					]
				: []),
		];
	}, true);
}

type HighlightState = { source: string; language?: string };
function highlighting(source: string, context: ToolRenderContext): HighlightState {
	const retained = context.state?._fallbackHighlight as HighlightState | undefined;
	if (retained?.source === source) return retained;
	const state: HighlightState = { source };
	if (context.state) context.state._fallbackHighlight = state;
	if (source && !/\x1b(?:\[|\])/.test(source)) {
		state.language = detectedCodeLanguage(source, (language) => {
			// Retain the answer in the tool's state, even if the shared LRU evicts
			// this output. A redraw must not restart completed detection forever.
			state.language = language;
			context.invalidate?.();
		});
	}
	return state;
}

export type ToolOutputRow = string | { text: string; color?: ThemeColor };
export type ToolResultView = { lines: ToolOutputRow[]; summary?: string; language?: string };

export function renderFallbackResult(
	toolName: string,
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
	view?: ToolResultView,
): Component {
	const output =
		context.getTextOutput?.(result) ??
		(result.content ?? [])
			.flatMap((block) =>
				block.type === "text"
					? [block.text ?? ""]
					: block.type === "image"
						? [`[image: ${block.mimeType ?? "unknown"}]`]
						: [],
			)
			.join("\n");
	const status = getFrameStatus({ ...context, isPartial: options.isPartial });
	const highlighted = options.isPartial || view ? undefined : highlighting(output, context);
	const details = result.details as { fullOutputPath?: unknown } | undefined;
	const fullOutputPath =
		typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	return new DynamicText((width) => {
		const language = view?.language ?? highlighted?.language;
		let lines = view
			? view.lines.flatMap((row) => {
					const text = typeof row === "string" ? row : row.text;
					const rowLines = text.replace(/\r\n?/g, "\n").split("\n");
					return language
						? rowLines
						: rowLines.map((line) =>
								theme.fg(
									typeof row === "string" ? "toolOutput" : (row.color ?? "toolOutput"),
									line,
								),
							);
				})
			: output
				? output.replace(/\r\n?/g, "\n").split("\n")
				: [];
		if (language) {
			try {
				lines = highlightCode(lines.join("\n"), language);
			} catch {
				/* Unknown languages stay readable as plain text. */
			}
		} else if (!view) {
			lines = lines.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line));
		}
		const label = options.isPartial
			? "running"
			: context.isError
				? "✗ failed"
				: `✓ complete${view?.summary ? ` · ${view.summary}` : ""}`;
		const framed = [
			...lines.flatMap((line) => bodyRows(line, status, theme, width)),
			frameBottomWithLabel(label, status, theme, width),
		];
		const preview = limitResultPreview(
			{ render: () => framed, invalidate() {} },
			toolName,
			options.expanded,
			theme,
			context,
		).render(width);
		if (fullOutputPath && !options.expanded) {
			const location = bodyRows(
				theme.fg("muted", `Full output: ${fullOutputPath}`),
				status,
				theme,
				width,
			);
			return [...preview.slice(0, -1), ...location, preview.at(-1)!];
		}
		return preview;
	}, !options.isPartial);
}

/** Shared chrome for generic tools; definitions and execution stay untouched. */
export default function (_pi: ExtensionAPI): void {
	registerFallbackToolRenderer({
		managesResultPreview: true,
		renderCall: renderFallbackCall,
		renderResult: renderFallbackResult,
	});
}
