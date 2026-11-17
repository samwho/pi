import { stripVTControlCharacters } from "node:util";
import type { Result } from "../render.ts";

export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function text(value: unknown): string {
	return typeof value === "string"
		? stripVTControlCharacters(value)
				.replace(/[\x00-\x1f\x7f]/g, " ")
				.replace(/\s+/g, " ")
				.trim()
		: "";
}
export function join(...values: unknown[]): string {
	return values.map(text).filter(Boolean).join(" · ");
}
export function words(value: unknown): string {
	return Array.isArray(value) ? value.map(text).filter(Boolean).join(", ") : text(value);
}
export function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}
export function tokens(value: number): string {
	return `~${value.toLocaleString("en-US")} tokens`;
}
export function reference(value: unknown, kind = ""): string {
	const raw = text(value);
	if (!raw) return "";
	if (/^[\da-f]{8}-[\da-f-]{27}$/i.test(raw) || /^[\da-f]{32}$/i.test(raw))
		return `${kind ? kind + " " : ""}#${raw.slice(0, 8)}`;
	if (/^https?:\/\//.test(raw)) {
		try {
			const url = new URL(raw);
			return url.host + url.pathname; // Do not surface signed queries/fragments.
		} catch {
			return "[invalid URL]";
		}
	}
	return raw;
}
export function json(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value.replace(/^```(?:json)?\s*\n|\n```\s*$/g, ""));
	} catch {
		return value;
	}
}

/** Decode transport envelopes, never arbitrary object fields or secret values. */
export function payloads(result: Result): unknown[] {
	const output: unknown[] = [];
	const visit = (raw: unknown, depth: number) => {
		if (depth > 5 || raw === undefined || raw === null) return;
		const value = json(raw);
		const data = object(value);
		if (data.structuredContent !== undefined) {
			visit(data.structuredContent, depth + 1);
			return;
		}
		if (
			Array.isArray(data.content) &&
			data.content.some((block: unknown) =>
				["text", "image", "audio", "resource"].includes(String(object(block).type)),
			)
		) {
			for (const block of data.content as unknown[])
				if (object(block).type === "text") visit(object(block).text, depth + 1);
			return;
		}
		if (
			data.result !== undefined &&
			Object.keys(data).every((key) => ["result", "tool", "toolName", "name"].includes(key))
		) {
			visit(data.result, depth + 1);
			return;
		}
		output.push(value);
	};
	if (result.structuredContent !== undefined) visit(result.structuredContent, 0);
	if (!output.length)
		for (const part of result.content ?? []) if (part.type === "text") visit(part.text, 0);
	return output;
}
export function body(result: Result): string {
	return payloads(result)
		.map((value) => {
			if (typeof value === "string") return value;
			const data = object(value);
			return [data.results, data.messages, data.text, data.content]
				.filter((part) => typeof part === "string")
				.join("\n");
		})
		.filter(Boolean)
		.join("\n");
}
export function envelope(result: Result): Record<string, unknown> | undefined {
	return payloads(result)
		.map(object)
		.find((data) => Object.keys(data).length > 0);
}
export function entity(result: Result): Record<string, unknown> | undefined {
	const root = envelope(result);
	if (!root) return undefined;
	const data = root.data !== undefined ? object(root.data) : root;
	if (!Object.keys(data).length) return undefined;
	return { ...data, ...object(data.attributes) };
}
export function items(result: Result, keys: string[]): unknown[] | undefined {
	for (const value of payloads(result)) {
		if (Array.isArray(value)) return value;
		const data = object(value);
		for (const key of keys) {
			const candidate = json(data[key]);
			if (Array.isArray(candidate)) return candidate;
		}
	}
	return undefined;
}
export function more(result: Result): string {
	const root = envelope(result) ?? {};
	const meta = object(root.meta);
	return root.has_more === true ||
		root.hasNextPage === true ||
		Boolean(meta.cursor) ||
		(typeof meta.current_page === "number" &&
			typeof meta.last_page === "number" &&
			meta.current_page < meta.last_page)
		? "more available"
		: "";
}
export function listSummary(
	result: Result,
	keys: string[],
	singular: string,
	plural?: string,
): string | undefined {
	const rows = items(result, keys);
	return rows ? join(count(rows.length, singular, plural), more(result)) : undefined;
}
export function namedFields(args: Record<string, unknown>, excluded: string[]): string {
	// Field names only: never stringify config values, commands, tokens, or secrets.
	return Object.keys(args)
		.filter((key) => !excluded.includes(key))
		.map((key) => key.replace(/_/g, " "))
		.join(", ");
}
