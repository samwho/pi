import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderClippedMarkdown } from "./clipped-markdown.ts";

beforeAll(() => initTheme());
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("tool-output Markdown", () => {
	it.each([
		["paragraph", (value: string) => `**${value}**`],
		["heading", (value: string) => `# ${value}`],
		["list", (value: string) => `- ${value}\n- second item`],
		["nested list", (value: string) => `- first\n  - ${value}`],
		["quote", (value: string) => `> ${value}`],
		["code fence", (value: string) => `\x60\x60\x60js\nconst message = "${value}";\n\x60\x60\x60`],
		["table", (value: string) => `| title | detail |\n| --- | --- |\n| ${value} | second |`],
	] as const)("keeps long %s lines on one row", (_name, source) => {
		for (const width of [20, 80, 200]) {
			const short = renderClippedMarkdown(source("short"), width);
			const long = renderClippedMarkdown(source("🌍 café ".repeat(100) + "HIDDEN_END"), width);
			expect(long).toHaveLength(short.length);
			expect(long.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(long.join("\n")).not.toContain("HIDDEN_END");
		}
	});

	it("clips raw table rows when the table has too many columns to render", () => {
		const cells = Array.from({ length: 16 }, () => "long cell");
		const source = `| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |\n| ${cells.join(" | ")} |`;
		const rows = renderClippedMarkdown(source, 20);
		expect(rows.length).toBeLessThanOrEqual(4);
		expect(rows.every((row) => visibleWidth(row) <= 20)).toBe(true);
	});

	it("retains Markdown styles and links while leaving ordinary Markdown wrapping unchanged", () => {
		const styled = renderClippedMarkdown("**bold** and [reference](https://example.com)", 100).join(
			"\n",
		);
		expect(stripAnsi(styled)).toContain("bold");
		expect(stripAnsi(styled)).toContain("reference");
		expect(styled).toContain("https://example.com");
		expect(styled).toContain("\x1b[");
		const source = "word ".repeat(100);
		const ordinary = () => new Markdown(source, 0, 0, getMarkdownTheme()).render(20);
		const before = ordinary();
		expect(renderClippedMarkdown(source, 20)).toHaveLength(1);
		expect(ordinary()).toEqual(before);
		expect(before.length).toBeGreaterThan(1);
	});
});
