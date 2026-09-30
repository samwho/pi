import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatToolHeading, frameToolCall } from "./tool-heading.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

describe("tool heading", () => {
	it("composes tool-specific arguments with the same name and spacing rules", () => {
		expect(
			formatToolHeading(theme, {
				name: "grep",
				arguments: [
					{ value: "pattern" },
					{ value: "in src/", color: "muted" },
					{ value: "(*.ts)", color: "muted" },
				],
			}),
		).toBe("grep pattern in src/ (*.ts)");
		expect(formatToolHeading(theme, { name: "codemode" })).toBe("codemode");
		expect(
			formatToolHeading(theme, {
				name: "web_search",
				arguments: [{ value: "query", color: "muted", separator: " · " }],
			}),
		).toBe("web_search · query");
	});

	it("puts multiline arguments inside the same frame without overflowing", () => {
		const lines = frameToolCall(
			{
				name: "bash",
				arguments: [{ value: "echo first" }],
				continuations: ["echo second", "echo third"],
				details: ["(5s timeout)"],
			},
			"pending",
			theme,
			48,
		).split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("bash echo first");
		expect(lines[0]).not.toContain("timeout");
		expect(lines[1]).toContain("│ echo second");
		expect(lines[2]).toContain("│ echo third");
		expect(lines[3]).toContain("╰ (5s timeout)");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
	});

	it("keeps a read range visible when a long path is truncated", () => {
		const lines = frameToolCall(
			{
				name: "read",
				arguments: [{ value: `/some/${"long/".repeat(15)}file.ts` }],
				details: ["from line 120 (50 lines)"],
			},
			"success",
			theme,
			48,
		).split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toContain("from line");
		expect(lines[1]).toContain("from line 120 (50 lines)");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
	});
});
