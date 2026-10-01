import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerCodemode, { renderResult } from "./codemode-renderer.ts";
import { defaultConfig, saveConfig } from "./config.ts";

const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
	bold: (text: string) => text,
} as Theme;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const text = Array.from({ length: 120 }, (_, i) => `output row ${i}`).join("\n");
const result = {
	content: [
		{ type: "text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" },
		{ type: "text", text },
	],
	details: {
		calls: Array.from({ length: 6 }, (_, i) => ({
			name: `nested_tool_${i}`,
			args: JSON.stringify({ path: `file-${i}.ts`, offset: 1, limit: 220, extra: "fixture" }),
			status: "ok",
		})),
		fullOutputPath: "/tmp/full-output.txt",
	},
};
let oldDir: string | undefined;
let dir: string;
beforeEach(() => {
	oldDir = process.env.PI_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "codemode-preview-test-"));
	process.env.PI_AGENT_DIR = dir;
	saveConfig(defaultConfig());
});
afterEach(() => {
	if (oldDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = oldDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("codemode section previews", () => {
	it("keeps all nested calls and limits only the labelled script output", () => {
		const component = renderResult(result, { expanded: false, isPartial: false }, theme, {});
		const rows = component.render(100);
		const rendered = stripAnsi(rows.join("\n"));
		for (let i = 0; i < 6; i++) expect(rendered).toContain(`nested_tool_${i}`);
		expect(rows.length).toBeGreaterThan(40);
		expect(rendered).toContain("script output");
		expect(rendered).toContain("output row 38");
		expect(rendered).not.toContain("output row 39");
		expect(rendered).toContain("81 more output rows");
		expect(rendered).not.toMatch(/\d+ more lines/);
		expect(rendered).toContain("Full output: /tmp/full-output.txt");
		const notice = rows.find((row) => row.includes("more output rows"))!;
		expect(stripAnsi(notice)).toMatch(/^││ /);
		expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true);
		expect(component.render(100)).toBe(rows);
	});

	it("does not get clipped again by the native tool-renderer dispatcher", () => {
		initTheme();
		registerCodemode({ on: () => () => {} } as unknown as ExtensionAPI);
		const tool = new ToolExecutionComponent(
			"codemode",
			"preview-parent",
			{},
			{},
			{} as never,
			{ requestRender: () => {} } as never,
			process.cwd(),
		);
		tool.updateResult({ ...result, isError: false });
		const collapsed = stripAnsi(tool.render(100).join("\n"));
		expect(collapsed).toContain("nested_tool_5");
		expect(collapsed).toContain("script output");
		expect(collapsed).toContain("81 more output rows");
		expect(collapsed).not.toMatch(/\d+ more lines/);
		tool.setExpanded(true);
		const expanded = stripAnsi(tool.render(100).join("\n"));
		expect(expanded).toContain("output row 119");
		expect(expanded).not.toContain("more output rows");
		tool.setExpanded(false);
		expect(stripAnsi(tool.render(100).join("\n"))).toBe(collapsed);
	});

	it.each([false, true])(
		"truncates long output lines without adding rows (expanded=%s)",
		(expanded) => {
			const source = {
				content: [
					{ type: "text", text: "\x1b[31m" + "🌍 café ".repeat(100) + "HIDDEN_END\x1b[0m" },
				],
				details: {},
			};
			const cfg = defaultConfig();
			cfg.previewLines.codemode = 3;
			saveConfig(cfg);
			const component = renderResult(source, { expanded, isPartial: false }, theme, {});
			for (const width of [40, 80, 160]) {
				const rows = component.render(width);
				expect(rows).toHaveLength(4); // Summary, header, one output line, footer.
				expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
				expect(stripAnsi(rows[2])).toMatch(/^││ 🌍 café/);
				expect(rows.join("\n")).not.toContain("HIDDEN_END");
				expect(rows.join("\n")).not.toContain("more output rows");
			}
			expect(source.content[0].text).toContain("HIDDEN_END");
		},
	);

	it("counts only logical output lines regardless of terminal width", () => {
		const cfg = defaultConfig();
		cfg.previewLines.codemode = 3;
		saveConfig(cfg);
		const source = {
			content: [
				{
					type: "text",
					text: Array.from({ length: 10 }, (_, i) => `row ${i} ${"x".repeat(300)}`).join("\n"),
				},
			],
		};
		for (const width of [40, 80, 160]) {
			const collapsed = renderResult(
				source,
				{ expanded: false, isPartial: false },
				theme,
				{},
			).render(width);
			expect(collapsed).toHaveLength(6);
			expect(stripAnsi(collapsed.join("\n"))).toContain("8 more output rows");
			const expanded = renderResult(source, { expanded: true, isPartial: false }, theme, {}).render(
				width,
			);
			expect(expanded).toHaveLength(13);
			expect(stripAnsi(expanded.join("\n"))).toContain("row 9");
		}
	});

	it("honours a one-row output preview and leaves partial calls visible", () => {
		const cfg = defaultConfig();
		cfg.previewLines.codemode = 1;
		saveConfig(cfg);
		const collapsed = renderResult(result, { expanded: false, isPartial: false }, theme, {});
		const rendered = stripAnsi(collapsed.render(100).join("\n"));
		expect(rendered).toContain("120 more output rows");
		expect(rendered).not.toContain("output row 0");
		expect(rendered).toContain("Full output:");
		const partial = renderResult(result, { expanded: false, isPartial: true }, theme, {});
		expect(stripAnsi(partial.render(100).join("\n"))).toContain("nested_tool_5");
		expect(stripAnsi(partial.render(100).join("\n"))).not.toContain("script output");
	});
});
