import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { limitResultPreview } from "./result-preview.ts";
import { previewLineLimit } from "../config.ts";

/** The public portion of Pi's renderer context used by local decorations. */
export type ToolRenderContext = {
	toolCallId?: string;
	lastComponent?: Component;
	argsComplete?: boolean;
	expanded?: boolean;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	displayName?: string;
	hasResult?: boolean;
	/** Pi's safe text/image fallback extraction, applied to the decorated result. */
	getTextOutput?: (result: ToolResult) => string;
	state?: Record<string, unknown>;
	invalidate?: () => void;
};

export type ToolResult = {
	content?: Array<{ type?: string; text?: string; mimeType?: string }>;
	details?: unknown;
};
type CallRenderer = (
	toolName: string,
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
) => Component;
type ResultRenderer = (
	toolName: string,
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
) => Component;
type ResultDecorator = (
	toolName: string,
	result: ToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
) => ToolResult;
type ToolExecutionPrototype = Record<string | symbol, unknown>;
type InternalToolExecution = {
	toolName?: unknown;
	expanded?: boolean;
	showImages?: boolean;
	result?: ToolResult;
	toolDefinition?: {
		label?: string;
		namespace?: { name: string };
		renderShell?: string;
		renderCall?: unknown;
		renderResult?: unknown;
	};
	getTextOutput?: (this: { result?: ToolResult; showImages?: boolean }) => string;
};

type RegisteredRenderer = {
	/** Composite renderers limit their own sections rather than clipping the whole group. */
	managesResultPreview?: boolean;
	renderCall: CallRenderer;
	renderResult: ResultRenderer;
};
type PatchState = {
	originalCallRenderer: (...args: unknown[]) => unknown;
	originalResultRenderer: (...args: unknown[]) => unknown;
	originalRenderShell: (...args: unknown[]) => unknown;
	originalHasRendererDefinition?: (this: InternalToolExecution) => boolean;
	fallbackRenderer?: RegisteredRenderer;
	originalFormatToolExecution?: (this: InternalToolExecution) => string;
	renderers: Map<string, RegisteredRenderer>;
	decorators: Map<string, ResultDecorator>;
	previewComponents?: WeakMap<Component, Component>;
};

const PATCH = Symbol.for("pi.local-tool-renderer.patch");

function registeredRendererFor(
	state: PatchState,
	toolName: string,
): RegisteredRenderer | undefined {
	const exact = state.renderers.get(toolName);
	if (exact) return exact;
	for (const [pattern, renderer] of state.renderers) {
		if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return renderer;
	}
	return undefined;
}

function rendererFor(
	state: PatchState,
	instance: InternalToolExecution,
): RegisteredRenderer | undefined {
	const specific = registeredRendererFor(state, String(instance.toolName));
	if (specific || !state.fallbackRenderer) return specific;
	const definition = instance.toolDefinition;
	// MCP supplies generic Text renderers, not a specialised UI. Keep explicit
	// self-framed MCP UIs and every other extension's custom renderers intact.
	const genericMcp =
		String(instance.toolName).startsWith("mcp__") &&
		definition?.namespace?.name.startsWith("mcp__");
	if (
		definition?.renderShell === "self" ||
		(!genericMcp && (definition?.renderCall || definition?.renderResult))
	)
		return undefined;
	return state.fallbackRenderer;
}

function extendContext(
	instance: InternalToolExecution,
	context: ToolRenderContext,
): ToolRenderContext {
	return {
		...context,
		displayName:
			instance.toolDefinition?.label ?? String(instance.toolName).replace(/^mcp__(.*?)__/, "$1/"),
		hasResult: instance.result !== undefined,
		getTextOutput: (result) =>
			instance.getTextOutput?.call({ result, showImages: instance.showImages }) ?? "",
	};
}

/**
 * Render externally-owned tools in a custom self-contained frame without
 * replacing their definitions. One dispatcher is shared by every local
 * renderer, avoiding stacked prototype patches and reload-order dependence.
 */
export function registerToolRenderer(
	toolNames: Iterable<string>,
	renderer: RegisteredRenderer,
): void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	let state = prototype[PATCH] as PatchState | undefined;

	if (!state) {
		const originalCallRenderer = prototype.getCallRenderer;
		const originalResultRenderer = prototype.getResultRenderer;
		const originalRenderShell = prototype.getRenderShell;
		if (
			typeof originalCallRenderer !== "function" ||
			typeof originalResultRenderer !== "function" ||
			typeof originalRenderShell !== "function"
		) {
			console.warn(
				"local tool renderer: Pi's tool renderer API is unavailable; using the default renderer.",
			);
			return;
		}

		state = {
			originalCallRenderer: originalCallRenderer as (...args: unknown[]) => unknown,
			originalResultRenderer: originalResultRenderer as (...args: unknown[]) => unknown,
			originalRenderShell: originalRenderShell as (...args: unknown[]) => unknown,
			originalFormatToolExecution:
				typeof prototype.formatToolExecution === "function"
					? (prototype.formatToolExecution as PatchState["originalFormatToolExecution"])
					: undefined,
			renderers: new Map(),
			decorators: new Map(),
		};
		Object.defineProperty(prototype, PATCH, { value: state, configurable: false });
	}

	// A process may retain an older patch state across `/reload` while this
	// helper gains new capabilities. Refresh every dispatcher so wildcard
	// renderers and decorators also work without restarting Pi.
	state.decorators ??= new Map();
	state.previewComponents ??= new WeakMap();
	state.originalHasRendererDefinition ??=
		typeof prototype.hasRendererDefinition === "function"
			? (prototype.hasRendererDefinition as PatchState["originalHasRendererDefinition"])
			: undefined;
	if (state.originalHasRendererDefinition) {
		prototype.hasRendererDefinition = function (this: InternalToolExecution): boolean {
			return !!rendererFor(state, this) || state.originalHasRendererDefinition!.call(this);
		};
	}
	state.originalFormatToolExecution ??=
		typeof prototype.formatToolExecution === "function"
			? (prototype.formatToolExecution as PatchState["originalFormatToolExecution"])
			: undefined;
	if (state.originalFormatToolExecution) {
		prototype.formatToolExecution = function (this: InternalToolExecution): string {
			const formatted = state.originalFormatToolExecution!.call(this);
			const output = this.getTextOutput?.();
			if (this.expanded || !output || !formatted.endsWith(output)) return formatted;
			const lines = output.split("\n");
			const limit = previewLineLimit(String(this.toolName));
			if (lines.length <= limit) return formatted;
			return `${formatted.slice(0, -output.length)}${lines.slice(0, limit - 1).join("\n")}\n… ${lines.length - limit + 1} more lines · Ctrl+O to expand`;
		};
	}
	prototype.getRenderShell = function (this: InternalToolExecution): unknown {
		return rendererFor(state, this) ? "self" : state.originalRenderShell.call(this);
	};
	prototype.getCallRenderer = function (this: InternalToolExecution): unknown {
		const toolName = String(this.toolName);
		const registered = rendererFor(state, this);
		return registered
			? (args: unknown, theme: Theme, context: ToolRenderContext) =>
					registered.renderCall(toolName, args, theme, extendContext(this, context))
			: state.originalCallRenderer.call(this);
	};
	prototype.getResultRenderer = function (this: InternalToolExecution): unknown {
		const toolName = String(this.toolName);
		const registered = rendererFor(state, this);
		const resultRenderer = registered
			? (
					result: ToolResult,
					options: { expanded: boolean; isPartial: boolean },
					theme: Theme,
					context: ToolRenderContext,
				) => registered.renderResult(toolName, result, options, theme, context)
			: state.originalResultRenderer.call(this);
		if (typeof resultRenderer !== "function") return resultRenderer;
		const decorator = state.decorators.get(toolName);
		return (
			result: ToolResult,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: ToolRenderContext,
		) => {
			// Pi returns our preview wrapper as lastComponent on the next redraw.
			// Renderers must receive their own component (e.g. Text with setText),
			// not the display-only wrapper, or Pi silently falls back to plain output.
			const lastComponent = context.lastComponent;
			const renderContext = extendContext(
				this,
				lastComponent
					? {
							...context,
							lastComponent: state.previewComponents!.get(lastComponent) ?? lastComponent,
						}
					: context,
			);
			const decorated = decorator
				? decorator(toolName, result, options, theme, renderContext)
				: result;
			const component = (resultRenderer as (...args: unknown[]) => Component | undefined)(
				decorated,
				options,
				theme,
				renderContext,
			);
			if (!component) return component;
			const preview = registered?.managesResultPreview
				? component
				: limitResultPreview(component, toolName, options.expanded, theme, context);
			if (preview !== component) state.previewComponents!.set(preview, component);
			return preview;
		};
	};
	for (const toolName of toolNames) state.renderers.set(toolName, renderer);
}

/** Use consistent chrome for tools without a specialised renderer, including generic MCP tools. */
export function registerFallbackToolRenderer(renderer: RegisteredRenderer): void {
	registerToolRenderer([], renderer);
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	const state = prototype[PATCH] as PatchState | undefined;
	if (state?.originalHasRendererDefinition) state.fallbackRenderer = renderer;
}

/** Decorate display-only result data before an existing tool renderer sees it. */
export function registerToolResultDecorator(
	toolNames: Iterable<string>,
	decorator: ResultDecorator,
): void {
	// Ensure the shared dispatcher exists without claiming any tool names.
	registerToolRenderer([], {
		renderCall: () => {
			throw new Error("unreachable");
		},
		renderResult: () => {
			throw new Error("unreachable");
		},
	});
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	const state = prototype[PATCH] as PatchState | undefined;
	if (!state) return;
	state.decorators ??= new Map();
	for (const toolName of toolNames) state.decorators.set(toolName, decorator);
}
