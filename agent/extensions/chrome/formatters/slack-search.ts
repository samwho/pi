import type { ToolFormatter } from "./types.ts";

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Count returned hits, not an advertised total that may include later pages. */
function resultCount(value: unknown, depth = 0): number | undefined {
	if (depth > 5 || value == null) return undefined;
	if (Array.isArray(value)) return value.length;
	if (typeof value === "string") {
		try {
			return resultCount(JSON.parse(value), depth + 1);
		} catch {
			/* Markdown is the usual Slack response. */
		}
		const categories = [...value.matchAll(/^##\s+(?:Messages|Files)\s*\(([\d,]+)\s+results?\)/gim)];
		if (categories.length)
			return categories.reduce((sum, match) => sum + Number(match[1].replace(/,/g, "")), 0);
		const count = value.match(/^\s*\(([\d,]+)\s+results?\)\s*$/im);
		if (count) return Number(count[1].replace(/,/g, ""));
		if (/\bno (?:search )?results?\b|\bno (?:matching )?messages\b/i.test(value)) return 0;
		return undefined;
	}
	const data = object(value);
	if (data.results !== undefined) {
		const count = resultCount(data.results, depth + 1);
		if (count !== undefined) return count;
	}
	const categories = [data.messages, data.files].filter((category) => category !== undefined);
	if (categories.length) {
		const counts = categories.map((category) => {
			if (Array.isArray(category)) return category.length;
			const matches = object(category).matches;
			return Array.isArray(matches) ? matches.length : undefined;
		});
		if (counts.every((count) => count !== undefined))
			return counts.reduce<number>((sum, count) => sum + count!, 0);
	}
	if (Array.isArray(data.matches)) return data.matches.length;
	return undefined;
}

const slackSearch: ToolFormatter = {
	tools: ["mcp__slack__slack_search_public", "mcp__slack__slack_search_public_and_private"],
	call(args, context) {
		const keywords = Array.isArray(args.keywords)
			? args.keywords.filter((word: unknown) => typeof word === "string").join(" ")
			: "";
		const filters = typeof args.filters === "string" ? args.filters : "";
		const query =
			[keywords, filters].filter(Boolean).join(" ") ||
			(typeof args.query === "string"
				? args.query
				: typeof args.natural_language_query === "string"
					? args.natural_language_query
					: "");
		return {
			label: context.name.endsWith("slack_search_public_and_private")
				? "slack search all"
				: "slack search",
			subject: query,
		};
	},
	result(result) {
		let count = resultCount(result.structuredContent);
		if (count === undefined) {
			const counts = (result.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => resultCount(part.text))
				.filter((value): value is number => value !== undefined);
			if (counts.length) count = counts.reduce((sum, value) => sum + value, 0);
		}
		if (count === undefined) return undefined;
		return { summary: `${count.toLocaleString("en-US")} ${count === 1 ? "result" : "results"}` };
	},
	unavailableSummary: "? results",
};
export default slackSearch;
