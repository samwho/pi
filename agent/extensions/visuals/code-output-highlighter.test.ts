import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, expect, it, vi } from "vitest";
import { __codeOutputHighlighterInternals } from "./code-output-highlighter/index.ts";

const detections = vi.hoisted(
	() =>
		new Map<
			string,
			{
				language?: string;
				listeners: Set<(language: string) => void>;
			}
		>(),
);

vi.mock("./shared/code-language.ts", () => ({
	detectedCodeLanguage: (sample: string, listener: (language: string) => void) => {
		let entry = detections.get(sample);
		if (!entry) {
			entry = { listeners: new Set() };
			detections.set(sample, entry);
		}
		if (!entry.language) entry.listeners.add(listener);
		return entry.language;
	},
}));

beforeAll(() => initTheme());

it("does not multiply pending language listeners when grep detections redraw", () => {
	const result = {
		details: {
			_type: "grepResult",
			pattern: "svg",
			text: Array.from(
				{ length: 8 },
				(_, i) => `card-${i}.unknown:1:<svg id="card-${i}">some content</svg>`,
			).join("\n"),
		},
	};
	let redraws = 0;
	const state = {};
	const render = () =>
		__codeOutputHighlighterInternals.highlightGrepResult(
			"grep",
			result,
			{ expanded: false, isPartial: false },
			{} as Theme,
			{
				state,
				invalidate: () => {
					redraws++;
					render();
				},
			},
		);
	render();
	for (let i = 0; i < 20; i++) render();
	expect(detections.size).toBe(8);
	for (const entry of detections.values()) expect(entry.listeners.size).toBe(1);
	for (const entry of detections.values()) {
		entry.language = "xml";
		for (const listener of entry.listeners) listener("xml");
		entry.listeners.clear();
	}
	expect(redraws).toBe(8);
});
