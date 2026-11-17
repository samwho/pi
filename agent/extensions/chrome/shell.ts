import { execFile, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";

const BUILTINS = new Set(
	". : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait".split(
		" ",
	),
);
const THEMES = ["github-dark", "github-light"] as const;
type CommandSpan = { start: number; end: number; valid: boolean };
type ShellView = {
	source: string;
	tokens?: Record<string, ThemedToken[][]>;
	commands: CommandSpan[];
};
type Entry = { view: ShellView; pending: boolean; listeners: Map<string, () => void> };

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** shfmt supplies real Bash parsing; no command is ever evaluated to colour it. */
export class ShellRenderer {
	private cache = new Map<string, Entry>();
	private processes = new Set<ChildProcess>();
	private highlighter?: Promise<Highlighter>;
	private closed = false;

	private run(source: string, args: string[], cwd: string): Promise<string> {
		return new Promise((resolveResult, reject) => {
			if (this.closed) {
				reject(new Error("Shell renderer closed"));
				return;
			}
			// Match mise.toml's pinned formatter, even before Pi's PATH is refreshed.
			const dataDir =
				process.env.MISE_DATA_DIR ??
				join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "mise");
			const binary = join(dataDir, "installs/shfmt/3.14.1/shfmt");
			const child = execFile(
				binary,
				args,
				{ cwd, timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
				(error, stdout) => {
					this.processes.delete(child);
					if (error) reject(error);
					else resolveResult(stdout);
				},
			);
			this.processes.add(child);
			child.stdin?.on("error", () => {});
			child.stdin?.end(source);
		});
	}

	private async executable(command: string, cwd: string): Promise<boolean> {
		if (BUILTINS.has(command)) return true;
		const candidates = command.includes("/")
			? [resolve(cwd, command)]
			: [
					resolve(cwd, command),
					...(process.env.PATH ?? "")
						.split(delimiter)
						.map((dir) => resolve(cwd, dir || ".", command)),
				];
		const found = await Promise.all(
			candidates.map(async (path) => {
				try {
					await access(path, constants.X_OK);
					return (await stat(path)).isFile();
				} catch {
					return false;
				}
			}),
		);
		return found.some(Boolean);
	}

	private async commands(source: string, cwd: string): Promise<CommandSpan[]> {
		const ast: unknown = JSON.parse(await this.run(source, ["-ln", "bash", "--to-json"], cwd));
		const calls: Array<{ node: Record<string, unknown>; directory: string }> = [];
		const functions = new Set<string>();
		const literalWord = (value: unknown): string | undefined => {
			const parts = object(value).Parts;
			if (!Array.isArray(parts)) return undefined;
			let text = "";
			for (const raw of parts as unknown[]) {
				const part = object(raw);
				if ((part.Type === "Lit" || part.Type === "SglQuoted") && typeof part.Value === "string")
					text += part.Value;
				else if (part.Type === "DblQuoted") {
					const quoted = literalWord(part);
					if (quoted === undefined) return undefined;
					text += quoted;
				} else return undefined;
			}
			return /[\\\\$\x60]/.test(text) ? undefined : text;
		};
		// Track literal cd in straight-line statements and successful && chains.
		// Changes in subshells, substitutions, functions, and pipelines stay scoped.
		const visit = (value: unknown, directory: string): string => {
			if (Array.isArray(value)) {
				let current = directory;
				for (const child of value as unknown[]) current = visit(child, current);
				return current;
			}
			const node = object(value);
			if (node.Type === "BinaryCmd") {
				const afterLeft = visit(node.X, directory);
				const afterRight = visit(node.Y, node.Op === "&&" ? afterLeft : directory);
				return node.Op === "&&" ? afterRight : directory;
			}
			if (node.Type === "CallExpr") {
				calls.push({ node, directory });
				visit(node.Args, directory);
				const args = Array.isArray(node.Args) ? (node.Args as unknown[]) : [];
				if (literalWord(args[0]) !== "cd") return directory;
				const argument = literalWord(args[1]) === "--" ? args[2] : args[1];
				const destination = argument === undefined ? homedir() : literalWord(argument);
				if (destination === undefined || destination.startsWith("-")) return directory;
				return resolve(
					directory,
					destination === "~"
						? homedir()
						: destination.startsWith("~/")
							? join(homedir(), destination.slice(2))
							: destination,
				);
			}
			if (node.Type === "FuncDecl") {
				const name = object(node.Name).Value;
				if (typeof name === "string") functions.add(name);
			}
			if (node.Cmd && !node.Type) {
				const after = visit(node.Cmd, directory);
				visit(node.Redirs, directory);
				return node.Background ? directory : after;
			}
			if (node.Type === "File" || node.Type === "Block") return visit(node.Stmts, directory);
			for (const child of Object.values(node))
				if (child !== null && typeof child === "object") visit(child, directory);
			return directory;
		};
		visit(ast, cwd);
		const bytes = Buffer.from(source);
		const lookups = new Map<string, Promise<boolean>>();
		const spans = await Promise.all(
			calls.map(async ({ node: call, directory }): Promise<CommandSpan | undefined> => {
				const args = call.Args;
				if (!Array.isArray(args)) return undefined;
				const word = object(args[0]);
				const command = literalWord(word);
				if (!command) return undefined;
				const start = object(word.Pos).Offset;
				const end = object(word.End).Offset;
				if (typeof start !== "number" || typeof end !== "number") return undefined;
				const key = JSON.stringify([directory, command]);
				let lookup = lookups.get(key);
				if (!lookup) {
					lookup = functions.has(command)
						? Promise.resolve(true)
						: this.executable(command, directory);
					lookups.set(key, lookup);
				}
				return {
					start: bytes.subarray(0, start).toString().length,
					end: bytes.subarray(0, end).toString().length,
					valid: await lookup,
				};
			}),
		);
		return spans.filter((span): span is CommandSpan => span !== undefined);
	}

	private async breakChains(source: string, cwd: string): Promise<string> {
		const ast: unknown = JSON.parse(await this.run(source, ["-ln", "bash", "--to-json"], cwd));
		const bytes = Buffer.from(source);
		const positions: number[] = [];
		const visit = (value: unknown) => {
			if (Array.isArray(value)) {
				for (const child of value as unknown[]) visit(child);
				return;
			}
			const node = object(value);
			if (node.Type === "BinaryCmd") {
				const offset = object(node.OpPos).Offset;
				const leftEnd = object(object(node.X).End).Offset;
				if (
					typeof offset === "number" &&
					typeof leftEnd === "number" &&
					!bytes.subarray(leftEnd, offset).includes(10)
				)
					positions.push(bytes.subarray(0, offset).toString().length);
			}
			for (const child of Object.values(node))
				if (child !== null && typeof child === "object") visit(child);
		};
		visit(ast);
		let broken = source;
		for (const offset of positions.sort((a, b) => b - a))
			broken = broken.slice(0, offset) + "\\\n" + broken.slice(offset);
		return broken;
	}

	private async prepare(source: string, cwd: string): Promise<ShellView> {
		let formatted = source;
		try {
			const multiline = await this.breakChains(source, cwd);
			formatted = (
				await this.run(multiline, ["-ln", "bash", "-i", "2", "-bn", "-ci"], cwd)
			).trimEnd();
		} catch {
			/* Incomplete or unsupported syntax remains fully visible. */
		}
		const commands = await this.commands(formatted, cwd).catch(() => [] as CommandSpan[]);
		this.highlighter ??= createHighlighter({ themes: [...THEMES], langs: ["bash"] });
		try {
			const highlighter = await this.highlighter;
			const tokens = Object.fromEntries(
				THEMES.map((theme) => [
					theme,
					highlighter.codeToTokens(formatted, { lang: "bash", theme }).tokens,
				]),
			);
			return { source: formatted, commands, tokens };
		} catch {
			return { source: formatted, commands };
		}
	}

	lines(
		source: string,
		cwd: string,
		complete: boolean,
		owner: string,
		invalidate: () => void,
		theme: Theme,
	): string[] {
		if (!complete || this.closed)
			return source.split("\n").map((line) => theme.fg("toolOutput", line));
		const key = JSON.stringify([source, cwd, process.env.PATH]);
		let entry = this.cache.get(key);
		if (!entry) {
			entry = { view: { source, commands: [] }, pending: true, listeners: new Map() };
			this.cache.set(key, entry);
			const retained = entry;
			void this.prepare(source, cwd)
				.then((view) => {
					retained.view = view;
					retained.pending = false;
					if (!this.closed) for (const notify of retained.listeners.values()) notify();
					retained.listeners.clear();
				})
				.catch(() => {
					retained.pending = false;
					retained.listeners.clear();
				});
			if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
		}
		if (entry.pending) entry.listeners.set(owner, invalidate);
		const view = entry.view;
		const tokens = view.tokens?.[theme.appearance === "light" ? "github-light" : "github-dark"];
		if (!tokens) return view.source.split("\n").map((line) => theme.fg("toolOutput", line));
		return tokens.map((line) =>
			line
				.map((token) => {
					const start = token.offset;
					const end = start + token.content.length;
					const commands = view.commands.filter((span) => span.start < end && span.end > start);
					const breaks = [
						...new Set([
							start,
							end,
							...commands.flatMap((span) => [Math.max(start, span.start), Math.min(end, span.end)]),
						]),
					].sort((a, b) => a - b);
					return breaks
						.slice(0, -1)
						.map((from, index) => {
							const text = token.content.slice(from - start, breaks[index + 1] - start);
							const command = commands.find((span) => span.start <= from && span.end > from);
							if (command) return theme.fg(command.valid ? "success" : "error", text);
							return token.color ? theme.style(text, { fg: parseColor(token.color) }) : text;
						})
						.join("");
				})
				.join(""),
		);
	}

	dispose(): void {
		this.closed = true;
		for (const child of this.processes) child.kill();
		this.processes.clear();
		this.cache.clear();
		void this.highlighter?.then((highlighter) => highlighter.dispose()).catch(() => {});
	}
}
