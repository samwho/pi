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
import { getCapabilities, setCapabilities, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerFallback, { renderFallbackCall, renderFallbackResult } from "./fallback-renderer.ts";
import registerCodemode from "./codemode-renderer.ts";
import { defaultConfig, saveConfig } from "./config.ts";
import {
	registerToolRenderer,
	registerToolResultDecorator,
	type ToolRenderContext,
} from "./shared/tool-renderer-patch.ts";

const { detection } = vi.hoisted(() => ({
	detection: new Map<string, (language: string) => void>(),
}));
vi.mock("./shared/code-language.ts", () => ({
	detectedCodeLanguage: (source: string, callback?: (language: string) => void) => {
		if (callback) detection.set(source, callback);
		return undefined;
	},
}));

const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
	bold: (text: string) => text,
} as Theme;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
let oldDir: string | undefined;
let dir: string;
let capabilities: ReturnType<typeof getCapabilities>;
beforeEach(() => {
	oldDir = process.env.PI_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "fallback-render-test-"));
	process.env.PI_AGENT_DIR = dir;
	saveConfig(defaultConfig());
	initTheme();
	capabilities = getCapabilities();
	setCapabilities({ ...capabilities, images: null });
	detection.clear();
	registerFallback({} as ExtensionAPI);
});
afterEach(() => {
	if (oldDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = oldDir;
	rmSync(dir, { recursive: true, force: true });
	setCapabilities(capabilities);
});

function tool(name = "mcp__chrome-devtools__take_snapshot", ...definitions: unknown[]) {
	const definition = definitions.length
		? definitions[0]
		: {
				label: "chrome-devtools/take_snapshot",
				namespace: { name: "mcp__chrome-devtools" },
				renderCall: () => new Text("old generic call", 0, 0),
				renderResult: () => new Text("old generic result", 0, 0),
			};
	return new ToolExecutionComponent(
		name,
		"fallback-test",
		{ pageId: 2 },
		{},
		definition as never,
		{ requestRender: () => {} } as never,
		process.cwd(),
	);
}

describe("generic tool styling", () => {
	it("gives MCP calls a shared frame and the real readable server/tool label", () => {
		const component = tool();
		component.updateResult({
			content: [{ type: "text", text: "## Latest page snapshot\nuid=1_0 RootWebArea 🌍" }],
			isError: false,
		});
		const rows = component.render(100);
		const text = stripAnsi(rows.join("\n"));
		expect(text).toContain("╭── chrome-devtools/take_snapshot");
		expect(text).toContain("pageId=2");
		expect(text).toContain("│ ## Latest page snapshot");
		expect(text).toContain("╰── ✓ complete");
		expect(text).not.toContain("old generic");
		expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true);
	});

	it.each([{}, undefined])(
		"frames tools with no specialised definition or renderer",
		(definition) => {
			const component = tool("unfamiliar_tool", definition);
			component.updateResult({ content: [{ type: "text", text: "plain result" }], isError: false });
			const text = stripAnsi(component.render(80).join("\n"));
			expect(text).toContain("╭── unfamiliar_tool");
			expect(text).toContain("│ plain result");
		},
	);

	it.each(["default", "self"])(
		"preserves an extension's specialised %s renderer",
		(renderShell) => {
			const renderResult = vi.fn(() => new Text("specialised extension UI", 0, 0));
			const component = tool("special_tool", {
				renderShell,
				renderCall: () => new Text("special header", 0, 0),
				renderResult,
			});
			component.updateResult({ content: [{ type: "text", text: "raw output" }], isError: false });
			expect(stripAnsi(component.render(80).join("\n"))).toContain("specialised extension UI");
			expect(renderResult).toHaveBeenCalled();
		},
	);

	it("preserves self-framed MCP UIs and explicitly registered MCP styling", () => {
		const custom = tool("mcp__custom__self", {
			namespace: { name: "mcp__custom" },
			renderShell: "self",
			renderCall: () => new Text("custom MCP UI", 0, 0),
		});
		expect(stripAnsi(custom.render(80).join("\n"))).toContain("custom MCP UI");
		registerToolRenderer(["mcp__special__*"], {
			renderCall: () => new Text("specific registered header", 0, 0),
			renderResult: () => new Text("specific registered result", 0, 0),
		});
		const specific = tool("mcp__special__read");
		specific.updateResult({ content: [{ type: "text", text: "raw" }], isError: false });
		expect(stripAnsi(specific.render(80).join("\n"))).toContain("specific registered result");
	});

	it("honours configured previews, expansion, and the full-output location", () => {
		const cfg = defaultConfig();
		cfg.previewLines["mcp__chrome-devtools__take_snapshot"] = 3;
		saveConfig(cfg);
		const component = tool();
		component.updateResult({
			content: [
				{ type: "text", text: Array.from({ length: 10 }, (_, i) => `snapshot ${i}`).join("\n") },
			],
			details: { fullOutputPath: "/tmp/snapshot.txt" },
			isError: false,
		});
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("snapshot 1");
		expect(collapsed).not.toContain("snapshot 2");
		expect(collapsed).toContain("8 more lines");
		expect(collapsed).toContain("Full output: /tmp/snapshot.txt");
		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("snapshot 9");
		component.setExpanded(false);
		expect(stripAnsi(component.render(100).join("\n"))).toBe(collapsed);
	});

	it("updates pending, progress, and failed tool states", () => {
		const component = tool();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("waiting");
		component.markExecutionStarted();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("running");
		component.updateResult(
			{ content: [{ type: "text", text: "Progress 1/2" }], isError: false },
			true,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Progress 1/2");
		component.updateResult({ content: [{ type: "text", text: "No such page" }], isError: true });
		const failed = stripAnsi(component.render(80).join("\n"));
		expect(failed).toContain("No such page");
		expect(failed).toContain("✗ failed");
		expect(failed).not.toContain("running");
	});

	it("keeps safe output extraction, display-only decorators, and image indicators", () => {
		registerToolResultDecorator(["unfamiliar_safe_tool"], (_name, result) => ({
			...result,
			content: [
				{ type: "text", text: "redacted\x1b[2J output" },
				{ type: "image", mimeType: "image/png" },
			],
		}));
		const component = tool("unfamiliar_safe_tool", {});
		component.updateResult({
			content: [{ type: "text", text: "private undecorated text" }],
			isError: false,
		});
		const rows = component.render(80);
		const text = stripAnsi(rows.join("\n"));
		expect(text).toContain("redacted");
		expect(text).not.toContain("private undecorated text");
		expect(text).toContain("image/png");
		expect(rows.join("\n")).not.toContain("\x1b[2J");
	});

	it("retains completed output and highlighting across redraws, width changes, and invalidation", () => {
		const result = { content: [{ type: "text", text: "const counter = 42;" }] };
		const context: ToolRenderContext = { state: {}, invalidate: vi.fn() };
		const component = renderFallbackResult(
			"plain",
			result,
			{ expanded: true, isPartial: false },
			theme,
			context,
		);
		const first = component.render(80);
		for (let i = 0; i < 100; i++) expect(component.render(80)).toBe(first);
		expect(component.render(40)).not.toBe(first);
		component.invalidate?.();
		expect(component.render(80)).not.toBe(first);
		detection.get("const counter = 42;")!("javascript");
		expect(context.invalidate).toHaveBeenCalled();
		detection.clear(); // Simulate eviction from the shared detection cache.
		const refreshed = renderFallbackResult(
			"plain",
			result,
			{ expanded: true, isPartial: false },
			theme,
			context,
		);
		expect(stripAnsi(refreshed.render(80).join("\n"))).toContain("counter");
		expect(detection.size).toBe(0);
	});

	it("wraps expanded arguments and output at narrow widths without breaking rails", () => {
		const args = { url: "https://example.com/" + "path/".repeat(15), nested: { label: "🌍 café" } };
		const call = renderFallbackCall("chrome-devtools/new_page", args, theme, { expanded: true });
		const result = renderFallbackResult(
			"plain",
			{ content: [{ type: "text", text: "🌍 café ".repeat(50) }] },
			{ expanded: true, isPartial: false },
			theme,
			{},
		);
		for (const width of [40, 80, 120]) {
			const rows = [...call.render(width), ...result.render(width)];
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			expect(stripAnsi(rows.join("\n"))).toContain("café");
		}
	});

	it("uses the same generic MCP frame for live nested codemode calls", () => {
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
			label: "chrome-devtools/new_page",
			namespace: { name: "mcp__chrome-devtools" },
		};
		const mode = {
			ui: { requestRender: () => {} },
			session: { getToolDefinition: () => definition },
			sessionManager: { getCwd: () => process.cwd() },
			getRegisteredToolDefinition: () => definition,
		};
		(InteractiveMode.prototype as any).getRegisteredToolDefinition.call(mode, "codemode");
		for (const handler of handlers.get("tool_result")!)
			handler({
				parentToolCallId: "parent",
				toolCallId: "child",
				input: { url: "http://localhost:1111" },
				content: [{ type: "text", text: "## Pages\n1: Example" }],
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
			details: { calls: [{ id: "child", name: "mcp__chrome-devtools__new_page", status: "ok" }] },
			isError: false,
		});
		const text = stripAnsi(parent.render(100).join("\n"));
		expect(text).toContain("│╭── chrome-devtools/new_page");
		expect(text).toContain("││ ## Pages");
		expect(text).toContain("│╰── ✓ complete");
	});
});
