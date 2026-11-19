import { execFile, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor } from "@earendil-works/pi-tui";
import { analyseCommands, type ShellEnvironment } from "./shell-environment.ts";

const BUILTINS = new Set(
	". : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait".split(
		" ",
	),
);
const THEMES = ["github-dark", "github-light"] as const;
type CommandValidity = "found" | "missing" | "unknown";
type CommandSpan = { start: number; end: number; validity: CommandValidity };
type ShellView = {
	source: string;
	tokens?: Record<string, ThemedToken[][]>;
	commands: CommandSpan[];
};
type Entry = { view: ShellView; pending: boolean; invalidate?: () => void };
/** Owned by one transcript row, including its nested calls; never globally evicted. */
export type ShellRowState = Map<string, { key: string; entry: Entry }>;
const PREPARATION_CONCURRENCY = 2;
const SHARED_PREPARATIONS = 128;
const REUSE_MS = 2_000;

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** shfmt supplies real Bash parsing; no command is ever evaluated to colour it. */
export class ShellRenderer {
	private queue: Array<{ run: () => void; cancel: () => void }> = [];
	private activePreparations = 0;
	private processes = new Set<ChildProcess>();
	private highlighter?: Promise<Highlighter>;
	private recent = new Map<string, { job: Promise<ShellView>; until: number }>();
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

	private prepareShared(key: string, source: string, cwd: string): Promise<ShellView> {
		const existing = this.recent.get(key);
		if (existing && existing.until > performance.now()) return existing.job;
		const entry = { job: this.schedule(source, cwd), until: Infinity };
		this.recent.delete(key);
		this.recent.set(key, entry);
		if (this.recent.size > SHARED_PREPARATIONS)
			this.recent.delete(this.recent.keys().next().value!);
		void entry.job.then(
			() => {
				entry.until = performance.now() + REUSE_MS;
			},
			() => {
				if (this.recent.get(key) === entry) this.recent.delete(key);
			},
		);
		return entry.job;
	}

	/** Bound the whole preparation pipeline, not just individual shfmt invocations. */
	private schedule(source: string, cwd: string): Promise<ShellView> {
		return new Promise((resolveResult, reject) => {
			const cancel = () => reject(new Error("Shell renderer closed"));
			if (this.closed) {
				cancel();
				return;
			}
			const run = () => {
				this.activePreparations++;
				void this.prepare(source, cwd)
					.then(resolveResult, reject)
					.finally(() => {
						this.activePreparations--;
						if (!this.closed) this.queue.shift()?.run();
					});
			};
			if (this.activePreparations < PREPARATION_CONCURRENCY) run();
			else this.queue.push({ run, cancel });
		});
	}

	private async executable(
		command: string,
		environment: ShellEnvironment,
	): Promise<CommandValidity> {
		if (BUILTINS.has(command) || environment.functions.has(command)) return "found";
		const candidates: string[] = [];
		let unknown = false;
		if (command.includes("/")) {
			if (isAbsolute(command)) candidates.push(command);
			else if (environment.cwd !== undefined) candidates.push(resolve(environment.cwd, command));
			else unknown = true;
		} else {
			// Preserve the local-binary display hint as well as real PATH lookup.
			if (environment.cwd !== undefined) candidates.push(resolve(environment.cwd, command));
			else unknown = true;
			if (environment.path === undefined) unknown = true;
			else
				for (const dir of environment.path.split(delimiter)) {
					if (isAbsolute(dir)) candidates.push(resolve(dir, command));
					else if (environment.cwd !== undefined)
						candidates.push(resolve(environment.cwd, dir || ".", command));
					else unknown = true;
				}
			unknown ||= environment.unknownCommands;
		}
		const results = await Promise.all(
			[...new Set(candidates)].map(async (path): Promise<CommandValidity> => {
				try {
					await access(path, constants.X_OK);
					return (await stat(path)).isFile() ? "found" : "missing";
				} catch (error: unknown) {
					const code = (error as NodeJS.ErrnoException).code;
					return ["ENOENT", "ENOTDIR", "EACCES"].includes(code ?? "") ? "missing" : "unknown";
				}
			}),
		);
		if (results.includes("found")) return "found";
		return unknown || results.includes("unknown") ? "unknown" : "missing";
	}

	private async commands(source: string, cwd: string): Promise<CommandSpan[]> {
		const ast: unknown = JSON.parse(await this.run(source, ["-ln", "bash", "--to-json"], cwd));
		const startupUnknown = Boolean(process.env.BASH_ENV);
		const functions = new Set(
			Object.keys(process.env).flatMap((name) => {
				const match = name.match(/^BASH_FUNC_(.+)%%$/);
				return match ? [match[1]] : [];
			}),
		);
		const calls = analyseCommands(ast, {
			cwd: startupUnknown ? undefined : cwd,
			path: startupUnknown ? undefined : process.env.PATH,
			home: startupUnknown ? undefined : (process.env.HOME ?? homedir()),
			pwd: startupUnknown ? undefined : cwd,
			oldpwd: startupUnknown ? undefined : process.env.OLDPWD,
			functions: startupUnknown ? new Set() : functions,
			unknownCommands: startupUnknown,
		});
		const bytes = Buffer.from(source);
		const lookups = new Map<string, Promise<CommandValidity>>();
		const spans = await Promise.all(
			calls.map(async ({ word, command, environment }): Promise<CommandSpan | undefined> => {
				if (!command) return undefined;
				const start = object(word.Pos).Offset;
				const end = object(word.End).Offset;
				if (typeof start !== "number" || typeof end !== "number") return undefined;
				const key = JSON.stringify([
					environment.cwd,
					environment.path,
					environment.unknownCommands,
					environment.functions.has(command),
					command,
				]);
				let lookup = lookups.get(key);
				if (!lookup) {
					lookup = this.executable(command, environment);
					lookups.set(key, lookup);
				}
				return {
					start: bytes.subarray(0, start).toString().length,
					end: bytes.subarray(0, end).toString().length,
					validity: await lookup,
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
		if (this.closed) return { source: formatted, commands };
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
		rows: ShellRowState,
		owner: string,
		invalidate: () => void,
		theme: Theme,
		defer = false,
	): string[] {
		if (!complete || this.closed || (defer && !rows.has(owner)))
			return source.split("\n").map((line) => theme.fg("toolOutput", line));
		const key = JSON.stringify([
			source,
			cwd,
			process.env.PATH,
			process.env.HOME,
			process.env.OLDPWD,
			process.env.BASH_ENV,
			Object.keys(process.env).filter((name) => name.startsWith("BASH_FUNC_")),
		]);
		const saved = rows.get(owner);
		let entry = saved?.key === key ? saved.entry : undefined;
		if (!entry) {
			entry = { view: { source, commands: [] }, pending: true };
			rows.set(owner, { key, entry });
			const retained = entry;
			void this.prepareShared(key, source, cwd)
				.then((view) => {
					retained.view = view;
					retained.pending = false;
					const notify = retained.invalidate;
					retained.invalidate = undefined;
					// Arguments may have changed while the old preparation was queued.
					if (!this.closed && rows.get(owner)?.entry === retained) notify?.();
				})
				.catch(() => {
					retained.pending = false;
					retained.invalidate = undefined;
				});
		}
		if (entry.pending) entry.invalidate = invalidate;
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
							if (command)
								return theme.fg(
									command.validity === "found"
										? "success"
										: command.validity === "missing"
											? "error"
											: "toolOutput",
									text,
								);
							return token.color ? theme.style(text, { fg: parseColor(token.color) }) : text;
						})
						.join("");
				})
				.join(""),
		);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const job of this.queue.splice(0)) job.cancel();
		for (const child of this.processes) child.kill();
		this.processes.clear();
		this.recent.clear();
		void this.highlighter?.then((highlighter) => highlighter.dispose()).catch(() => {});
	}
}
