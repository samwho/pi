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
			return registered
				? ((result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: ToolRenderContext) => registered.renderResult(toolName, result, options, theme, context))
				: state!.originalResultRenderer.call(this);
		};
	}

	for (const toolName of toolNames) state.renderers.set(toolName, renderer);
}
