import type { ToolFormatter } from "./types.ts";
import { body, count, envelope, join, listSummary, reference, text, tokens } from "./shared.ts";

const slackRead: ToolFormatter[] = [
	{
		tools: ["mcp__slack__slack_read_thread"],
		call: (args) => ({ label: "slack thread", subject: join(args.channel_id, args.message_ts) }),
		result(result, context) {
			const summary = listSummary(result, ["messages", "replies"], "message");
			if (summary !== undefined) return { summary };
			const match = body(result).match(
				/(?:^|\n)\s*(?:#+\s*)?(?:Messages|Thread)\s*\((\d+)\s+messages?\)/i,
			);
			return {
				summary: join(match ? count(Number(match[1]), "message") : "", tokens(context.tokens)),
			};
		},
	},
	{
		tools: ["mcp__slack__slack_read_file"],
		call: (args) => ({ label: "slack file", subject: reference(args.file_id, "file") }),
		result(result, context) {
			const data = envelope(result);
			const mime =
				text(data?.mimeType ?? data?.mime_type) ||
				text(result.content?.find((part) => part.type === "image")?.mimeType);
			return {
				subject: text(data?.name ?? data?.title) || undefined,
				summary: join(mime, tokens(context.tokens)),
			};
		},
	},
];
export default slackRead;
