import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { grouped } from "./codemode-renderer.ts";
import { frameRail } from "./common/tool-frame/index.ts";

const theme = {
	fg: (_color: string, value: string) => `\x1b[36m${value}\x1b[0m`,
};

describe("codemode grouping rail", () => {
	it("clips native ANSI rows by one column without changing their content", () => {
		const width = 40;
		const nativeRows = new Text("\x1b[31mHighlighted 🌍 text\x1b[0m\nsecond line", 0, 0).render(
			width,
		);
		const rail = frameRail(theme as never, "borderMuted");
		const actual = grouped(nativeRows, theme as never, width);

		expect(actual).toEqual(nativeRows.map((line) => rail + truncateToWidth(line, width - 1, "")));
		for (const line of actual) expect(visibleWidth(line)).toBe(width);
	});

	it("keeps trailing spaces on rows that do not need clipping", () => {
		const width = 40;
		const lines = ["short   ", "\x1b[31mshort\x1b[0m   "];
		const rail = frameRail(theme as never, "borderMuted");
		expect(grouped(lines, theme as never, width)).toEqual(lines.map((line) => rail + line));
	});

	it("still ANSI-truncates unpadded frame borders and long lines", () => {
		const width = 40;
		const lines = [
			"\x1b[36m" + "─".repeat(width) + "\x1b[0m",
			"x".repeat(width + 10),
			"\x1b]8;;https://example.com\x1b\\" + "link".padEnd(width),
		];
		const rail = frameRail(theme as never, "borderMuted");
		expect(grouped(lines, theme as never, width)).toEqual(
			lines.map((line) => rail + truncateToWidth(line, width - 1, "")),
		);
	});
});
