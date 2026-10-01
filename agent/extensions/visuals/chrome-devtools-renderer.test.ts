import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initTheme,
	InteractiveMode,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	setCapabilities,
	Text,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerChrome, {
	consoleResult,
	evaluateCall,
	evaluateResult,
	pagesResult,
} from "./chrome-devtools-renderer.ts";
import registerCodemode from "./codemode-renderer.ts";
import registerFallback from "./fallback-renderer.ts";
import { defaultConfig, saveConfig } from "./config.ts";
import { registerMcpToolFormatter, registerToolFormatter } from "./shared/tool-formatters.ts";
import {
	registerToolResultDecorator,
	type ToolRenderContext,
} from "./shared/tool-renderer-patch.ts";
import { formattedCode } from "./shared/code-format.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = {
	fg: (key: string, text: string) =>
		`\x1b[${key === "error" ? 31 : key === "warning" ? 33 : 36}m${text}\x1b[0m`,
	bold: (text: string) => text,
} as Theme;
const consoleText =
	"# list_console_messages response\n## Console messages\nShowing 1-3 of 20.\nmsgid=1 [log] ready (1 args)\nmsgid=2 [warn] slow (1 args) [3 times]\nmsgid=3 [error] boom (1 args)\n  at main (http://localhost:1111/app.js:2:5)\nNote: stack trace line and column numbers use 1-based indexing";
const pagesText =
	"# list_pages response\nNote: page ids changed.\n## Pages\n1: Example (http://localhost:1111) [selected] isolatedContext=renderer-test\n2: about:blank";
let oldDir: string | undefined;
let dir: string;
let capabilities: ReturnType<typeof getCapabilities>;
beforeEach(() => {
	oldDir = process.env.PI_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "chrome-renderer-test-"));
	process.env.PI_AGENT_DIR = dir;
	saveConfig(defaultConfig());
	initTheme();
	capabilities = getCapabilities();
	setCapabilities({ ...capabilities, images: null });
	registerFallback({} as ExtensionAPI);
	registerChrome({} as ExtensionAPI);
});
afterEach(() => {
	if (oldDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = oldDir;
	rmSync(dir, { recursive: true, force: true });
	setCapabilities(capabilities);
});
function nativeTool(name: string, args: unknown = { pageId: 2 }, requestRender = vi.fn()) {
	return new ToolExecutionComponent(
		name,
		"chrome-test",
		args,
		{},
		{
			label: name.replace(/^mcp__(.*?)__/, "$1/"),
			namespace: { name: "mcp__chrome-devtools" },
			renderCall: () => new Text("native generic call", 0, 0),
			renderResult: () => new Text("native generic result", 0, 0),
		} as never,
		{ requestRender } as never,
		process.cwd(),
	);
}
function resultTool(
	tool: string,
	text: string,
	options: { isPartial?: boolean; isError?: boolean; details?: unknown } = {},
) {
	const component = nativeTool(`mcp__chrome-devtools__${tool}`);
	component.updateResult(
		{
			content: [{ type: "text", text }],
			isError: options.isError ?? false,
			details: options.details,
		},
		options.isPartial,
	);
	return component;
}

describe("Chrome content selection", () => {
	it("extracts the function but keeps other evaluation arguments", () => {
		const args = {
			function: "()=>document.title",
			pageId: 2,
			args: ["uid-1"],
			waitForStableDom: false,
		};
		const view = evaluateCall(args)!;
		expect(view.code?.source).toBe(args.function);
		expect(view.arguments?.map((arg) => arg.value)).toEqual([
			"pageId=2",
			'args=["uid-1"]',
			"waitForStableDom=false",
		]);
		expect(evaluateCall({ function: 42 })).toBeUndefined();
		expect(evaluateCall(undefined)).toBeUndefined();
	});
	it("shows the returned JSON while keeping surrounding diagnostics", () => {
		const view = evaluateResult(
			'# evaluate_script response\nNote: browser restarted\nScript ran on page and returned:\n```json\n{"title":"Example","count":2}\n```\nNote: dialog accepted',
		)!;
		expect(view.lines).toEqual([
			"Note: browser restarted",
			'{\n  "title": "Example",\n  "count": 2\n}',
			"Note: dialog accepted",
		]);
		expect(evaluateResult("Script ran on page. Output saved to /tmp/result.json.")).toBeUndefined();
		expect(evaluateResult("changed response format")).toBeUndefined();
		expect(
			evaluateResult("Script ran on page and returned:\n```json\nundefined\n```")?.lines,
		).toEqual(["undefined"]);
	});
	it("shows console IDs, severity, repeats, pagination, and stacks without MCP boilerplate", () => {
		const view = consoleResult(consoleText)!;
		expect(JSON.stringify(view.lines)).not.toContain("## Console messages");
		expect(view.lines).toContainEqual({ text: "msgid=3 [error] boom (1 args)", color: "error" });
		expect(view.lines).toContainEqual({
			text: "msgid=2 [warn] slow (1 args) [3 times]",
			color: "warning",
		});
		expect(JSON.stringify(view.lines)).toContain("Showing 1-3 of 20");
		expect(JSON.stringify(view.lines)).toContain("app.js:2:5");
		expect(view.summary).toBe("3 console entries · 1 error · 1 warning");
		expect(
			consoleResult(
				"# list_console_messages response\n## Console messages\n<no console messages found>",
			)?.lines,
		).toEqual([{ text: "No console messages", color: "muted" }]);
		expect(consoleResult("## Console messages\nunknown compact format")).toBeUndefined();
	});
	it("shows selected pages and keeps context and reconnect information", () => {
		const view = pagesResult(pagesText)!;
		expect(view.lines).toContainEqual({
			text: "● 1 Example (http://localhost:1111) isolatedContext=renderer-test",
			color: "success",
		});
		expect(view.lines).toContainEqual({ text: "· 2 about:blank", color: "toolOutput" });
		expect(JSON.stringify(view.lines)).toContain("page ids changed");
		expect(view.summary).toBe("2 pages");
		expect(pagesResult("# list_pages response")?.lines).toContainEqual({
			text: "No open pages",
			color: "muted",
		});
		expect(pagesResult("## Pages\nunknown compact format")).toBeUndefined();
	});
	it("handles structured JSON output and retains unrecognised metadata", () => {
		const messages = consoleResult(
			JSON.stringify({
				consoleMessages: [
					{ id: 9, type: "error", text: "problem", count: 2, stackTrace: "at main:1" },
				],
				pagination: { total: 12 },
				note: "preserved",
			}),
		)!;
		expect(JSON.stringify(messages.lines)).toContain("msgid=9");
		expect(JSON.stringify(messages.lines)).toContain("2 times");
		expect(JSON.stringify(messages.lines)).toContain("at main:1");
		expect(JSON.stringify(messages.lines)).toContain("pagination");
		expect(JSON.stringify(messages.lines)).toContain("preserved");
		const pages = pagesResult(
			JSON.stringify({
				pages: [{ id: 2, title: "Example", url: "http://localhost:1111", selected: true }],
				extra: "keep",
			}),
		)!;
		expect(pages.lines).toContainEqual({
			text: "● 2 Example · http://localhost:1111",
			color: "success",
		});
		expect(JSON.stringify(pages.lines)).toContain("keep");
		expect(consoleResult('{"consoleMessages":[null]}')).toBeUndefined();
		expect(pagesResult('{"pages":[null]}')).toBeUndefined();
	});
});

describe("registered Chrome renderers", () => {
	it.each(["chrome-devtools", "chrome_devtools"])(
		"renders formatted, highlighted functions for %s without changing execution arguments",
		async (server) => {
			const source = "async()=>{const name='café';return{name,count:42}}";
			const args = { pageId: 2, function: source };
			const component = nativeTool(`mcp__${server}__evaluate_script`, args);
			component.setArgsComplete();
			await vi.waitFor(() =>
				expect(stripAnsi(component.render(160).join("\n"))).toContain('const name = "café";'),
			);
			const rows = component.render(160);
			const text = stripAnsi(rows.join("\n"));
			expect(text).toContain("pageId=2");
			expect(text).toContain("async () => {");
			expect(text).not.toContain("function=");
			expect(text).not.toContain("__piDisplay");
			const codeLine = rows.find((row) => stripAnsi(row).includes("const name"));
			expect(codeLine).toMatch(/\x1b\[[0-9;]*mconst/);
			expect(args.function).toBe(source);
		},
	);
	it("waits for completed arguments, then formats anonymous functions and tolerates invalid input", async () => {
		const source = "function(){return document.title}";
		const component = nativeTool("mcp__chrome-devtools__evaluate_script", { function: source });
		expect(stripAnsi(component.render(160).join("\n"))).toContain(source);
		component.setArgsComplete();
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain("function () {"),
		);
		const malformed = nativeTool("mcp__chrome-devtools__evaluate_script", {
			function: "()=>{broken",
		});
		malformed.setArgsComplete();
		expect(stripAnsi(malformed.render(80).join("\n"))).toContain("()=>{broken");
	});
	it("renders meaningful console and page results in shared frames", () => {
		const console = stripAnsi(
			resultTool("list_console_messages", consoleText).render(160).join("\n"),
		);
		expect(console).toContain("│ msgid=3 [error] boom");
		expect(console).toContain("3 console entries");
		expect(console).not.toContain("# list_console_messages response");
		const pages = stripAnsi(resultTool("list_pages", pagesText).render(160).join("\n"));
		expect(pages).toContain("│ ● 1 Example");
		expect(pages).toContain("2 pages");
		expect(pages).not.toContain("## Pages");
	});
	it("keeps errors, partial results, and unknown response formats visible", () => {
		for (const options of [{ isError: true }, { isPartial: true }]) {
			const text = stripAnsi(
				resultTool("list_pages", "Browser disconnected", options).render(100).join("\n"),
			);
			expect(text).toContain("Browser disconnected");
			expect(text).not.toContain("0 pages");
		}
		const unknown = stripAnsi(
			resultTool("list_console_messages", "new response schema").render(80).join("\n"),
		);
		expect(unknown).toContain("new response schema");
	});
	it("uses decorators' redacted output and sanitises escapes reintroduced by JSON", () => {
		registerToolResultDecorator(["mcp__chrome_devtools__list_pages"], (_name, result) => ({
			...result,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pages: [
							{ id: 1, url: "http://localhost:1111", title: "redacted\x1b[2J", selected: false },
						],
					}),
				},
			],
		}));
		const component = nativeTool("mcp__chrome_devtools__list_pages");
		component.updateResult({
			content: [{ type: "text", text: "private original result" }],
			isError: false,
		});
		const rows = component.render(100);
		expect(stripAnsi(rows.join("\n"))).toContain("redacted");
		expect(rows.join("\n")).not.toContain("private original");
		expect(rows.join("\n")).not.toContain("\x1b[2J");
	});
	it("honours preview limits and expansion without soft wrapping", () => {
		const cfg = defaultConfig();
		cfg.previewLines["mcp__chrome-devtools__list_console_messages"] = 3;
		saveConfig(cfg);
		const source =
			"## Console messages\n" +
			Array.from({ length: 10 }, (_, i) => `msgid=${i} [log] ${"🌍 ".repeat(100)}`).join("\n");
		const component = resultTool("list_console_messages", source, {
			details: { fullOutputPath: "/tmp/console.txt" },
		});
		for (const width of [40, 80, 160]) {
			component.setExpanded(false);
			const collapsed = component.render(width);
			expect(stripAnsi(collapsed.join("\n"))).toContain("8 more lines");
			expect(stripAnsi(collapsed.join("\n"))).toContain("Full output:");
			component.setExpanded(true);
			const expanded = component.render(width);
			expect(expanded.filter((row) => stripAnsi(row).startsWith("│ msgid="))).toHaveLength(10);
			expect(expanded.length).toBeLessThanOrEqual(14); // Spacer, heading, expanded args, 10 messages, footer.
			expect(expanded.every((row) => visibleWidth(row) <= width)).toBe(true);
		}
	});
	it("formats evaluation input in live codemode children", async () => {
		const handlers = new Map<string, Array<(...args: any[]) => void>>();
		registerCodemode({
			on: (event: string, fn: (...args: any[]) => void) => {
				const list = handlers.get(event) ?? [];
				list.push(fn);
				handlers.set(event, list);
				return () => {};
			},
		} as unknown as ExtensionAPI);
		for (const handler of handlers.get("session_start")!) handler();
		const definition = {
			label: "chrome-devtools/evaluate_script",
			namespace: { name: "mcp__chrome-devtools" },
		};
		const mode = {
			ui: { requestRender: vi.fn() },
			session: { getToolDefinition: () => definition },
			sessionManager: { getCwd: () => process.cwd() },
			getRegisteredToolDefinition: () => definition,
		};
		(InteractiveMode.prototype as any).getRegisteredToolDefinition.call(mode, "codemode");
		for (const handler of handlers.get("tool_result")!)
			handler({
				parentToolCallId: "parent",
				toolCallId: "child",
				input: { function: "()=>{return{title:document.title}}", pageId: 2 },
				content: [
					{
						type: "text",
						text: 'Script ran on page and returned:\n```json\n{"title":"Example"}\n```',
					},
				],
				isError: false,
			});
		const parent = new ToolExecutionComponent(
			"codemode",
			"parent",
			{},
			{},
			{} as never,
			mode.ui as never,
			process.cwd(),
		);
		parent.updateResult({
			content: [],
			details: {
				calls: [{ id: "child", name: "mcp__chrome-devtools__evaluate_script", status: "ok" }],
			},
			isError: false,
		});
		await vi.waitFor(() =>
			expect(stripAnsi(parent.render(160).join("\n"))).toContain(
				"return { title: document.title };",
			),
		);
		const text = stripAnsi(parent.render(160).join("\n"));
		expect(text).toContain("│╭── chrome-devtools/evaluate_script");
		expect(text).toContain('"title": "Example"');
	});
});

describe("formatter API", () => {
	it("lets a new formatter provide only selected rows, with shared fallback and images", () => {
		registerMcpToolFormatter("test-formatters", "example", {
			result: () => ({ lines: [{ text: "useful field", color: "success" }], summary: "1 item" }),
		});
		const component = nativeTool("mcp__test-formatters__example");
		component.updateResult({
			content: [
				{ type: "text", text: "raw envelope" },
				{ type: "image", mimeType: "image/png", data: "" },
			],
			isError: false,
		});
		const text = stripAnsi(component.render(100).join("\n"));
		expect(text).toContain("useful field");
		expect(text).toContain("1 item");
		expect(text).toContain("image/png");
		expect(text).not.toContain("raw envelope");
		registerToolFormatter(["throwing_formatter"], {
			result: () => {
				throw new Error("bad schema");
			},
		});
		const unknown = nativeTool("throwing_formatter");
		unknown.updateResult({ content: [{ type: "text", text: "still readable" }], isError: false });
		expect(stripAnsi(unknown.render(80).join("\n"))).toContain("still readable");
	});
	it("caches presentation rows and retains formatting after LRU eviction", async () => {
		const views: Array<{
			render: Component["render"];
			context: ToolRenderContext;
			source: string;
		}> = [];
		const host = nativeTool("mcp__chrome-devtools__evaluate_script") as unknown as {
			getCallRenderer(): (args: unknown, theme: Theme, context: ToolRenderContext) => Component;
		};
		for (let i = 0; i < 40; i++) {
			const source = `()=>{return 'format-retention-${i}'}`;
			const context: ToolRenderContext = { argsComplete: true, state: {}, invalidate: vi.fn() };
			const component = host.getCallRenderer()({ function: source }, theme, context);
			views.push({ render: (width) => component.render(width), context, source });
		}
		await vi.waitFor(() =>
			expect(
				views.every(
					(view) => (view.context.invalidate as ReturnType<typeof vi.fn>).mock.calls.length === 1,
				),
			).toBe(true),
		);
		for (const view of views) {
			const first = view.render(100);
			expect(view.render(100)).toBe(first);
			const fresh = host.getCallRenderer()({ function: view.source }, theme, view.context);
			expect(stripAnsi(fresh.render(100).join("\n"))).toContain('return "format-retention-');
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			views.every(
				(view) => (view.context.invalidate as ReturnType<typeof vi.fn>).mock.calls.length === 1,
			),
		).toBe(true);
	});
	it("formats code without ever running it", async () => {
		const source = "()=>{throw new Error('must not execute')}";
		expect(await formattedCode(source, "javascript-expression").promise).toContain(
			'throw new Error("must not execute");',
		);
		expect(await formattedCode("not { valid JavaScript", "javascript-expression").promise).toBe(
			"not { valid JavaScript",
		);
	});
});
