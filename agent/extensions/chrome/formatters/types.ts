import type { Result } from "../render.ts";

export type ResultContext = { name: string; args: Record<string, unknown>; tokens: number };
export type ResultPresentation = { summary: string; subject?: string };

/** Plain display data only. The shared renderer owns colours, layout, and expansion. */
export type ToolFormatter = {
	tools: readonly string[];
	call?: (
		args: Record<string, unknown>,
		context: { name: string },
	) => { label?: string; subject?: string } | undefined;
	result?: (result: Result, context: ResultContext) => ResultPresentation | undefined;
	/** Used only when a historical nested result was not recorded. */
	unavailableSummary?: string;
};
