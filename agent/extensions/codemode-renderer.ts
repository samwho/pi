import { getLanguageFromPath, highlightCode, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { format } from "prettier";
import { detectedCodeLanguage } from "./shared/code-language.ts";
import { DynamicText } from "./shared/dynamic-text.ts";
import {
	frameBodyLines,
	frameBottomWithLabel,
	frameTop,
	getFrameStatus,
	type FrameStatus,
} from "./shared/tool-frame.ts";
import { registerToolRenderer, type ToolRenderContext, type ToolResult } from "./shared/tool-renderer-patch.ts";

const NESTED_OUTPUT_PREVIEW_LINES = 8;
const NESTED_OUTPUT_EXPANDED_LINES = 120;
const NESTED_OUTPUT_MAX_CHARS = 8000;
const OUTPUT_PREVIEW_LINES = 6;
const EXPANDED_OUTPUT_LINES = 300;
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

type CodemodeCall = {
	id?: string;
	name?: string;
	args?: string;
	status?: string;
	durationMs?: number;
	cost?: number;
	error?: string;
};
type CodemodeDetails = { calls?: CodemodeCall[]; fullOutputPath?: string };
type NestedOutput = { text: string; images: number; truncated: boolean };

// Nested tool results are not stored in codemode's transcript details. Keep
// bounded, display-only results for live calls; older sessions show call
// metadata without reconstructing results that Pi never recorded.
const nestedOutputs = new Map<string, Map<string, NestedOutput>>();
const redrawParents = new Map<string, () => void>();

function linesInFrame(line: string, theme: Theme, status: FrameStatus, width: number): string[] {
	return wrapTextWithAnsi(line, Math.max(1, width - 3))
		.map(part => frameBodyLines(part, status, theme, width, { paddingX: 1 }));
}

function preview(lines: string[], limit: number, theme: Theme): string[] {
	if (lines.length <= limit) return lines;
	return [...lines.slice(0, limit), theme.fg("muted", `… ${lines.length - limit} more lines · Ctrl+O to expand`)];
}

function codeLines(code: string, theme: Theme): string[] {
	const source = code.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	let highlighted = source;
	try {
		highlighted = highlightCode(source.join("\n"), "javascript");
	} catch {
		// Keep the source readable when highlighting is unavailable.
	}
	const digits = String(source.length).length;
	return highlighted.map((line, index) => `${theme.fg("dim", `${String(index + 1).padStart(digits)} │`)} ${line}`);
}

// Formatting is display-only: never change the source sent to the codemode tool.
// Cache the promise because Pi may recreate a call component on each redraw.
const formattedScripts = new Map<string, { promise: Promise<string>; value?: string }>();
function formattedScript(source: string): { promise: Promise<string>; value?: string } {
	let entry = formattedScripts.get(source);
	if (!entry) {
		entry = { promise: format(source, { parser: "babel", printWidth: 80, tabWidth: 2 })
			.then(formatted => formatted.trimEnd(), () => source) };
		const current = entry;
		void current.promise.then(value => { current.value = value; });
		formattedScripts.set(source, current);
		if (formattedScripts.size > 32) formattedScripts.delete(formattedScripts.keys().next().value!);
	}
	return entry;
}

function callStatus(call: CodemodeCall): FrameStatus {
	return call.status === "error" ? "error" : call.status === "running" ? "pending" : "success";
}

function highlightLines(source: string, language: string | undefined): string[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	if (!language || /\x1b(?:\[|\])/.test(source)) return lines;
	try {
		return highlightCode(source, language);
	} catch {
		return lines;
	}
}

function toolBox(call: CodemodeCall, output: NestedOutput | undefined, theme: Theme, width: number, expanded: boolean, invalidate?: () => void): string[] {
	const status = callStatus(call);
	const duration = typeof call.durationMs === "number" ? ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}` : "";
	const title = theme.fg("toolTitle", theme.bold(call.name ?? "tool"));
	const body: string[] = [];
	let filePath: string | undefined;
	if (call.args) {
		let args = call.args;
		try {
			const parsed: unknown = JSON.parse(args);
			args = JSON.stringify(parsed, null, 2);
			if (call.name === "read" && parsed && typeof parsed === "object" && "path" in parsed && typeof parsed.path === "string") {
				filePath = parsed.path;
			}
		} catch { /* Pi may truncate its args preview mid-JSON. */ }
		body.push(theme.fg("muted", "input"));
		body.push(...highlightLines(args, "json"));
	}
	if (output) {
		body.push(theme.fg("muted", "output"));
		const language = (filePath && getLanguageFromPath(filePath)) || detectedCodeLanguage(output.text, invalidate);
		const lines = output.text ? highlightLines(output.text, language) : [];
		body.push(...preview(lines, expanded ? NESTED_OUTPUT_EXPANDED_LINES : NESTED_OUTPUT_PREVIEW_LINES, theme));
		if (output.images) body.push(theme.fg("muted", `[${output.images} image${output.images === 1 ? "" : "s"}]`));
		if (output.truncated) body.push(theme.fg("muted", "… nested output capped for display"));
	} else if (call.error) {
		body.push(theme.fg("error", call.error));
	}
	const marker = call.status === "error" ? "✗ failed" : call.status === "cancelled" ? "⊘ cancelled" : call.status === "running" ? "… running" : "✓ complete";
	return [
		frameTop(title, status, theme, width),
		...body.flatMap(line => line.split("\n").flatMap(part => linesInFrame(part, theme, status, width))),
		frameBottomWithLabel(theme.fg("dim", marker + duration), status, theme, width),
	];
}

function outputLines(result: ToolResult, theme: Theme, failed: boolean): string[] {
	const content = result.content ?? [];
	const blocks = content[0]?.type === "text" && SCRIPT_HEADER.test(content[0].text ?? "") ? content.slice(1) : content;
	return blocks.flatMap(block => {
		if (block.type === "image") return [theme.fg("muted", `[image: ${block.mimeType ?? "unknown"}]`)];
		if (block.type !== "text" || !block.text) return [];
		return block.text.replace(/\r\n?/g, "\n").split("\n")
			.map(line => theme.fg(failed ? "error" : "toolOutput", line));
	});
}

function renderCall(args: unknown, theme: Theme, context: ToolRenderContext): Component {
	const code = (args as { code?: unknown } | null)?.code;
	const status = getFrameStatus(context);
	const title = theme.fg("toolTitle", theme.bold("codemode"));
	let displayCode = code;
	if (typeof code === "string" && code) {
		const entry = formattedScript(code);
		displayCode = entry.value ?? code;
		if (entry.value === undefined) void entry.promise.then(formatted => {
			if (displayCode !== formatted) {
				displayCode = formatted;
				context.invalidate?.();
			}
		});
	}
	return new DynamicText(width => [
		frameTop(title, status, theme, width),
		...((typeof displayCode === "string" && displayCode) ? codeLines(displayCode, theme) : [theme.fg("error", "(invalid or empty script)")])
			.flatMap(line => linesInFrame(line, theme, status, width)),
	].join("\n"));
}

function renderResult(result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext): Component {
	const details = (result.details ?? {}) as CodemodeDetails;
	const calls = Array.isArray(details.calls) ? details.calls : [];
	const failed = context.isError === true;
	const status = getFrameStatus({ isError: failed, isPartial: options.isPartial });
	if (context.toolCallId && context.invalidate) redrawParents.set(context.toolCallId, context.invalidate);
	return new DynamicText(width => {
		const body: string[] = [];
		const callFrames = calls.flatMap(call => {
			// Each nested call has its own frame, inside codemode's outer frame.
			const output = call.id && context.toolCallId ? nestedOutputs.get(context.toolCallId)?.get(call.id) : undefined;
			return toolBox(call, output, theme, Math.max(8, width - 3), options.expanded, context.invalidate)
				.map(line => frameBodyLines(line, status, theme, width, { paddingX: 1 }));
		});
		if (!options.isPartial) {
			// Nested calls already have output boxes. Keep script output only when
			// there were no calls, or when it carries a script-level failure.
			if (calls.length === 0 || failed) {
				const output = outputLines(result, theme, failed);
				if (output.length) {
					body.push(theme.fg("muted", failed ? "↳ script error" : "↳ script output"));
					body.push(...preview(output, options.expanded ? EXPANDED_OUTPUT_LINES : OUTPUT_PREVIEW_LINES, theme));
				}
				if (details.fullOutputPath && !options.expanded) body.push(theme.fg("muted", `Full output: ${details.fullOutputPath}`));
			}
		} else if (calls.length === 0) body.push(theme.fg("warning", "Running script…"));
		const label = options.isPartial ? "running" : failed ? "✗ failed" : "✓ complete";
		return [
			...callFrames,
			...body.flatMap(line => line.split("\n").flatMap(part => linesInFrame(part, theme, status, width))),
			frameBottomWithLabel(`${label} · ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, status, theme, width),
		].join("\n");
	});
}

export default function (pi: ExtensionAPI): void {
	// Register after other extensions' factories so we see their tool_result
	// transformations (notably secret redaction), never the raw result.
	pi.on("session_start", () => {
		nestedOutputs.clear();
		redrawParents.clear();
		pi.on("tool_result", event => {
			const parent = event.parentToolCallId;
			if (!parent) return;
			const text = event.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			const outputs = nestedOutputs.get(parent) ?? new Map<string, NestedOutput>();
			outputs.set(event.toolCallId, {
				text: text.slice(0, NESTED_OUTPUT_MAX_CHARS),
				images: event.content.filter(block => block.type === "image").length,
				truncated: text.length > NESTED_OUTPUT_MAX_CHARS,
			});
			if (outputs.size > 64) outputs.delete(outputs.keys().next().value!);
			nestedOutputs.set(parent, outputs);
			if (nestedOutputs.size > 32) {
				const oldest = nestedOutputs.keys().next().value!;
				nestedOutputs.delete(oldest);
				redrawParents.delete(oldest);
			}
			redrawParents.get(parent)?.();
		});
	});
	registerToolRenderer(["codemode"], {
		renderCall: (_toolName, args, theme, context) => renderCall(args, theme, context),
		renderResult: (_toolName, result, options, theme, context) => renderResult(result, options, theme, context),
	});
}
