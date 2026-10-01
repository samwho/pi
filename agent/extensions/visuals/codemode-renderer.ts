import {
	getLanguageFromPath,
	highlightCode,
	InteractiveMode,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { formattedCode as formattedScript } from "./shared/code-format.ts";
import { previewLineLimit } from "./config.ts";
import { detectedCodeLanguage } from "./shared/code-language.ts";
import { DynamicText } from "./shared/dynamic-text.ts";
import {
	frameBodyLines,
	frameBottomWithLabel,
	frameRail,
	getFrameStatus,
	type FrameStatus,
} from "./common/tool-frame/index.ts";
import {
	registerToolRenderer,
	type ToolRenderContext,
	type ToolResult,
} from "./shared/tool-renderer-patch.ts";
import { frameToolCall } from "./shared/tool-heading.ts";

const NESTED_OUTPUT_MAX_CHARS = 8000;
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const GROUP_INDENT = 1;

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
type FallbackOutput = { text: string; images: number; truncated: boolean };
type NestedOutput = {
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
};
type ModeBridge = {
	ui: ConstructorParameters<typeof ToolExecutionComponent>[5];
	sessionManager: { getCwd(): string };
	getRegisteredToolDefinition(
		name: string,
	): ConstructorParameters<typeof ToolExecutionComponent>[4];
};

// Pi does not persist nested results in the transcript. For live calls, reuse
// the *actual* registered tool definition and ToolExecutionComponent so the
// same facelift/diff renderers are used inside and outside codemode.
const nestedOutputs = new Map<string, Map<string, NestedOutput>>();
const nestedComponents = new Map<
	string,
	Map<string, { component: ToolExecutionComponent; output: NestedOutput; expanded: boolean }>
>();
const redrawParents = new Map<string, () => void>();
let activeMode: ModeBridge | undefined;
const MODE_PATCH = Symbol.for("pi.local-codemode-renderer.mode-bridge");

function installModeBridge(): void {
	type Patch = {
		original: ModeBridge["getRegisteredToolDefinition"];
		capture: (mode: ModeBridge) => void;
	};
	const prototype = InteractiveMode.prototype as unknown as ModeBridge & { [MODE_PATCH]?: Patch };
	let patch = prototype[MODE_PATCH];
	if (!patch) {
		// The saved method is always invoked with its original mode as `this`.
		// oxlint-disable-next-line typescript/unbound-method
		const original = prototype.getRegisteredToolDefinition;
		if (typeof original !== "function") return;
		patch = { original, capture: () => {} };
		Object.defineProperty(prototype, MODE_PATCH, { value: patch });
		prototype.getRegisteredToolDefinition = function (this: ModeBridge, name: string) {
			if (name === "codemode") patch!.capture(this);
			return patch!.original.call(this, name);
		};
	}
	// The prototype outlives extension reloads; point it at the current session.
	patch.capture = (mode) => {
		activeMode = mode;
	};
}

function linesInFrame(line: string, theme: Theme, status: FrameStatus, width: number): string[] {
	return frameBodyLines(line.replace(/\t/g, "   "), status, theme, width, { paddingX: 1 }).split(
		"\n",
	);
}

/** A single rail groups the script and its native tool rows without changing their renderers. */
export function grouped(lines: string[], theme: Theme, width: number): string[] {
	const rail = frameRail(theme, "borderMuted");
	const innerWidth = Math.max(1, width - GROUP_INDENT);
	// Native tool rows are already padded to the terminal width. Their final
	// space is the one column needed for this rail; avoid re-scanning every
	// highlighted ANSI line just to remove that padding column.
	return lines.map((line) => {
		if (line.endsWith(" ") && !line.includes("\x1b]8;") && visibleWidth(line) === width)
			return rail + line.slice(0, -1) + "\x1b[0m";
		return rail + truncateToWidth(line, innerWidth, "");
	});
}

function preview(lines: string[], limit: number, theme: Theme): string[] {
	if (lines.length <= limit) return lines;
	return [
		...lines.slice(0, limit),
		theme.fg("muted", `… ${lines.length - limit} more lines · Ctrl+O to expand`),
	];
}

function codeLines(code: string, theme: Theme, width: number): string[] {
	const source = code.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	let highlighted = source;
	try {
		// Highlight the current source, even while incomplete. This changes
		// colours but not layout; Prettier still waits for the final input.
		highlighted = highlightCode(source.join("\n"), "javascript");
	} catch {
		// Invalid partial JavaScript stays visible as plain text.
	}
	const digits = Math.max(2, String(source.length).length);
	const contentWidth = Math.max(1, width - digits - 6);
	return highlighted.flatMap((line, index) =>
		wrapTextWithAnsi(line, contentWidth).map((part, row) => {
			const gutter = `${row === 0 ? String(index + 1).padStart(digits) : " ".repeat(digits)} │`;
			return `${theme.fg("dim", gutter)} ${part}`;
		}),
	);
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

function toolBox(
	call: CodemodeCall,
	output: FallbackOutput | undefined,
	theme: Theme,
	width: number,
	expanded: boolean,
	invalidate?: () => void,
): string[] {
	const status = callStatus(call);
	const duration =
		typeof call.durationMs === "number"
			? ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`
			: "";
	const body: string[] = [];
	let filePath: string | undefined;
	if (call.args) {
		let args = call.args;
		try {
			const parsed: unknown = JSON.parse(args);
			args = JSON.stringify(parsed, null, 2);
			if (
				call.name === "read" &&
				parsed &&
				typeof parsed === "object" &&
				"path" in parsed &&
				typeof parsed.path === "string"
			) {
				filePath = parsed.path;
			}
		} catch {
			/* Pi may truncate its args preview mid-JSON. */
		}
		body.push(theme.fg("muted", "input"));
		body.push(...highlightLines(args, "json"));
	}
	if (output) {
		body.push(theme.fg("muted", "output"));
		const language =
			(filePath && getLanguageFromPath(filePath)) || detectedCodeLanguage(output.text, invalidate);
		const lines = output.text ? highlightLines(output.text, language) : [];
		body.push(...preview(lines, expanded ? Infinity : previewLineLimit(call.name ?? ""), theme));
		if (output.images)
			body.push(theme.fg("muted", `[${output.images} image${output.images === 1 ? "" : "s"}]`));
		if (output.truncated) body.push(theme.fg("muted", "… nested output capped for display"));
	} else if (call.error) {
		body.push(theme.fg("error", call.error));
	}
	const marker =
		call.status === "error"
			? "✗ failed"
			: call.status === "cancelled"
				? "⊘ cancelled"
				: call.status === "running"
					? "… running"
					: "✓ complete";
	return [
		frameToolCall({ name: call.name ?? "tool" }, status, theme, width),
		...body.flatMap((line) =>
			line.split("\n").flatMap((part) => linesInFrame(part, theme, status, width)),
		),
		frameBottomWithLabel(theme.fg("dim", marker + duration), status, theme, width),
	];
}

function nestedCallLines(
	call: CodemodeCall,
	parentId: string | undefined,
	theme: Theme,
	width: number,
	expanded: boolean,
	invalidate?: () => void,
): string[] {
	const output = call.id && parentId ? nestedOutputs.get(parentId)?.get(call.id) : undefined;
	if (output && parentId && call.id && activeMode) {
		try {
			const children =
				nestedComponents.get(parentId) ??
				new Map<
					string,
					{ component: ToolExecutionComponent; output: NestedOutput; expanded: boolean }
				>();
			let cached = children.get(call.id);
			if (!cached || cached.output !== output) {
				const mode = activeMode;
				let mounted = false;
				const childUi = {
					requestRender: () => {
						// Deferred highlighting invalidates the child, but the cached
						// parent also needs rebuilding before those rows become visible.
						if (mounted) invalidate?.();
						mode.ui.requestRender();
					},
				};
				const component = new ToolExecutionComponent(
					call.name ?? "tool",
					call.id,
					output.input,
					{},
					mode.getRegisteredToolDefinition(call.name ?? "tool"),
					childUi as typeof mode.ui,
					mode.sessionManager.getCwd(),
				);
				component.markExecutionStarted();
				component.setArgsComplete();
				component.updateResult({
					content: output.content,
					details: output.details,
					isError: output.isError,
				});
				mounted = true;
				cached = { component, output, expanded: false };
				children.set(call.id, cached);
				nestedComponents.set(parentId, children);
			}
			// setExpanded rebuilds the native renderer and clears Text's cache.
			// On a TUI redraw the parent's expansion usually hasn't changed.
			if (cached.expanded !== expanded) {
				cached.component.setExpanded(expanded);
				cached.expanded = expanded;
			}
			const lines = cached.component.render(width);
			// Native tool rows add a leading spacer for top-level transcript
			// layout. The grouping rail already separates adjacent boxes.
			return lines[0] === "" ? lines.slice(1) : lines;
		} catch {
			// Unknown or changed Pi renderer internals: use the metadata fallback.
		}
	}
	// Historical nested results only retain a short args preview and status.
	const fallbackText = output?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	return toolBox(
		call,
		output
			? {
					text: expanded
						? (fallbackText ?? "")
						: (fallbackText ?? "").slice(0, NESTED_OUTPUT_MAX_CHARS),
					images: output.content.filter((block) => block.type === "image").length,
					truncated: !expanded && (fallbackText?.length ?? 0) > NESTED_OUTPUT_MAX_CHARS,
				}
			: undefined,
		theme,
		width,
		expanded,
		invalidate,
	);
}

function outputLines(result: ToolResult, theme: Theme, failed: boolean): string[] {
	const content = result.content ?? [];
	const blocks =
		content[0]?.type === "text" && SCRIPT_HEADER.test(content[0].text ?? "")
			? content.slice(1)
			: content;
	return blocks.flatMap((block) => {
		if (block.type === "image")
			return [theme.fg("muted", `[image: ${block.mimeType ?? "unknown"}]`)];
		if (block.type !== "text" || !block.text) return [];
		return block.text
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => theme.fg(failed ? "error" : "muted", line));
	});
}

function scriptOutputFrame(
	result: ToolResult,
	details: CodemodeDetails,
	expanded: boolean,
	theme: Theme,
	failed: boolean,
	width: number,
): string[] {
	const status = failed ? "error" : "success";
	const rows = outputLines(result, theme, failed).flatMap((line) =>
		linesInFrame(line, theme, status, width),
	);
	const limit = previewLineLimit("codemode");
	const shown = limit - 1;
	const body =
		!expanded && rows.length > limit
			? [
					...rows.slice(0, shown),
					frameBodyLines(
						theme.fg("muted", `… ${rows.length - shown} more output rows · Ctrl+O to expand`),
						status,
						theme,
						width,
						{ paddingX: 1 },
					),
				]
			: rows;
	// Keep the full-output location visible even when its preview is clipped.
	if (details.fullOutputPath && !expanded)
		body.push(
			...linesInFrame(
				theme.fg("muted", `Full output: ${details.fullOutputPath}`),
				theme,
				status,
				width,
			),
		);
	if (!body.length) return [];
	return [
		frameToolCall(
			{ name: failed ? "script error" : "script output", boldName: false },
			status,
			theme,
			width,
		),
		...body,
		frameBottomWithLabel(failed ? "✗ failed" : "✓ complete", status, theme, width),
	];
}

export function renderCall(args: unknown, theme: Theme, context: ToolRenderContext): Component {
	const code = (args as { code?: unknown } | null)?.code;
	const status = getFrameStatus(context);
	let displayCode = typeof code === "string" ? code : undefined;
	// Restored session rows have a final result but may never receive
	// setArgsComplete(). Execution or a final result also means input is done.
	const complete = context.argsComplete || context.executionStarted || context.isPartial === false;
	// Stream the original source as-is; format it only once input is complete.
	let formatPending: Promise<string> | undefined;
	if (complete && displayCode) {
		const retained = context.state?._codemodeFormat as
			| { source: string; entry: ReturnType<typeof formattedScript> }
			| undefined;
		const entry = retained?.source === displayCode ? retained.entry : formattedScript(displayCode);
		// The shared LRU is small. Retain this tool's promise in its renderer
		// state, or >32 restored scripts repeatedly evict and reformat each other.
		if (context.state) context.state._codemodeFormat = { source: displayCode, entry };
		displayCode = entry.value ?? displayCode;
		if (entry.value === undefined) formatPending = entry.promise;
	}
	const component = new DynamicText((width) => {
		const innerWidth = Math.max(1, width - GROUP_INDENT);
		const source = displayCode
			? codeLines(displayCode, theme, innerWidth)
			: complete
				? [theme.fg("error", "(invalid or empty script)")]
				: [];
		return grouped(
			[
				frameToolCall({ name: "codemode" }, status, theme, innerWidth),
				...source.flatMap((line) => linesInFrame(line, theme, status, innerWidth)),
			],
			theme,
			width,
		);
	}, true);
	if (formatPending)
		void formatPending.then((formatted) => {
			displayCode = formatted;
			component.invalidate();
			context.invalidate?.();
		});
	return component;
}

export function renderResult(
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const details = (result.details ?? {}) as CodemodeDetails;
	const calls = Array.isArray(details.calls) ? details.calls : [];
	const failed = context.isError === true;
	const status = getFrameStatus({ isError: failed, isPartial: options.isPartial });
	if (context.toolCallId && context.invalidate)
		redrawParents.set(context.toolCallId, context.invalidate);
	return new DynamicText((width) => {
		const innerWidth = Math.max(1, width - GROUP_INDENT);
		// Facelift's native renderers size frames from terminal.columns, not the
		// component width. Give them the full width, then make room for the rail
		// afterward; rendering them at innerWidth wraps borders into stray rows.
		const callFrames = calls.flatMap((call) =>
			nestedCallLines(call, context.toolCallId, theme, width, options.expanded, context.invalidate),
		);
		// Nested tools already own their previews. Limit only the actual script
		// output, so a parent preview never cuts a tool box or hides later calls.
		const outputFrame = options.isPartial
			? []
			: scriptOutputFrame(result, details, options.expanded, theme, failed, innerWidth);
		const label = options.isPartial ? "running" : failed ? "✗ failed" : "✓ complete";
		return grouped(
			[
				frameBottomWithLabel(
					`${label} · ${calls.length} tool call${calls.length === 1 ? "" : "s"}`,
					status,
					theme,
					innerWidth,
				),
				...callFrames,
				...outputFrame,
			],
			theme,
			width,
		);
	}, !options.isPartial);
}

export default function (pi: ExtensionAPI): void {
	installModeBridge();
	// Register after other extensions' factories so we see their tool_result
	// transformations (notably secret redaction), never the raw result.
	pi.on("session_start", () => {
		nestedOutputs.clear();
		nestedComponents.clear();
		redrawParents.clear();
		pi.on("tool_result", (event) => {
			const parent = event.parentToolCallId;
			if (!parent) return;
			const outputs = nestedOutputs.get(parent) ?? new Map<string, NestedOutput>();
			outputs.set(event.toolCallId, {
				input: event.input,
				content: event.content,
				details: event.details,
				isError: event.isError,
			});
			if (outputs.size > 32) {
				const oldest = outputs.keys().next().value!;
				outputs.delete(oldest);
				nestedComponents.get(parent)?.delete(oldest);
			}
			nestedOutputs.set(parent, outputs);
			if (nestedOutputs.size > 8) {
				const oldest = nestedOutputs.keys().next().value!;
				nestedOutputs.delete(oldest);
				nestedComponents.delete(oldest);
				redrawParents.delete(oldest);
			}
			redrawParents.get(parent)?.();
		});
	});
	registerToolRenderer(["codemode"], {
		managesResultPreview: true,
		renderCall: (_toolName, args, theme, context) => renderCall(args, theme, context),
		renderResult: (_toolName, result, options, theme, context) =>
			renderResult(result, options, theme, context),
	});
}
