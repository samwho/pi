import type { ToolFormatter } from "./types.ts";
import {
	body,
	count,
	entity,
	envelope,
	join,
	listSummary,
	object,
	reference,
	text,
	tokens,
	words,
} from "./shared.ts";

const knowledge: ToolFormatter[] = [
	{
		tools: ["mcp__linear__list_issues"],
		call: (args) => ({
			label: "linear issues",
			subject: join(
				args.query || args.customView || "all",
				args.team ? `team:${reference(args.team)}` : "",
				args.project ? `project:${reference(args.project)}` : "",
				args.state ? `state:${reference(args.state)}` : "",
				args.assignee === null || args.assignee === "null"
					? "unassigned"
					: args.assignee
						? `assignee:${reference(args.assignee)}`
						: "",
			),
		}),
		result(result) {
			const summary = listSummary(result, ["issues", "results"], "issue");
			return summary === undefined ? undefined : { summary };
		},
		unavailableSummary: "? issues",
	},
	{
		tools: ["mcp__linear__get_issue"],
		call: (args) => ({ label: "linear issue", subject: reference(args.id, "issue") }),
		result(result, context) {
			const data = entity(result);
			if (!data) return undefined;
			const title = text(data.title);
			const status = typeof data.status === "string" ? data.status : object(data.status).name;
			const identifier =
				text(data.identifier) ||
				(/^[A-Z][A-Z0-9]*-\d+$/.test(text(data.id))
					? text(data.id)
					: /^[A-Z][A-Z0-9]*-\d+$/.test(text(context.args.id))
						? text(context.args.id)
						: "");
			return title || status
				? {
						subject: [identifier, title].filter(Boolean).join(" ") || undefined,
						summary: text(status) || tokens(context.tokens),
					}
				: undefined;
		},
	},
	{
		tools: ["mcp__notion__notion_search"],
		call: (args) => ({
			label: "notion search",
			subject: join(
				args.query,
				args.query_type === "user" ? "people" : "",
				object(args.filters).title_only === true ? "title only" : "",
			),
		}),
		result(result) {
			const summary = listSummary(result, ["results"], "result");
			return summary === undefined ? undefined : { summary };
		},
		unavailableSummary: "? results",
	},
	{
		tools: ["mcp__notion__notion_fetch"],
		call: (args) => ({ label: "notion read", subject: reference(args.id, "page") }),
		result(result, context) {
			const data = envelope(result);
			const raw = body(result);
			const opening = raw.match(/<(?:page|database|data-source)\b[^>]*>/)?.[0] ?? "";
			const title =
				text(data?.title) ||
				text(object(data?.properties).title) ||
				text(opening.match(/\btitle="([^"]*)"/)?.[1]);
			const truncated = data?.truncated === true || /\btruncated="true"/.test(opening);
			return {
				subject: title || undefined,
				summary: join(tokens(context.tokens), truncated ? "truncated" : ""),
			};
		},
	},
	{
		tools: ["mcp__notion__notion_update_page"],
		call: (args) => ({
			label: "notion update",
			subject: join(
				reference(args.page_id, "page"),
				text(args.command).replace(/_/g, " "),
				Array.isArray(args.content_updates)
					? count(args.content_updates.length, "replacement")
					: "",
			),
		}),
		result(result) {
			const data = envelope(result);
			if (!data) return undefined;
			if (data.type === "async_task" || data.async_task)
				return {
					summary: `async ${text(data.status ?? object(data.async_task).status) || "accepted"}`,
				};
			return data.page_id ? { summary: "updated" } : undefined;
		},
	},
	{
		tools: ["mcp__notion__notion_create_pages"],
		call: (args) => ({
			label: "notion create",
			subject: join(
				Array.isArray(args.pages) ? count(args.pages.length, "page") : "",
				text(object(args.parent).page_id) ? reference(object(args.parent).page_id, "parent") : "",
				args.creation_mode === "draft" ? "private draft" : "",
			),
		}),
		result(result) {
			const data = envelope(result);
			if (!data) return undefined;
			if (data.type === "async_task" || data.async_task)
				return {
					summary: `async ${text(data.status ?? object(data.async_task).status) || "accepted"}`,
				};
			return Array.isArray(data.pages)
				? { summary: `${count(data.pages.length, "page")} created` }
				: undefined;
		},
	},
	{
		tools: ["mcp__notion__notion_get_tool_access"],
		call: (args) => ({ label: "notion access", subject: words(args.tool_names) || "all tools" }),
		result(result, context) {
			const data = envelope(result);
			const tools = object(data?.tools);
			return Object.keys(tools).length
				? { summary: count(Object.keys(tools).length, "tool") }
				: { summary: tokens(context.tokens) };
		},
	},
];
export default knowledge;
