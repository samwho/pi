import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderCall as renderCodemodeCall } from "./codemode-renderer.ts";
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
});
