import slackSearch from "./slack-search.ts";
import slackRead from "./slack-read.ts";
import cloud from "./cloud.ts";
import knowledge from "./knowledge.ts";
import research from "./research.ts";
import toolbox from "./toolbox.ts";
import type { ToolFormatter } from "./types.ts";
export type { ToolFormatter } from "./types.ts";

// Add/remove one module here to enable/disable a customisation.
const formatters: ToolFormatter[] = [
	slackSearch,
	...slackRead,
	...cloud,
	...knowledge,
	...research,
	...toolbox,
];
const normalise = (name: string) => name.replace(/-/g, "_");
const registry = new Map<string, ToolFormatter>();
for (const formatter of formatters) {
	for (const name of formatter.tools) {
		const key = normalise(name);
		if (registry.has(key)) throw new Error(`Duplicate Chrome formatter: ${name}`);
		registry.set(key, formatter);
	}
}

/** Normal and identifier-safe MCP tool names resolve to the same formatter. */
export function toolFormatter(name: string): ToolFormatter | undefined {
	return registry.get(normalise(name));
}
