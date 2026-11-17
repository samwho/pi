import type { Result } from "../render.ts";

/** Plain display data only. The shared renderer owns colours, layout, and expansion. */
export type ToolFormatter = {
	tools: readonly string[];
	call?: (args: Record<string, unknown>) => { label?: string; subject?: string } | undefined;
	result?: (result: Result) => { summary: string } | undefined;
	/** Used only when a historical nested result was not recorded. */
	unavailableSummary?: string;
};
