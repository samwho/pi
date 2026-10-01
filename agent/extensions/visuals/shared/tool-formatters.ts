import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { previewLineLimit } from "../config.ts";
import {
	frameBodyLines,
	frameBottomWithLabel,
	getFrameStatus,
} from "../common/tool-frame/index.ts";
import {
	renderFallbackCall,
	renderFallbackResult,
	type ToolOutputRow,
	type ToolResultView,
} from "../fallback-renderer.ts";
import { formattedCode, type CodeFormat, type FormattedCode } from "./code-format.ts";
import { DynamicText } from "./dynamic-text.ts";
import { frameToolCall, type ToolHeading } from "./tool-heading.ts";
import {
	registerToolRenderer,
	type ToolRenderContext,
	type ToolResult,
} from "./tool-renderer-patch.ts";

export type { ToolOutputRow, ToolResultView } from "../fallback-renderer.ts";
export type ToolCallView = Omit<ToolHeading, "name"> & {
	lines?: ToolOutputRow[];
	code?: { source: string; language: string; format?: CodeFormat };
};
export type FormatterContext = {
	toolName: string;
	theme: Theme;
	context: ToolRenderContext;
	/** Extracted display text, after result decorators and terminal sanitisation. */
	text: string;
	/** Clean decoded data before rendering it (e.g. JSON can reintroduce escapes). */
	safeText: (text: string) => string;
};
export type ToolFormatter = {
	/** Omit either callback, or return undefined, to keep its shared fallback view. */
	call?: (args: unknown, context: FormatterContext) => ToolCallView | undefined;
	result?: (result: ToolResult, context: FormatterContext) => ToolResultView | undefined;
};

function safeText(text: string, context: ToolRenderContext): string {
	return (
		context.getTextOutput?.({ content: [{ type: "text", text }] }) ??
		stripTerminalSequences(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?")
	);
}
function formatterContext(
	toolName: string,
	theme: Theme,
	context: ToolRenderContext,
	result?: ToolResult,
): FormatterContext {
	return {
		toolName,
		theme,
		context,
		text: result
			? (context.getTextOutput?.(result) ??
				(result.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => safeText(block.text ?? "", context))
					.join("\n"))
			: "",
		safeText: (text) => safeText(text, context),
	};
}
function cleanRows(rows: ToolOutputRow[], clean: FormatterContext["safeText"]): ToolOutputRow[] {
	return rows.map((row) =>
		typeof row === "string" ? clean(row) : { ...row, text: clean(row.text) },
	);
}

function renderCallView(
	toolName: string,
	view: ToolCallView,
	theme: Theme,
	context: ToolRenderContext,
	clean: FormatterContext["safeText"],
): Component {
	const status = getFrameStatus(context);
	const code = view.code;
	let source = code ? clean(code.source) : undefined;
	let pending: Promise<string> | undefined;
	if (
		code?.format &&
		source &&
		(context.argsComplete || context.executionStarted || context.isPartial === false)
	) {
		const retained = context.state?._toolFormatterCode as
			| { source: string; kind: CodeFormat; entry: FormattedCode }
			| undefined;
		const entry =
			retained?.source === source && retained.kind === code.format
				? retained.entry
				: formattedCode(source, code.format);
		if (context.state) context.state._toolFormatterCode = { source, kind: code.format, entry };
		source = entry.value ?? source;
		if (entry.value === undefined) pending = entry.promise;
	}
	const component = new DynamicText((width) => {
		const rows = cleanRows(view.lines ?? [], clean).map((row) =>
			typeof row === "string" ? row : theme.fg(row.color ?? "toolOutput", row.text),
		);
		if (source !== undefined && code) {
			try {
				rows.push(...highlightCode(source, code.language));
			} catch {
				rows.push(...source.split("\n"));
			}
		}
		const body = rows.flatMap((row) =>
			frameBodyLines(row.replace(/\t/g, "   "), status, theme, width, { paddingX: 1 }).split("\n"),
		);
		const limit = previewLineLimit(toolName);
		const shown =
			!context.expanded && body.length > limit
				? [
						...body.slice(0, limit - 1),
						frameBodyLines(
							theme.fg("muted", `… ${body.length - limit + 1} more input rows · Ctrl+O to expand`),
							status,
							theme,
							width,
							{ paddingX: 1 },
						),
					]
				: body;
		return [
			frameToolCall(
				{
					...view,
					name: context.displayName ?? toolName,
					arguments: view.arguments?.map((arg) => ({ ...arg, value: clean(arg.value) })),
					details: view.details?.map(clean),
					continuations: view.continuations?.map(clean),
				},
				status,
				theme,
				width,
			),
			...shown,
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
	if (pending)
		void pending.then((value) => {
			source = value;
			component.invalidate();
			context.invalidate?.();
		});
	return component;
}

/** Choose content; shared renderers handle frames, previews, caching, and status. */
export function registerToolFormatter(toolNames: Iterable<string>, formatter: ToolFormatter): void {
	registerToolRenderer(toolNames, {
		managesResultPreview: true,
		renderCall(toolName, args, theme, context) {
			const ctx = formatterContext(toolName, theme, context);
			let view: ToolCallView | undefined;
			try {
				view = formatter.call?.(args, ctx);
			} catch {
				/* Malformed or changed arguments keep their default view. */
			}
			return view
				? renderCallView(toolName, view, theme, context, ctx.safeText)
				: renderFallbackCall(toolName, args, theme, context);
		},
		renderResult(toolName, result, options, theme, context) {
			const ctx = formatterContext(toolName, theme, context, result);
			let view: ToolResultView | undefined;
			if (!options.isPartial && !context.isError) {
				try {
					view = formatter.result?.(result, ctx);
				} catch {
					/* Unsupported output stays readable. */
				}
			}
			if (view) {
				const images = result.content?.filter((block) => block.type === "image") ?? [];
				const imageText = images.length ? context.getTextOutput?.({ content: images }) : undefined;
				view = {
					...view,
					lines: [...cleanRows(view.lines, ctx.safeText), ...(imageText ? [imageText] : [])],
					summary: view.summary ? ctx.safeText(view.summary) : undefined,
				};
			}
			return renderFallbackResult(toolName, result, options, theme, context, view);
		},
	});
}

/** Register native MCP names and codemode's identifier-safe server spelling. */
export function registerMcpToolFormatter(
	server: string,
	tool: string,
	formatter: ToolFormatter,
): void {
	const native = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
	registerToolFormatter(new Set([native, native.replace(/-/g, "_")]), formatter);
}
