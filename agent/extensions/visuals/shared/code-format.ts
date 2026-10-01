import { format } from "prettier";

export type CodeFormat = "javascript" | "javascript-expression";
export type FormattedCode = { promise: Promise<string>; value?: string };
const cache = new Map<string, FormattedCode>();

/** Display-only formatting. Callers retain the entry in tool state across LRU eviction. */
export function formattedCode(source: string, kind: CodeFormat = "javascript"): FormattedCode {
	const key = JSON.stringify([kind, source]);
	const existing = cache.get(key);
	if (existing) return existing;
	// An assignment lets Babel parse anonymous functions as expressions too.
	const prefix = "const __piDisplay = ";
	const entry: FormattedCode = {
		promise: format(kind === "javascript-expression" ? `${prefix}${source};` : source, {
			parser: "babel",
			printWidth: 80,
			tabWidth: 2,
		}).then(
			(value) =>
				kind === "javascript-expression"
					? value
							.replace(/^const __piDisplay =\s*/, "")
							.trimEnd()
							.replace(/;$/, "")
					: value.trimEnd(),
			() => source,
		),
	};
	void entry.promise.then((value) => {
		entry.value = value;
	});
	cache.set(key, entry);
	if (cache.size > 32) cache.delete(cache.keys().next().value!);
	return entry;
}
