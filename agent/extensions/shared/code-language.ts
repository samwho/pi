import * as languageDetectionModule from "@vscode/vscode-languagedetection";
import type { ModelOperations, ModelResult } from "@vscode/vscode-languagedetection";

const SAMPLE_BYTES = 4 * 1024;
const MIN_CONFIDENCE = 0.1;
const MIN_MARGIN = 0.04;
const CACHE_LIMIT = 128;

const LanguageDetection =
	(languageDetectionModule as unknown as { default?: typeof languageDetectionModule }).default ??
	languageDetectionModule;
const ModelOperationsCtor = LanguageDetection.ModelOperations;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	bat: "bash",
	c: "c",
	clj: "clojure",
	cmake: "cmake",
	coffee: "coffeescript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	dockerfile: "dockerfile",
	erl: "erlang",
	go: "go",
	groovy: "groovy",
	hs: "haskell",
	html: "html",
	ini: "ini",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "javascript",
	kt: "kotlin",
	lua: "lua",
	makefile: "makefile",
	markdown: "markdown",
	md: "markdown",
	pas: "pascal",
	php: "php",
	pl: "perl",
	ps1: "powershell",
	py: "python",
	r: "r",
	rb: "ruby",
	rs: "rust",
	scala: "scala",
	sh: "bash",
	sql: "sql",
	swift: "swift",
	tex: "latex",
	ts: "typescript",
	tsx: "typescript",
	xml: "xml",
	yaml: "yaml",
};

type CacheEntry = {
	language?: string;
	settled: boolean;
	listeners: Set<() => void>;
};

let model: ModelOperations | undefined;
const cache = new Map<string, CacheEntry>();

function getModel(): ModelOperations {
	model ??= new ModelOperationsCtor({ minContentSize: 20, maxContentSize: SAMPLE_BYTES });
	return model;
}

function sampleUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= SAMPLE_BYTES) return text;
	let end = SAMPLE_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

function normalize(text: string): string {
	return sampleUtf8(
		text
			.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
	).trim();
}

function explicitLanguage(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			// Continue to statistical detection for incomplete JSON-like output.
		}
	}
	return undefined;
}

function selectLanguage(results: readonly ModelResult[]): string | undefined {
	const best = results[0];
	if (!best) return undefined;
	const second = results[1]?.confidence ?? 0;
	if (best.confidence < MIN_CONFIDENCE || best.confidence - second < MIN_MARGIN) return undefined;
	return LANGUAGE_ALIASES[best.languageId.toLowerCase()];
}

function touch(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/**
 * Return a cached language immediately. On a cache miss, start local detection
 * and invoke `onDetected` only if a confident language is found.
 */
export function detectedCodeLanguage(text: string, onDetected?: () => void): string | undefined {
	const explicit = explicitLanguage(text);
	if (explicit) return explicit;

	const sample = normalize(text);
	if (sample.length < 20) return undefined;

	const existing = cache.get(sample);
	if (existing) {
		touch(sample, existing);
		if (!existing.settled && onDetected) existing.listeners.add(onDetected);
		return existing.language;
	}

	const entry: CacheEntry = { settled: false, listeners: new Set(onDetected ? [onDetected] : []) };
	touch(sample, entry);
	getModel()
		.runModel(sample)
		.then(selectLanguage)
		.catch(() => undefined)
		.then((language) => {
			entry.language = language;
			entry.settled = true;
			if (language) for (const listener of entry.listeners) listener();
			entry.listeners.clear();
		});
	return undefined;
}

export const __codeLanguageInternals = {
	MIN_CONFIDENCE,
	MIN_MARGIN,
	SAMPLE_BYTES,
	normalize,
	selectLanguage,
};
