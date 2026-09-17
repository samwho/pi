import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** The public portion of Pi's renderer context used by local decorations. */
export type ToolRenderContext = {
	expanded?: boolean;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	state?: Record<string, unknown>;
	invalidate?: () => void;
};

export type ToolResult = { content?: Array<{ type?: string; text?: string; mimeType?: string }>; details?: unknown };
type CallRenderer = (toolName: string, args: unknown, theme: Theme, context: ToolRenderContext) => Component;
type ResultRenderer = (toolName: string, result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) => Component;
type ResultDecorator = (toolName: string, result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) => ToolResult;
type ToolExecutionPrototype = Record<string | symbol, unknown>;
type InternalToolExecution = { toolName?: unknown };

type RegisteredRenderer = {
	renderCall: CallRenderer;
	renderResult: ResultRenderer;
};
type PatchState = {
	originalCallRenderer: (...args: unknown[]) => unknown;
	originalResultRenderer: (...args: unknown[]) => unknown;
	originalRenderShell: (...args: unknown[]) => unknown;
	renderers: Map<string, RegisteredRenderer>;
	decorators: Map<string, ResultDecorator>;
};

const PATCH = Symbol.for("pi.local-tool-renderer.patch");

/**
 * Render externally-owned tools in a custom self-contained frame without
 * replacing their definitions. One dispatcher is shared by every local
 * renderer, avoiding stacked prototype patches and reload-order dependence.
 */
export function registerToolRenderer(toolNames: Iterable<string>, renderer: RegisteredRenderer): void {
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
			console.warn("local tool renderer: Pi's tool renderer API is unavailable; using the default renderer.");
			return;
		}

		state = {
			originalCallRenderer: originalCallRenderer as (...args: unknown[]) => unknown,
			originalResultRenderer: originalResultRenderer as (...args: unknown[]) => unknown,
			originalRenderShell: originalRenderShell as (...args: unknown[]) => unknown,
			renderers: new Map(),
			decorators: new Map(),
		};
		Object.defineProperty(prototype, PATCH, { value: state, configurable: false });

		prototype.getRenderShell = function(this: InternalToolExecution): unknown {
			return state!.renderers.has(String(this.toolName)) ? "self" : state!.originalRenderShell.call(this);
		};
		prototype.getCallRenderer = function(this: InternalToolExecution): unknown {
			const toolName = String(this.toolName);
			const registered = state!.renderers.get(toolName);
			return registered
				? ((args: unknown, theme: Theme, context: ToolRenderContext) => registered.renderCall(toolName, args, theme, context))
				: state!.originalCallRenderer.call(this);
		};
		prototype.getResultRenderer = function(this: InternalToolExecution): unknown {
			const toolName = String(this.toolName);
			const registered = state!.renderers.get(toolName);
			const renderer = registered
				? ((result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) => registered.renderResult(toolName, result, options, theme, context))
				: state!.originalResultRenderer.call(this);
			const decorator = state!.decorators.get(toolName);
			if (!decorator || typeof renderer !== "function") return renderer;
			return (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) =>
				(renderer as (...args: unknown[]) => unknown)(decorator(toolName, result, options, theme, context), options, theme, context);
		};
	}

	// A process may retain an older patch state across `/reload` while this
	// helper gains new capabilities. Refresh this dispatcher so decorators
	// also work without restarting Pi.
	state.decorators ??= new Map();
	prototype.getResultRenderer = function(this: InternalToolExecution): unknown {
		const toolName = String(this.toolName);
		const registered = state!.renderers.get(toolName);
		const resultRenderer = registered
			? ((result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) => registered.renderResult(toolName, result, options, theme, context))
			: state!.originalResultRenderer.call(this);
		const decorator = state!.decorators.get(toolName);
		if (!decorator || typeof resultRenderer !== "function") return resultRenderer;
		return (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) =>
			(resultRenderer as (...args: unknown[]) => unknown)(decorator(toolName, result, options, theme, context), options, theme, context);
	};
	for (const toolName of toolNames) state.renderers.set(toolName, renderer);
}

/** Decorate display-only result data before an existing tool renderer sees it. */
export function registerToolResultDecorator(toolNames: Iterable<string>, decorator: ResultDecorator): void {
	// Ensure the shared dispatcher exists without claiming any tool names.
	registerToolRenderer([], {
		renderCall: () => { throw new Error("unreachable"); },
		renderResult: () => { throw new Error("unreachable"); },
	});
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	const state = prototype[PATCH] as PatchState | undefined;
	if (!state) return;
	state.decorators ??= new Map();
	for (const toolName of toolNames) state.decorators.set(toolName, decorator);
}
