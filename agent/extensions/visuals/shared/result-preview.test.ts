import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../config.ts";
import { limitResultPreview } from "./result-preview.ts";
import { registerToolRenderer } from "./tool-renderer-patch.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;
const rows = Array.from({ length: 85 }, (_, i) => `│ line ${i + 1}`);
const component: Component = { render: () => [...rows, "╰────────"], invalidate: () => {} };
let oldDir: string | undefined;
let dir: string;
beforeEach(() => {
	oldDir = process.env.PI_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "preview-test-"));
	process.env.PI_AGENT_DIR = dir;
	saveConfig(defaultConfig());
});
afterEach(() => {
	if (oldDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = oldDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("tool result preview", () => {
	it.each([
		["bash", 40],
		["read", 10],
		["grep", 10],
		["codemode", 40],
	])("limits %s to %i body rows and keeps the bottom border", (name, limit) => {
		const shown = limitResultPreview(component, name, false, theme, {}).render(100);
		expect(shown).toHaveLength(limit + 1);
		expect(shown[limit - 1]).toContain(`… ${86 - limit} more lines`);
		expect(shown.at(-1)).toBe("╰────────");
	});

	it("expands to all rows without changing the underlying result", () => {
		const expanded = limitResultPreview(component, "read", true, theme, {}).render(100);
		expect(expanded).toEqual([...rows, "╰────────"]);
	});

	it("honours per-tool overrides without restarting Pi", () => {
		const cfg = defaultConfig();
		cfg.previewLines.bash = 3;
		saveConfig(cfg);
		const shown = limitResultPreview(component, "bash", false, theme, {}).render(100);
		expect(shown).toHaveLength(4);
		expect(shown[2]).toContain("… 83 more lines");
	});

	it("supports a one-line preview without dropping the bottom border", () => {
		const cfg = defaultConfig();
		cfg.previewLines.bash = 1;
		saveConfig(cfg);
		const shown = limitResultPreview(component, "bash", false, theme, {}).render(100);
		expect(shown).toHaveLength(2);
		expect(shown[0]).toContain("… 85 more lines");
		expect(shown[1]).toBe("╰────────");
	});

	it("limits historical tools without a registered renderer", () => {
		initTheme();
		registerToolRenderer([], {
			renderCall: () => component,
			renderResult: () => component,
		});
		const tool = new ToolExecutionComponent(
			"missing_tool",
			"call-1",
			{},
			{},
			undefined,
			{ requestRender: () => {} } as never,
			process.cwd(),
		);
		tool.markExecutionStarted();
		tool.updateResult({ content: [{ type: "text", text: rows.join("\n") }], isError: false });
		const collapsed = tool.render(100).join("\n");
		expect(collapsed).toContain("line 39");
		expect(collapsed).not.toContain("line 40");
		expect(collapsed).toContain("… 46 more lines");
		tool.setExpanded(true);
		expect(tool.render(100).join("\n")).toContain("line 85");
	});

	it("also limits results without a visual frame", () => {
		const plain: Component = { render: () => rows, invalidate: () => {} };
		const shown = limitResultPreview(plain, "other", false, theme, {}).render(100);
		expect(shown).toHaveLength(40);
		expect(shown.at(-1)).toContain("… 46 more lines");
	});
});
