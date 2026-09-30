/**
 * Regression tests for the `read` tool's body rendering.
 *
 * History: a previous refactor stranded a `bodyW()` reference inside
 * `renderFileContent` after the helper itself was deleted. The
 * resulting `ReferenceError` was swallowed by `.catch(() => {})` on
 * the shiki promise, leaving every `read` result with a top + bottom
 * border but no body lines at all. These tests force the async
 * highlighter to run and assert that the body actually populates.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import piFaceliftExtension from "./index.ts";

class MockText {
	private text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

const mockTheme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
};

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

/**
 * Pin `process.stdout.columns` for the lifetime of `fn`, including
 * across `await` boundaries. The naive sync `try/finally` version
 * restores the descriptor immediately when `fn` returns its promise,
 * so any code that runs after the first `await` sees the *original*
 * width — enough to flip a width-keyed cache (`_rk`) and force a
 * shiki re-run, which clobbers the populated `_rt` we waited for.
 */
async function withStdoutColumns<T>(columns: number, fn: () => T | Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", {
		configurable: true,
		value: columns,
	});
	try {
		return await fn();
	} finally {
		if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
		else Reflect.deleteProperty(process.stdout, "columns");
	}
}

function loadReadTool(readExec: any, toolName: "read" | "grep" = "read") {
	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};

	piFaceliftExtension(pi, {
		sdk: {
			createReadToolDefinition: mockToolFactory(readExec),
			createBashToolDefinition: mockToolFactory(noopExec),
			createLsToolDefinition: mockToolFactory(noopExec),
			createFindToolDefinition: mockToolFactory(noopExec),
			createGrepToolDefinition: mockToolFactory(toolName === "grep" ? readExec : noopExec),
			getAgentDir: () => "/tmp/pi-facelift-test",
		},
		TextComponent: MockText,
	});

	return tools.get(toolName);
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Wait until `state._rt` is populated by shiki's async render. Shiki's
 * first call cold-starts the highlighter (registers the language
 * grammar, etc.) which can take a few hundred ms in CI; we poll up to
 * a few seconds before giving up so the test still fails fast on a
 * real regression.
 */
/**
 * Wait until `state._rt` is populated by shiki's async render. Shiki's
 * first call cold-starts the highlighter (registers the language
 * grammar, etc.) which can take a few hundred ms in CI; we poll up to
 * a few seconds before giving up so the test still fails fast on a
 * real regression.
 */
async function waitForCachedBody(state: { _rt?: string }): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 25));
		if (state._rt && state._rt.split("\n").length > 1) return;
	}
}

describe("read renderCall", () => {
	it("shows line range below a long truncated path", async () => {
		const readTool = loadReadTool(async () => ({ content: [{ type: "text", text: "" }] }));
		await withStdoutColumns(48, () => {
			const rendered = readTool.renderCall(
				{ path: `/some/${"long/".repeat(15)}file.ts`, offset: 120, limit: 50 },
				mockTheme,
				{ lastComponent: new MockText(), isError: false, state: {} },
			);
			const lines = rendered.getText().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).not.toContain("from line");
			expect(lines[1]).toContain("from line 120 (50 lines)");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
		});
	});
});

describe("grep preview", () => {
	it("limits collapsed results to 10 rows but expands to every match", async () => {
		const matches = Array.from(
			{ length: 25 },
			(_, i) => `src/example.ts:${i + 1}:match ${i + 1}`,
		).join("\n");
		const grep = loadReadTool(async () => ({ content: [{ type: "text", text: matches }] }), "grep");
		const result = await grep.execute("t-grep", { pattern: "match" }, null, null, {});
		await withStdoutColumns(100, async () => {
			const ctx: any = {
				lastComponent: new MockText(),
				isError: false,
				isPartial: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			};
			grep.renderResult(result, {}, mockTheme, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const collapsed = stripAnsi(grep.renderResult(result, {}, mockTheme, ctx).getText());
			expect(collapsed.split("\n")).toHaveLength(11); // 10 body rows + bottom border
			expect(collapsed).toContain("more lines");
			expect(collapsed).not.toContain("match 25");
			ctx.expanded = true;
			grep.renderResult(result, {}, mockTheme, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const expanded = stripAnsi(grep.renderResult(result, {}, mockTheme, ctx).getText());
			expect(expanded).toContain("match 25");
			expect(expanded).not.toContain("more lines");
		});
	});
});

describe("read renderResult body", () => {
	it("populates the frame body with file contents (regression: bodyW reference)", async () => {
		const fileContent = ["line one", "line two", "line three", "line four", "line five"].join("\n");

		const readTool = loadReadTool(async () => ({
			content: [{ type: "text", text: fileContent }],
		}));

		// First, run execute() so the result has the expected `details`
		// payload that renderResult dispatches on.
		const result = await readTool.execute("t1", { path: "fixtures/sample.txt" }, null, null, {});

		await withStdoutColumns(80, async () => {
			let invalidated = 0;
			const ctx: any = {
				lastComponent: new MockText(),
				isError: false,
				isPartial: false,
				state: {},
				expanded: false,
				invalidate: () => {
					invalidated += 1;
				},
			};

			// First render: kicks off shiki, sets the cached `_rt` to an
			// empty-body frame. The async pipeline then populates `_rt`.
			const rendered = readTool.renderResult(result, {}, mockTheme, ctx);
			expect(rendered.getText()).toMatch(/^╰─+$/m); // bottom border present

			await waitForCachedBody(ctx.state);

			// After the highlighter resolves, `ctx.invalidate` should have
			// fired so pi-tui re-invokes the renderer. Simulate that.
			expect(invalidated).toBeGreaterThanOrEqual(1);
			const rendered2 = readTool.renderResult(result, {}, mockTheme, ctx);
			const lines = rendered2.getText().split("\n");

			// Top border is drawn by renderCall, not renderResult — so the
			// renderResult output starts with at least one body line and
			// ends with the bottom border. Body rows carry the `│` rail.
			const bodyRows = lines.filter((l: string) => stripAnsi(l).startsWith("│"));
			expect(bodyRows.length).toBeGreaterThan(0);

			// Body must contain each source line by content.
			const body = lines.map(stripAnsi).join("\n");
			expect(body).toContain("line one");
			expect(body).toContain("line five");
		});
	});

	it("shows ten rows collapsed and restores the entire read on expansion", async () => {
		const content = Array.from({ length: 25 }, (_, i) => `unique line ${i + 1}`).join("\n");
		const readTool = loadReadTool(async () => ({ content: [{ type: "text", text: content }] }));
		const result = await readTool.execute(
			"t-preview",
			{ path: "fixtures/sample.txt" },
			null,
			null,
			{},
		);
		await withStdoutColumns(80, async () => {
			const ctx: any = {
				lastComponent: new MockText(),
				isError: false,
				isPartial: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			};
			readTool.renderResult(result, {}, mockTheme, ctx);
			await waitForCachedBody(ctx.state);
			const collapsed = stripAnsi(readTool.renderResult(result, {}, mockTheme, ctx).getText());
			expect(collapsed).toContain("unique line 1");
			expect(collapsed).not.toContain("unique line 25");
			expect(collapsed).toContain("more lines");
			ctx.expanded = true;
			readTool.renderResult(result, {}, mockTheme, ctx);
			await waitForCachedBody(ctx.state);
			const expanded = stripAnsi(readTool.renderResult(result, {}, mockTheme, ctx).getText());
			expect(expanded).toContain("unique line 25");
			expect(expanded).not.toContain("more lines");
		});
	});

	it("renders an unknown-language file without dying (uses fallback path)", async () => {
		const readTool = loadReadTool(async () => ({
			content: [{ type: "text", text: "hello world" }],
		}));
		const result = await readTool.execute("t2", { path: "fixtures/no-extension" }, null, null, {});

		await withStdoutColumns(80, async () => {
			const ctx: any = {
				lastComponent: new MockText(),
				isError: false,
				isPartial: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			};
			readTool.renderResult(result, {}, mockTheme, ctx);
			await waitForCachedBody(ctx.state);
			const rendered = readTool.renderResult(result, {}, mockTheme, ctx);
			expect(stripAnsi(rendered.getText())).toContain("hello world");
		});
	});
});
