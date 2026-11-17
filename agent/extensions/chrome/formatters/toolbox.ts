import type { ToolFormatter } from "./types.ts";
import { count, entity, join, text } from "./shared.ts";

const toolbox: ToolFormatter[] = [
	{
		tools: ["mcp__toolbox_manage__discover"],
		call: (args) => ({ label: "toolbox inspect", subject: join(args.mode, args.operation_id) }),
		result(result) {
			const data = entity(result);
			if (!data) return undefined;
			if (Array.isArray(data.items)) return { summary: count(data.items.length, "operation") };
			if (data.mode === "schema" && data.operation) return { summary: "schema loaded" };
			if (data.mode === "account" && data.account) return { summary: "account loaded" };
			if (data.mode === "runtime" && data.runtime) return { summary: "runtime loaded" };
			return undefined;
		},
	},
	{
		tools: ["mcp__toolbox_manage__call"],
		call: (args) => ({
			label: args.validate_only === true ? "toolbox validate" : "toolbox call",
			subject: text(args.operation_id),
		}),
		result(result, context) {
			const data = entity(result);
			if (!data) return undefined;
			if (context.args.validate_only === true && data.valid === true)
				return { summary: "valid · not executed" };
			if (context.args.validate_only === true && data.valid === false)
				return { summary: "invalid · not executed" };
			if (data.ok === false || data.error) return { summary: "operation rejected" };
			if (data.ok === true) return { summary: "operation accepted" };
			return undefined;
		},
	},
];
export default toolbox;
