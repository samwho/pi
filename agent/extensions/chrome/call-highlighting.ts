import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";

const THEMES = ["github-dark", "github-light"] as const;
type PathState = {
	missing?: boolean;
	checked: number;
	pending: boolean;
	listeners: Map<string, () => void>;
};

/** Display-only decorations shared by normal and nested call headings. */
export class CallHighlighting {
	private paths = new Map<string, PathState>();
	private patterns = new Map<string, Record<string, ThemedToken[][]>>();
	private listeners = new Map<string, () => void>();
	private loading?: Promise<Highlighter | undefined>;
	private highlighter?: Highlighter;
	private loaded = false;
	private closed = false;

	regex(pattern: string, owner: string, invalidate: () => void, theme: Theme): string {
		if (this.closed) return theme.fg("accent", pattern);
		if (!this.loading) {
			this.loading = createHighlighter({ themes: [...THEMES], langs: ["regexp"] })
				.then((highlighter) => {
					this.highlighter = highlighter;
					this.loaded = true;
					if (!this.closed) for (const notify of this.listeners.values()) notify();
					this.listeners.clear();
					return highlighter;
				})
				.catch(() => {
					this.loaded = true;
					this.listeners.clear();
					return undefined;
				});
		}
		if (!this.highlighter) {
			if (!this.loaded) this.listeners.set(owner, invalidate);
			return theme.fg("accent", pattern);
		}
		let tokens = this.patterns.get(pattern);
		if (!tokens) {
			try {
				tokens = Object.fromEntries(
					THEMES.map((palette) => [
						palette,
						this.highlighter!.codeToTokens(pattern, { lang: "regexp", theme: palette }).tokens,
					]),
				);
				this.patterns.set(pattern, tokens);
				if (this.patterns.size > 128) this.patterns.delete(this.patterns.keys().next().value!);
			} catch {
				return theme.fg("accent", pattern);
			}
		}
		return tokens[theme.appearance === "light" ? "github-light" : "github-dark"]
			.map((line) =>
				line
					.map((token) =>
						token.color
							? theme.style(token.content, { fg: parseColor(token.color) })
							: token.content,
					)
					.join(""),
			)
			.join(" ");
	}

	missing(raw: string, cwd: string, owner: string, invalidate: () => void): boolean {
		if (this.closed) return false;
		const input = raw.replace(/^@/, "");
		const expanded =
			input === "~"
				? homedir()
				: input.startsWith("~/")
					? resolve(homedir(), input.slice(2))
					: input;
		const path = resolve(cwd, expanded);
		let state = this.paths.get(path);
		if (!state) {
			state = { checked: 0, pending: false, listeners: new Map() };
			this.paths.set(path, state);
			if (this.paths.size > 256) this.paths.delete(this.paths.keys().next().value!);
		}
		if (!state.pending && Date.now() - state.checked >= 1000) {
			state.pending = true;
			const retained = state;
			void stat(path)
				.then(() => {
					retained.missing = false;
				})
				.catch((error: unknown) => {
					const code = (error as NodeJS.ErrnoException).code;
					// Permission and I/O errors do not prove that the target is missing.
					retained.missing = code === "ENOENT" || code === "ENOTDIR";
				})
				.finally(() => {
					retained.checked = Date.now();
					retained.pending = false;
					if (!this.closed) for (const notify of retained.listeners.values()) notify();
					retained.listeners.clear();
				});
		}
		if (state.pending) state.listeners.set(owner, invalidate);
		return state.missing === true;
	}

	dispose(): void {
		this.closed = true;
		this.listeners.clear();
		this.paths.clear();
		this.patterns.clear();
		void this.loading?.then((highlighter) => highlighter?.dispose()).catch(() => {});
	}
}
