import type { ToolFormatter } from "./types.ts";
import { body, count, join, listSummary, object, reference, tokens, words } from "./shared.ts";

const research: ToolFormatter[] = [
	{
		tools: ["mcp__drew__search_content_tool"],
		call: (args) => ({
			label: "drew search",
			subject: join(
				args.keyword || args.query,
				words(args.source_objects) || "gong_call",
				args.search_mode,
				args.after_date,
				args.before_date,
			),
		}),
		result(result) {
			const summary = listSummary(result, ["results", "documents"], "document");
			if (summary !== undefined) return { summary };
			const markers = [...body(result).matchAll(/\(Document:\s*([^\n)]+)\)/g)].map(
				(match) => match[1],
			);
			return markers.length ? { summary: count(new Set(markers).size, "document") } : undefined;
		},
		unavailableSummary: "? documents",
	},
	{
		tools: ["mcp__drew__get_content_tool"],
		call(args) {
			const documents = Array.isArray(args.documents) ? (args.documents as unknown[]) : [];
			const sources = [...new Set(documents.map((doc) => object(doc).source_object))];
			return {
				label: "drew read",
				subject: join(
					count(documents.length, "document"),
					words(sources),
					documents.length === 1 ? reference(object(documents[0]).document_id, "doc") : "",
				),
			};
		},
		result: (_result, context) => ({ summary: tokens(context.tokens) }),
	},
	...(
		[
			"atuin_history",
			"atuin_threads_search",
			"atuin_threads_list",
			"atuin_threads_read",
			"atuin_output_search",
		] as const
	).map((operation): ToolFormatter => ({
		tools: [`mcp__atuin__${operation}`],
		call(args) {
			if (operation === "atuin_history")
				return {
					label: "atuin history",
					subject: join(
						args.query || "recent",
						words(args.filter_modes),
						words(args.authors),
						args.only_failed === true ? "failed only" : "",
					),
				};
			if (operation === "atuin_threads_read")
				return {
					label: "atuin thread",
					subject: join(
						reference(args.session_id, "thread"),
						typeof args.start === "number" ? `from ${args.start}` : "",
						typeof args.limit === "number" ? `limit ${args.limit}` : "",
						args.query,
						words(args.roles),
					),
				};
			if (operation === "atuin_threads_list")
				return {
					label: "atuin threads",
					subject: join(args.cwd || "all projects", args.since, args.harness),
				};
			return {
				label: operation === "atuin_output_search" ? "atuin output search" : "atuin thread search",
				subject: join(words(args.terms), args.cwd, args.harness),
			};
		},
		result(result, context) {
			if (operation === "atuin_threads_read") return { summary: tokens(context.tokens) };
			const noun =
				operation === "atuin_history" || operation === "atuin_output_search" ? "command" : "thread";
			const summary = listSummary(
				result,
				["results", "history", "commands", "threads", "sessions"],
				noun,
			);
			return { summary: summary ?? tokens(context.tokens) };
		},
	})),
];
export default research;
