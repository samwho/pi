import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	record,
	resultStats,
	toolComponent,
	type Result,
	type ResultStats,
	type ToolView,
} from "./render.ts";
import { ShellRenderer } from "./shell.ts";
import { CallHighlighting } from "./call-highlighting.ts";
import registerSessionFooter from "./session-footer.ts";
import { installToolGrouping } from "./tool-layout.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const EMPTY = { render: () => [] as string[], invalidate() {} };
const STATS_ENTRY = "chrome-tool-stats/v1";
type RowState = { result?: Result; startedAt?: number; durationMs?: number };

/** Display-only: the same renderer handles direct, nested, live, and restored calls. */
export default function chrome(pi: ExtensionAPI): void {
	registerSessionFooter(pi);
	const stopGrouping = installToolGrouping();
	// Consecutive thinking summaries stay visible as one naturally wrapping paragraph.
	// This changes display only, including streamed and restored thinking runs.
	pi.registerMarkdownTransformer(
		(markdown) =>
			markdown
				.replace(/\r\n?/g, "\n")
				.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, "")
				.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
				.trim()
				.split(/\n[ \t]*\n+/)
				.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
				.filter(Boolean)
				.join(" · "),
		{ messageTypes: ["assistant-thinking"] },
	);
	const shell = new ShellRenderer();
	const highlighting = new CallHighlighting();
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const pending = new Map<string, () => void>();
	// Only finalized (post-middleware) nested results are retained. Never cache raw updates.
	const nested = new Map<string, Map<string, ToolView>>();
	// Unlike details.calls[].args, these session records contain structured,
	// untruncated arguments (within Pi's documented recording limits).
	const savedArguments = new Map<string, Record<string, unknown>>();
	const savedStats = new Map<string, ResultStats>();

	function rememberSavedArguments(value: unknown): void {
		const message = record(value);
		if (message.role !== "toolResult") return;
		const calls = record(message.nestedCalls).calls;
		if (!Array.isArray(calls)) return;
		for (const raw of calls as unknown[]) {
			const call = record(raw);
			if (
				typeof call.id === "string" &&
				call.arguments &&
				typeof call.arguments === "object" &&
				!Array.isArray(call.arguments)
			)
				savedArguments.set(call.id, record(call.arguments));
		}
	}

	function restoreSavedArguments(ctx: ExtensionContext): void {
		savedArguments.clear();
		savedStats.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") rememberSavedArguments(entry.message);
			else if (entry.type === "custom" && entry.customType === STATS_ENTRY) {
				const data = record(entry.data);
				const stats = record(data.stats);
				if (
					typeof data.id === "string" &&
					typeof stats.tokens === "number" &&
					Number.isSafeInteger(stats.tokens) &&
					stats.tokens >= 0
				)
					savedStats.set(data.id, {
						tokens: stats.tokens,
						matches:
							typeof stats.matches === "number" &&
							Number.isSafeInteger(stats.matches) &&
							stats.matches >= 0
								? stats.matches
								: undefined,
						limited: stats.limited === true,
						summary: typeof stats.summary === "string" ? stats.summary.slice(0, 256) : undefined,
					});
			}
		}
	}

	function remember(parent: string, child: ToolView): void {
		let calls = nested.get(parent);
		if (!calls) {
			calls = new Map();
			nested.set(parent, calls);
			if (nested.size > 16) nested.delete(nested.keys().next().value!);
		}
		calls.set(child.id, child);
		if (calls.size > 256) calls.delete(calls.keys().next().value!);
		// A deeply nested call invalidates its top-level owner too.
		for (const invalidate of pending.values()) invalidate();
	}

	function children(view: ToolView): ToolView[] {
		const live = nested.get(view.id);
		const calls = record(view.result?.details).calls;
		const merged = new Map<string, ToolView>();
		if (Array.isArray(calls))
			for (const [index, raw] of (calls as unknown[]).entries()) {
				const call = record(raw);
				if (typeof call.name !== "string") continue;
				const id = typeof call.id === "string" ? call.id : `${view.id}/metadata-${index}`;
				let preview: Record<string, unknown> = {};
				try {
					if (typeof call.args === "string") preview = record(JSON.parse(call.args));
				} catch {
					/* A truncated preview is not JSON. Prefer the structured session record. */
				}
				const current = live?.get(id);
				const args = { ...preview, ...savedArguments.get(id), ...record(current?.args) };
				merged.set(
					id,
					current
						? { ...current, args, stats: current.stats ?? savedStats.get(id) }
						: {
								id,
								name: call.name,
								args,
								stats: savedStats.get(id),
								argumentsUnavailable:
									Object.keys(args).length === 0 &&
									typeof call.args === "string" &&
									call.args !== "{}",
								complete: true,
								status:
									call.status === "running"
										? "running"
										: call.status === "error"
											? "error"
											: call.status === "cancelled"
												? "cancelled"
												: "success",
								error: typeof call.error === "string" ? call.error : undefined,
								durationMs: typeof call.durationMs === "number" ? call.durationMs : undefined,
							},
				);
			}
		for (const [id, call] of live ?? [])
			if (!merged.has(id))
				merged.set(id, { ...call, args: { ...savedArguments.get(id), ...record(call.args) } });
		return [...merged.values()];
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		restoreSavedArguments(ctx);
		timer = setInterval(() => {
			frame = (frame + 1) % FRAMES.length;
			for (const invalidate of pending.values()) invalidate();
		}, 100);
		timer.unref();
	});
	pi.on("message_end", (event) => rememberSavedArguments(event.message));
	pi.on("session_tree", (_event, ctx) => restoreSavedArguments(ctx));
	pi.on("session_compact", (_event, ctx) => restoreSavedArguments(ctx));
	pi.on("agent_settled", () => pending.clear());
	pi.on("session_shutdown", () => {
		stopGrouping();
		clearInterval(timer);
		pending.clear();
		nested.clear();
		savedArguments.clear();
		savedStats.clear();
		shell.dispose();
		highlighting.dispose();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !event.parentToolCallId) return;
		remember(event.parentToolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			args: event.args as unknown,
			startedAt: performance.now(),
			status: "running",
			complete: true,
		});
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui" || !event.parentToolCallId) return;
		const previous = nested.get(event.parentToolCallId)?.get(event.toolCallId);
		const stats =
			event.isError && event.toolName !== "bash" && event.toolName !== "codemode"
				? undefined
				: resultStats(event.toolName, event.result as Result);
		if (stats) {
			savedStats.set(event.toolCallId, stats);
			// Compact display stats/formatter summaries only, never raw results.
			pi.appendEntry(STATS_ENTRY, { id: event.toolCallId, stats });
		}
		remember(event.parentToolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			args: previous?.args ?? {},
			status: event.isError ? "error" : "success",
			durationMs:
				event.durationMs ??
				(previous?.startedAt !== undefined ? performance.now() - previous.startedAt : undefined),
			complete: true,
			result: event.result as Result,
			stats,
		});
	});

	pi.registerToolRenderer((name): ToolRenderers => ({
		renderShell: "self",
		renderCall(args: unknown, theme, context) {
			if (context.isPartial) pending.set(context.toolCallId, context.invalidate);
			else pending.delete(context.toolCallId);
			// Rendering is deferred until both slots have updated shared row state.
			const state = context.state as RowState;
			if (context.isPartial && context.executionStarted) state.startedAt ??= performance.now();
			if (!context.isPartial && state.startedAt !== undefined)
				state.durationMs ??= performance.now() - state.startedAt;
			return toolComponent(
				() => ({
					id: context.toolCallId,
					name,
					args,
					status: context.isPartial ? "running" : context.isError ? "error" : "success",
					complete: context.argsComplete || context.executionStarted || !context.isPartial,
					result: state.result,
					startedAt: state.startedAt,
					durationMs: context.durationMs ?? state.durationMs,
				}),
				() => ({
					theme,
					cwd: context.cwd,
					spinner: FRAMES[frame],
					expanded: context.expanded,
					invalidate: context.invalidate,
					shell,
					highlighting,
					children,
					errorHint: context.keyHint("app.tools.expand", "for full error"),
				}),
			);
		},
		renderResult(result: Result, _options, _theme, context) {
			(context.state as RowState).result = result;
			return EMPTY;
		},
	}));
}
