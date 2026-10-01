import {
	initTheme,
	InteractiveMode,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import registerCodemode, {
	renderCall as renderCodemodeCall,
	renderResult as renderCodemodeResult,
} from "./codemode-renderer.ts";
import { genericFallback } from "./code-output-highlighter/index.ts";
import { renderResultFor as renderWebResult } from "./web-search-renderer.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

beforeAll(() => initTheme());

describe("rendering between TUI redraws", () => {
	it("caches a streamed script until its input, width, or theme changes", () => {
		const component = renderCodemodeCall({ code: "text('hello')" }, theme, {
			argsComplete: false,
			executionStarted: false,
			isPartial: true,
		});
		const first = component.render(80);
		expect(first.join("\n")).toContain("hello");
		expect(component.render(80)).toBe(first);
		expect(component.render(60)).not.toBe(first);
		component.invalidate?.();
		expect(component.render(80)).not.toBe(first);
	});

	it("refreshes the script cache when deferred formatting completes", async () => {
		const invalidate = vi.fn();
		const component = renderCodemodeCall({ code: "text(  'render-cache-check'  );" }, theme, {
			argsComplete: true,
			executionStarted: false,
			isPartial: true,
			invalidate,
		});
		const before = component.render(80).join("\n");
		await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 3000 });
		const after = component.render(80).join("\n");
		expect(after.replace(/\x1b\[[0-9;]*m/g, "")).toContain('text("render-cache-check");');
		expect(after).not.toBe(before);
	});

	it("does not reformat restored scripts after the shared LRU evicts them", async () => {
		const redraws = vi.fn();
		for (let i = 0; i < 40; i++) {
			const args = { code: `text('restored script ${i}')` };
			const ctx = {
				argsComplete: true,
				state: {},
				invalidate: () => {
					redraws();
					renderCodemodeCall(args, theme, ctx);
				},
			};
			renderCodemodeCall(args, theme, ctx);
		}
		await vi.waitFor(() => expect(redraws).toHaveBeenCalledTimes(40));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(redraws).toHaveBeenCalledTimes(40);
	});

	it("caches highlighted generic tool output", () => {
		const output = '{"name":"example","count":42}';
		const component = genericFallback(
			{ expanded: true, isPartial: false, getTextOutput: () => output },
			() => new Text(output, 0, 0),
		)!;
		const first = component.render(80);
		expect(first.join("\n")).toContain("example");
		expect(component.render(80)).toBe(first);
		component.invalidate?.();
		expect(component.render(80)).not.toBe(first);
	});

	it("clips native fallback progress output instead of soft-wrapping it", () => {
		const output = "progress 🌍 ".repeat(100);
		const original = new Text("\x1b[33m" + output + "\x1b[0m", 0, 0);
		const component = genericFallback(
			{ isPartial: true, getTextOutput: () => output },
			() => original,
		)!;
		expect(component.render(40)).toHaveLength(1);
		expect(visibleWidth(component.render(40)[0])).toBeLessThanOrEqual(40);
		original.setText("latest update");
		expect(component.render(40)[0]).toBe("latest update");
	});

	it("truncates completed and failed web output without losing its Markdown styling", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "**Result** " + "word ".repeat(100) + "HIDDEN_END" },
			],
		};
		for (const failed of [false, true]) {
			const component = renderWebResult(result, { expanded: true, isPartial: false }, theme, {
				isError: failed,
			});
			for (const width of [40, 80, 160]) {
				const rows = component.render(width);
				expect(rows).toHaveLength(3); // Summary/error, one result line, footer.
				expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
				expect(rows.join("\n")).not.toContain("HIDDEN_END");
			}
		}
	});

	it("caches final search results but not the live searching spinner", () => {
		const result = { content: [{ type: "text" as const, text: "One **result**" }], details: {} };
		const complete = renderWebResult(result, { expanded: false, isPartial: false }, theme, {
			isError: false,
		});
		const first = complete.render(80);
		expect(first.join("\n")).toContain("result");
		expect(complete.render(80)).toBe(first);
		complete.invalidate?.();
		expect(complete.render(80)).not.toBe(first);

		const pending = renderWebResult(result, { expanded: false, isPartial: true }, theme, {
			isError: false,
		});
		expect(pending.render(80)).not.toBe(pending.render(80));
	});

	it("caches completed codemode results, with width and theme invalidation", () => {
		const component = renderCodemodeResult(
			{
				content: [{ type: "text", text: "script output 🌍" }],
				details: { calls: [{ name: "read", args: '{"path":"sample.ts"}', status: "done" }] },
			},
			{ expanded: false, isPartial: false },
			theme,
			{},
		);
		const first = component.render(80);
		expect(first.join("\n")).toContain("script output 🌍");
		for (let i = 0; i < 100; i++) expect(component.render(80)).toBe(first);
		expect(component.render(60)).not.toBe(first);
		component.invalidate?.();
		expect(component.render(80)).toEqual(first);
		expect(component.render(80)).not.toBe(first);
	});

	it("does not freeze partial codemode results", () => {
		const component = renderCodemodeResult(
			{ content: [], details: { calls: [{ name: "read", status: "running" }] } },
			{ expanded: false, isPartial: true },
			theme,
			{},
		);
		expect(component.render(80)).not.toBe(component.render(80));
	});

	it("refreshes cached parents after native child highlighting, updates, and expansion", () => {
		const handlers = new Map<string, Array<(...args: any[]) => void>>();
		registerCodemode({
			on(name: string, handler: (...args: any[]) => void) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
				return () => {};
			},
		} as unknown as ExtensionAPI);
		for (const handler of handlers.get("session_start")!) handler();
		let highlighted = false;
		let invalidateChild: (() => void) | undefined;
		const definition = {
			renderShell: "self",
			renderCall: () => new Text("child header", 0, 0),
			renderResult: (_result: unknown, _options: unknown, _theme: unknown, ctx: any) => {
				invalidateChild = ctx.invalidate;
				return new Text(highlighted ? "highlighted child" : "plain child", 0, 0);
			},
		};
		const ui = { requestRender: vi.fn() };
		const mode = {
			ui,
			session: { getToolDefinition: () => definition },
			sessionManager: { getCwd: () => process.cwd() },
			getRegisteredToolDefinition: () => definition,
		};
		// Exercise the same native-tool bridge used by InteractiveMode.
		(InteractiveMode.prototype as any).getRegisteredToolDefinition.call(mode, "codemode");
		const parent = new ToolExecutionComponent(
			"codemode",
			"parent",
			{},
			{},
			{} as never,
			ui as never,
			process.cwd(),
		);
		const emit = (text: string) => {
			for (const handler of handlers.get("tool_result")!)
				handler({
					parentToolCallId: "parent",
					toolCallId: "child",
					input: {},
					content: [{ type: "text", text }],
					isError: false,
				});
		};
		emit("first");
		const output = Array.from({ length: 80 }, (_, i) => `result row ${i}`).join("\n");
		parent.updateResult({
			content: [{ type: "text", text: output }],
			details: { calls: [{ id: "child", name: "fixture", status: "done" }] },
			isError: false,
		});
		expect(parent.render(100).join("\n")).toContain("plain child");
		highlighted = true;
		invalidateChild!();
		expect(parent.render(100).join("\n")).toContain("highlighted child");
		const renderChild = vi.spyOn(definition, "renderResult");
		emit("second");
		parent.render(100);
		expect(renderChild).toHaveBeenCalled();
		expect(parent.render(100).join("\n")).not.toContain("result row 79");
		parent.setExpanded(true);
		expect(parent.render(100).join("\n")).toContain("result row 79");
		parent.setExpanded(false);
		expect(parent.render(100).join("\n")).not.toContain("result row 79");
	});
});
