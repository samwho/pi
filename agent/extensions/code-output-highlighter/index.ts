import {
	getLanguageFromPath,
	highlightCode,
	keyHint,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { detectedCodeLanguage } from "../shared/code-language.ts";
import { DynamicText } from "../shared/dynamic-text.ts";
import {
	registerToolResultDecorator,
	type ToolRenderContext,
	type ToolResult,
} from "../shared/tool-renderer-patch.ts";

const FALLBACK_PREVIEW_LINES = 10;
const PATCH = Symbol.for("pi.local-code-output-highlighter.patch");

type InternalToolExecution = {
	expanded?: boolean;
	isPartial?: boolean;
	ui?: { requestRender?: () => void };
	getTextOutput?: () => string;
};
type PrototypePatch = {
	original: (this: InternalToolExecution) => Component | undefined;
	render: (instance: InternalToolExecution) => Component | undefined;
};
type ToolExecutionPrototype = Record<string | symbol, unknown>;

type TextResultDetails = {
	_type?: unknown;
	text?: unknown;
	pattern?: unknown;
	[key: string]: unknown;
};

type ParsedGrepLine = {
	file: string;
	content: string;
	prefix: string;
};

function highlightedLines(source: string, language: string): string[] | undefined {
	try {
		return highlightCode(source, language);
	} catch {
		return undefined;
	}
}

function genericFallback(
	instance: InternalToolExecution,
	original: (this: InternalToolExecution) => Component | undefined,
): Component | undefined {
	const fallback = original.call(instance);
	const output = instance.getTextOutput?.() ?? "";
	if (!fallback || !output || instance.isPartial || /\x1b(?:\[|\])/.test(output)) return fallback;

	const language = () => detectedCodeLanguage(output, () => instance.ui?.requestRender?.());
	// Start detection now rather than waiting for the first terminal render.
	language();

	return new DynamicText((width) => {
		const detected = language();
		if (!detected) return fallback.render(width);

		const lines = output.split("\n");
		const shown = instance.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const highlighted = highlightedLines(shown.join("\n"), detected);
		if (!highlighted) return fallback.render(width);
		if (shown.length < lines.length) {
			highlighted.push(`... (${lines.length - shown.length} more lines, ${keyHint("app.tools.expand", "to expand")})`);
		}
		return highlighted;
	});
}

function installFallbackPatch(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	let state = prototype[PATCH] as PrototypePatch | undefined;
	if (!state) {
		const original = prototype.createResultFallback;
		if (typeof original !== "function") {
			console.warn("code output highlighter: Pi's fallback renderer is unavailable.");
			return;
		}
		state = {
			original: original as PrototypePatch["original"],
			render: (instance) => genericFallback(instance, original as PrototypePatch["original"]),
		};
		Object.defineProperty(prototype, PATCH, { value: state, configurable: false });
		prototype.createResultFallback = function(this: InternalToolExecution): Component | undefined {
			return state!.render(this);
		};
	} else {
		// Refresh behavior after `/reload` while retaining the true original.
		state.render = (instance) => genericFallback(instance, state!.original);
	}
}

function highlightBashResult(
	_toolName: string,
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	_theme: Theme,
	context: ToolRenderContext,
): ToolResult {
	if (options.isPartial) return result;
	const details = result.details as TextResultDetails | undefined;
	if (details?._type !== "bashResult" || typeof details.text !== "string" || !details.text) return result;

	const language = detectedCodeLanguage(details.text, context.invalidate);
	if (!language) return result;

	// Keep Pi's command-status trailer uncolored so facelift can still lift it
	// into the bottom-border label after we decorate the output body.
	const trailer = details.text.match(
		/(?:\n\n|^)Command (?:exited with code \d+|timed out after \d+ seconds|aborted)\s*$/,
	);
	const body = trailer?.index === undefined ? details.text : details.text.slice(0, trailer.index);
	const highlighted = highlightedLines(body, language);
	if (!highlighted) return result;
	const text = highlighted.join("\n") + (trailer ? details.text.slice(trailer.index) : "");
	return { ...result, details: { ...details, text } };
}

function parseGrepLine(line: string): ParsedGrepLine | undefined {
	const match = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
	if (!match) return undefined;
	const [full, file, _lineNumber, content] = match;
	return { file, content, prefix: full.slice(0, full.length - content.length) };
}

function matchRanges(text: string, pattern: string): Array<[number, number]> | undefined {
	let expression: RegExp;
	try {
		expression = new RegExp(pattern, "gi");
	} catch {
		return undefined;
	}
	const ranges: Array<[number, number]> = [];
	for (const match of text.matchAll(expression)) {
		if (match.index === undefined || match[0].length === 0) continue;
		ranges.push([match.index, match.index + match[0].length]);
	}
	return ranges;
}

/** Add inverse-video match emphasis without disturbing syntax foreground colors. */
function emphasizeAnsiRanges(highlighted: string, ranges: Array<[number, number]>): string {
	if (ranges.length === 0) return highlighted;
	let output = "";
	let sourceIndex = 0;
	let visibleIndex = 0;
	let rangeIndex = 0;
	while (sourceIndex < highlighted.length) {
		if (highlighted[sourceIndex] === "\x1b") {
			const escape = highlighted.slice(sourceIndex).match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
			if (escape) {
				output += escape;
				sourceIndex += escape.length;
				continue;
			}
		}
		const range = ranges[rangeIndex];
		if (range && visibleIndex === range[0]) output += "\x1b[7m";
		output += highlighted[sourceIndex];
		sourceIndex++;
		visibleIndex++;
		if (range && visibleIndex === range[1]) {
			output += "\x1b[27m";
			rangeIndex++;
		}
	}
	if (rangeIndex < ranges.length) output += "\x1b[27m";
	return output;
}

function highlightGrepResult(
	_toolName: string,
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	_theme: Theme,
	context: ToolRenderContext,
): ToolResult {
	if (options.isPartial) return result;
	const details = result.details as TextResultDetails | undefined;
	if (
		details?._type !== "grepResult" ||
		typeof details.text !== "string" ||
		!details.text ||
		typeof details.pattern !== "string"
	) return result;

	const parsed = details.text.split("\n").map(parseGrepLine);
	const contentByFile = new Map<string, string[]>();
	for (const line of parsed) {
		if (!line) continue;
		const contents = contentByFile.get(line.file) ?? [];
		contents.push(line.content);
		contentByFile.set(line.file, contents);
	}

	const refresh = () => {
		delete context.state?._gk;
		delete context.state?._gt;
		context.invalidate?.();
	};
	const languages = new Map<string, string | undefined>();
	for (const [file, contents] of contentByFile) {
		languages.set(file, getLanguageFromPath(file) ?? detectedCodeLanguage(contents.join("\n"), refresh));
	}

	const validPattern = matchRanges("", details.pattern) !== undefined;
	const rendered = details.text.split("\n").map((line, index) => {
		const item = parsed[index];
		if (!item) return line;
		const language = languages.get(item.file);
		const highlighted = language ? highlightedLines(item.content, language)?.[0] : undefined;
		const display = highlighted ?? item.content;
		const ranges = matchRanges(item.content, details.pattern as string);
		return `${item.prefix}${ranges ? emphasizeAnsiRanges(display, ranges) : display}`;
	});

	// Matches are already emphasized above, after syntax highlighting. Prevent
	// facelift's second regex pass from breaking on ANSI sequences. Preserve an
	// invalid pattern so facelift retains its own graceful fallback behavior.
	return {
		...result,
		details: {
			...details,
			text: rendered.join("\n"),
			pattern: validPattern ? "(?!)" : details.pattern,
		},
	};
}

export default function (_pi: ExtensionAPI): void {
	installFallbackPatch();
	registerToolResultDecorator(["bash"], highlightBashResult);
	registerToolResultDecorator(["grep"], highlightGrepResult);
}

export const __codeOutputHighlighterInternals = {
	emphasizeAnsiRanges,
	genericFallback,
	highlightBashResult,
	highlightGrepResult,
	matchRanges,
	parseGrepLine,
};
