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
				arguments: [{ value: "echo first" }, { value: "(5s timeout)", color: "muted" }],
				continuations: ["echo second", "echo third"],
			},
			"pending",
			theme,
			48,
		).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("bash echo first (5s timeout)");
		expect(lines[1]).toContain("│ echo second");
		expect(lines[2]).toContain("╰ echo third");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
	});
});
