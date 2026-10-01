import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	registerMcpToolFormatter,
	type ToolCallView,
	type ToolOutputRow,
	type ToolResultView,
} from "./shared/tool-formatters.ts";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}
function json(text: string): RecordValue | undefined {
	try {
		return record(JSON.parse(text));
	} catch {
		return undefined;
	}
}
function id(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
function chromeLines(text: string, tool: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.filter((line) => line.trim() !== `# ${tool} response`);
}
function extras(data: RecordValue, known: string[]): ToolOutputRow[] {
	return Object.entries(data)
		.filter(([key]) => !known.includes(key))
		.map(([key, value]) => ({ text: `${key}: ${JSON.stringify(value)}`, color: "muted" }));
}

export function evaluateCall(args: unknown): ToolCallView | undefined {
	const input = record(args);
	if (typeof input?.function !== "string") return undefined;
	return {
		arguments: Object.entries(input)
			.filter(([key]) => key !== "function")
			.map(([key, value]) => ({ value: `${key}=${JSON.stringify(value)}`, color: "muted" })),
		code: { source: input.function, language: "javascript", format: "javascript-expression" },
	};
}

export function evaluateResult(text: string): ToolResultView | undefined {
	const lines = chromeLines(text, "evaluate_script");
	const source = lines.join("\n");
	const match = /^Script ran on page and returned:\s*\n```json\n([\s\S]*?)\n```/m.exec(source);
	if (!match) return undefined;
	let value = match[1];
	try {
		value = JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		/* undefined is a valid script result. */
	}
	const before = source.slice(0, match.index).trim();
	const after = source.slice(match.index + match[0].length).trim();
	return { lines: [before, value, after].filter(Boolean), language: "json" };
}

function consoleColor(type: string): ThemeColor {
	return ["error", "assert"].includes(type)
		? "error"
		: ["warn", "warning", "issue"].includes(type)
			? "warning"
			: ["debug", "verbose", "trace"].includes(type)
				? "muted"
				: "toolOutput";
}
function consoleSummary(types: string[]): string {
	const errors = types.filter((type) => ["error", "assert"].includes(type)).length;
	const warnings = types.filter((type) => ["warn", "warning", "issue"].includes(type)).length;
	return [
		`${types.length} console ${types.length === 1 ? "entry" : "entries"}`,
		errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
		warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}
export function consoleResult(text: string): ToolResultView | undefined {
	const data = json(text);
	const types: string[] = [];
	if (Array.isArray(data?.consoleMessages)) {
		const rows: ToolOutputRow[] = [];
		for (const value of data.consoleMessages) {
			const message = record(value);
			const msgid = id(message?.id);
			if (
				!message ||
				msgid === undefined ||
				typeof message.type !== "string" ||
				typeof message.text !== "string"
			)
				return undefined;
			types.push(message.type);
			rows.push({
				text: `msgid=${msgid} [${message.type}] ${message.text}${typeof message.argsCount === "number" ? ` (${message.argsCount} args)` : ""}${typeof message.count === "number" && message.count > 1 ? ` [${message.count} times]` : ""}`,
				color: consoleColor(message.type),
			});
			if (typeof message.stackTrace === "string")
				rows.push({ text: message.stackTrace, color: "muted" });
		}
		if (!rows.length) rows.push({ text: "No console messages", color: "muted" });
		rows.push(...extras(data, ["consoleMessages"]));
		return { lines: rows, summary: consoleSummary(types) };
	}
	const lines = chromeLines(text, "list_console_messages");
	const known = lines.some((line) => line.trim() === "## Console messages");
	let color: ThemeColor = "toolOutput";
	const rows = lines
		.filter((line) => line.trim() !== "## Console messages")
		.map((line): ToolOutputRow => {
			const match = /^msgid=\d+ \[([^\]]+)\]/.exec(line);
			if (match) {
				types.push(match[1]);
				color = consoleColor(match[1]);
			}
			if (line.trim() === "<no console messages found>")
				return { text: "No console messages", color: "muted" };
			return { text: line, color: /^\s+at |^Note:|^Showing |^Page /.test(line) ? "muted" : color };
		});
	const empty = lines.some((line) => line.trim() === "<no console messages found>");
	return types.length || (known && empty)
		? { lines: rows, summary: consoleSummary(types) }
		: undefined;
}

export function pagesResult(text: string): ToolResultView | undefined {
	const data = json(text);
	if (Array.isArray(data?.pages)) {
		const rows: ToolOutputRow[] = [];
		for (const value of data.pages) {
			const page = record(value);
			const pageId = id(page?.id);
			if (!page || pageId === undefined || typeof page.url !== "string") return undefined;
			rows.push({
				text: `${page.selected === true ? "●" : "·"} ${pageId} ${typeof page.title === "string" && page.title ? `${page.title} · ` : ""}${page.url}${typeof page.isolatedContext === "string" ? ` isolatedContext=${page.isolatedContext}` : ""}`,
				color: page.selected === true ? "success" : "toolOutput",
			});
		}
		if (!rows.length) rows.push({ text: "No open pages", color: "muted" });
		rows.push(...extras(data, ["pages"]));
		return {
			lines: rows,
			summary: `${data.pages.length} page${data.pages.length === 1 ? "" : "s"}`,
		};
	}
	const lines = chromeLines(text, "list_pages");
	let count = 0;
	const known =
		text.includes("# list_pages response") || lines.some((line) => line.trim() === "## Pages");
	const rows = lines
		.filter((line) => line.trim() !== "## Pages")
		.map((line): ToolOutputRow => {
			const match = /^(\d+): (.+)$/.exec(line);
			if (!match) return { text: line, color: "muted" };
			count++;
			const selected = / \[selected\](?= isolatedContext=|$)/.test(match[2]);
			return {
				text: `${selected ? "●" : "·"} ${match[1]} ${match[2].replace(/ \[selected\](?= isolatedContext=|$)/, "")}`,
				color: selected ? "success" : "toolOutput",
			};
		});
	if (
		!count &&
		(!known ||
			lines.some((line) => line.trim() && line.trim() !== "## Pages" && !line.startsWith("Note:")))
	)
		return undefined;
	if (!count && rows.every((row) => typeof row !== "string" && !row.text.trim()))
		rows.push({ text: "No open pages", color: "muted" });
	return { lines: rows, summary: `${count} page${count === 1 ? "" : "s"}` };
}

export default function (_pi: ExtensionAPI): void {
	registerMcpToolFormatter("chrome-devtools", "evaluate_script", {
		call: evaluateCall,
		result: (_result, context) => evaluateResult(context.text),
	});
	registerMcpToolFormatter("chrome-devtools", "list_console_messages", {
		result: (_result, context) => consoleResult(context.text),
	});
	registerMcpToolFormatter("chrome-devtools", "list_pages", {
		result: (_result, context) => pagesResult(context.text),
	});
}
