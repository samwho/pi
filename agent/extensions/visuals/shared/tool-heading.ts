import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { frameTop, type FrameStatus } from "../common/tool-frame/index.ts";

/** The tool owns its argument values; this module owns their shared chrome. */
export type HeadingArgument = {
	value: string;
	color?: ThemeColor;
	separator?: string;
};

export type ToolHeading = {
	name: string;
	arguments?: HeadingArgument[];
	/** Additional lines of the primary argument, e.g. a multi-line shell command. */
	continuations?: string[];
	/** Muted secondary arguments shown below the headline, after any continuations. */
	details?: string[];
	boldName?: boolean;
};

export function formatToolHeading(theme: Theme, heading: ToolHeading): string {
	const name = heading.boldName === false ? heading.name : theme.bold(heading.name);
	const firstLine =
		theme.fg("toolTitle", name) +
		(heading.arguments ?? [])
			.map(({ value, color = "accent", separator = " " }) => {
				const prefix = separator === " " ? separator : theme.fg("muted", separator);
				return prefix + theme.fg(color, value);
			})
			.join("");
	const continuations = heading.continuations?.map((line) => theme.fg("accent", line)) ?? [];
	const details = heading.details?.map((line) => theme.fg("muted", line)) ?? [];
	return [firstLine, ...continuations, ...details].join("\n");
}

/** One call-header path for built-in tools, codemode, and MCP-backed tools. */
export function frameToolCall(
	heading: ToolHeading,
	status: FrameStatus,
	theme: Theme,
	width: number,
): string {
	return frameTop(formatToolHeading(theme, heading), status, theme, width);
}
