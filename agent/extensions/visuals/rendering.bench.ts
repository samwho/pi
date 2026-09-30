import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { bench, afterAll, beforeAll } from "vitest";
import registerBuiltinTools from "./builtin-tools.ts";
import { genericFallback } from "./code-output-highlighter/index.ts";
import { grouped, renderCall as renderCodemodeCall } from "./codemode-renderer.ts";
import { renderResultFor as renderWebResult } from "./web-search-renderer.ts";
import { frameToolCall } from "./shared/tool-heading.ts";
import { frameResult } from "./common/tool-frame/index.ts";

const width = 160;
const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const theme = {
	fg: (_color: string, value: string) => `\x1b[36m${value}\x1b[0m`,
	bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
} as Theme;

const tools = new Map<string, any>();
const original = (_cwd: string) => ({
	name: "fixture",
	description: "fixture",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "" }] }),
});

registerBuiltinTools(
	{
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	},
	{
		sdk: {
			createReadToolDefinition: original as never,
			createBashToolDefinition: original as never,
			getAgentDir: () => "/tmp/pi-render-benchmark",
		},
		TextComponent: Text,
	},
);

const readTool = tools.get("read");
const bashTool = tools.get("bash");
const readLines = Array.from({ length: 80 }, (_, i) => `export const item${i} = ${i};`).join("\n");
const bashLines = Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(70)}`).join("\n");
const readCtx = {
	lastComponent: new Text("", 0, 0),
	state: {} as { _rt?: string },
	expanded: false,
	isError: false,
	isPartial: false,
	invalidate: () => {},
};
const bashCtx = {
	lastComponent: new Text("", 0, 0),
	state: {},
	expanded: false,
	isError: false,
	isPartial: false,
	invalidate: () => {},
};
const readResult = {
	content: [{ type: "text", text: readLines }],
	details: {
		_type: "readFile",
		filePath: "bench.ts",
		content: readLines,
		offset: 1,
		lineCount: 80,
	},
};
const bashResult = {
	content: [{ type: "text", text: bashLines }],
	details: { _type: "bashResult", text: bashLines, exitCode: 0, command: "bench" },
};
const options = { isPartial: false, expanded: false };
let nestedRead: ToolExecutionComponent;
let scriptComponent: Component;
let webComponent: Component;
let genericComponent: Component;
const jsonOutput = JSON.stringify(
	{ items: Array.from({ length: 80 }, (_, i) => ({ id: i, title: `Item ${i}` })) },
	null,
	2,
);
let renderedLines: string[] = [];
const script = Array.from({ length: 40 }, (_, i) => `text(${i} + "item${i}");`).join("\n");
const markdown = Array.from(
	{ length: 60 },
	(_, i) => `- [Source ${i}](https://example.com/${i}): Result **${i}** and a short summary.`,
).join("\n");

beforeAll(async () => {
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
	readTool.renderResult(readResult, options, theme, readCtx);
	const deadline = Date.now() + 5000;
	while (!readCtx.state._rt?.includes("item8") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!readCtx.state._rt?.includes("item8")) throw new Error("read highlighter did not warm up");

	initTheme();
	nestedRead = new ToolExecutionComponent(
		"read",
		"nested-read",
		{ path: "bench.ts" },
		{},
		readTool,
		{ requestRender: () => {} } as never,
		process.cwd(),
	);
	nestedRead.markExecutionStarted();
	nestedRead.setArgsComplete();
	nestedRead.updateResult({ ...readResult, isError: false });
	const nestedDeadline = Date.now() + 5000;
	while (!nestedRead.render(width).join("\n").includes("item8") && Date.now() < nestedDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!nestedRead.render(width).join("\n").includes("item8"))
		throw new Error("nested read did not warm up");

	scriptComponent = renderCodemodeCall({ code: script }, theme, {
		argsComplete: false,
		executionStarted: false,
		isPartial: true,
	});
	webComponent = renderWebResult(
		{
			content: [{ type: "text", text: markdown }],
			details: { providerKind: "native", sources: [] },
		},
		options,
		theme,
		{ isError: false },
	);
	scriptComponent.render(width);
	webComponent.render(width);
	genericComponent = genericFallback(
		{ expanded: true, isPartial: false, getTextOutput: () => jsonOutput },
		() => new Text(jsonOutput, 0, 0),
	)!;
	genericComponent.render(width);
});

afterAll(() => {
	void renderedLines.length;
	if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns);
	else Reflect.deleteProperty(process.stdout, "columns");
});

const benchmark = { time: 800, warmupTime: 200 };
bench(
	"tool heading, one argument",
	() => {
		frameToolCall(
			{ name: "read", arguments: [{ value: "src/example.ts" }] },
			"success",
			theme,
			width,
		);
	},
	benchmark,
);
bench(
	"frame result, 80 ANSI lines",
	() => {
		frameResult(bashLines, "success", theme, width);
	},
	benchmark,
);
bench(
	"read result, 10-row preview + Text.render",
	() => {
		readTool.renderResult(readResult, options, theme, readCtx).render(width);
	},
	benchmark,
);
bench(
	"bash result, 80 lines + Text.render",
	() => {
		bashTool.renderResult(bashResult, options, theme, bashCtx).render(width);
	},
	benchmark,
);
bench(
	"nested read redraw, setExpanded + render",
	() => {
		nestedRead.setExpanded(false);
		nestedRead.render(width);
	},
	benchmark,
);
bench(
	"nested read redraw, cached render only",
	() => {
		nestedRead.render(width);
	},
	benchmark,
);
bench(
	"nested read grouped redraw, guarded expansion",
	() => {
		renderedLines = nestedRead.render(width).map((line) => truncateToWidth(line, width - 1, ""));
	},
	benchmark,
);
bench(
	"codemode script redraw, 40 highlighted lines",
	() => {
		renderedLines = scriptComponent.render(width);
	},
	{ time: 200, warmupTime: 50 },
);
bench(
	"web search redraw, 60 markdown links",
	() => {
		renderedLines = webComponent.render(width);
	},
	{ time: 200, warmupTime: 50 },
);
bench(
	"generic JSON output redraw, 80 items",
	() => {
		renderedLines = genericComponent.render(width);
	},
	{ time: 200, warmupTime: 50 },
);
bench(
	"nested read grouped redraw, actual rail",
	() => {
		renderedLines = grouped(nestedRead.render(width), theme, width);
	},
	benchmark,
);
bench(
	"codemode script redraw after invalidation",
	() => {
		scriptComponent.invalidate?.();
		renderedLines = scriptComponent.render(width);
	},
	{ time: 400, warmupTime: 100 },
);
bench(
	"generic JSON output redraw after invalidation",
	() => {
		genericComponent.invalidate?.();
		renderedLines = genericComponent.render(width);
	},
	{ time: 400, warmupTime: 100 },
);
bench(
	"web search redraw after invalidation",
	() => {
		webComponent.invalidate?.();
		renderedLines = webComponent.render(width);
	},
	{ time: 400, warmupTime: 100 },
);
