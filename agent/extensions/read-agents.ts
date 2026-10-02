import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isReadToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const AGENTS_FILE_NAME = "AGENTS.md";

function normalizePath(cwd: string, filePath: string): string {
	const pathWithoutPrefix = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	return resolve(cwd, pathWithoutPrefix);
}

function isWithinDirectory(directory: string, filePath: string): boolean {
	const pathFromDirectory = relative(directory, filePath);
	return (
		pathFromDirectory.length === 0 ||
		(!pathFromDirectory.startsWith(`..${sep}`) &&
			pathFromDirectory !== ".." &&
			!isAbsolute(pathFromDirectory))
	);
}

function getAncestorAgentsFiles(cwd: string, targetPath: string): string[] {
	if (!isWithinDirectory(cwd, targetPath)) {
		return [];
	}

	const targetDirectory = dirname(targetPath);
	const candidates: string[] = [];
	let currentDirectory = targetDirectory;

	while (isWithinDirectory(cwd, currentDirectory)) {
		const agentsPath = join(currentDirectory, AGENTS_FILE_NAME);
		if (agentsPath !== targetPath) {
			candidates.push(agentsPath);
		}
		if (currentDirectory === cwd) {
			break;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			break;
		}
		currentDirectory = parentDirectory;
	}

	return candidates.reverse();
}

function isSessionMessageEntry(
	entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message";
}

function getSuccessfulReadCallIds(entries: readonly SessionEntry[]): Set<string> {
	const successfulReadCallIds = new Set<string>();

	for (const entry of entries) {
		if (!isSessionMessageEntry(entry) || entry.message.role !== "toolResult") {
			continue;
		}

		if (entry.message.toolName === "read" && !entry.message.isError) {
			successfulReadCallIds.add(entry.message.toolCallId);
		}
	}

	return successfulReadCallIds;
}

function getReadPaths(entries: readonly SessionEntry[], cwd: string): Set<string> {
	const successfulReadCallIds = getSuccessfulReadCallIds(entries);
	const readPaths = new Set<string>();

	for (const entry of entries) {
		if (!isSessionMessageEntry(entry) || entry.message.role !== "assistant") {
			continue;
		}

		for (const contentBlock of entry.message.content) {
			if (contentBlock.type !== "toolCall" || contentBlock.name !== "read") {
				continue;
			}

			if (!successfulReadCallIds.has(contentBlock.id)) {
				continue;
			}

			const path = contentBlock.arguments.path;
			if (typeof path === "string") {
				readPaths.add(normalizePath(cwd, path));
			}
		}
	}

	return readPaths;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

interface PendingAgentsRead {
	path: string;
	parentToolCallId?: string;
	done: Promise<boolean>;
	finish: (success: boolean) => void;
}

async function waitForRead(done: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
	if (!signal) return done;
	if (signal.aborted) return false;

	let onAbort = () => {};
	const aborted = new Promise<boolean>((complete) => {
		onAbort = () => complete(false);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([done, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export default function (pi: ExtensionAPI) {
	const completedReadPaths = new Set<string>();
	const pendingAgentsReads = new Map<string, PendingAgentsRead>();

	// Context files are already included in Pi's initial system prompt. Record
	// those paths before the first tool call so the agent is not asked to read
	// an AGENTS.md file it has already received as prompt context.
	pi.on("before_agent_start", (event, ctx) => {
		for (const contextFile of event.systemPromptOptions.contextFiles ?? []) {
			completedReadPaths.add(normalizePath(ctx.cwd, contextFile.path));
		}
	});

	// Gate every read implementation, including tools supplied by other extensions.
	// This keeps the policy layered on top of wrappers such as pi-pretty instead of
	// competing with them for ownership of the `read` tool name.
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) {
			return undefined;
		}

		const targetPath = normalizePath(ctx.cwd, event.input.path);
		// Register before yielding, so a parallel sibling can find this read
		// regardless of its position in a Promise.all batch. Only reads that
		// reached tool_call are eligible: queued sequential calls cannot run
		// while this gate is waiting for them.
		if (basename(targetPath) === AGENTS_FILE_NAME) {
			let finish!: PendingAgentsRead["finish"];
			const done = new Promise<boolean>((complete) => {
				finish = complete;
			});
			pendingAgentsReads.set(event.toolCallId, {
				path: targetPath,
				parentToolCallId: event.parentToolCallId,
				done,
				finish,
			});
		}

		const sessionReadPaths = getReadPaths(ctx.sessionManager.getBranch(), ctx.cwd);
		const knownReadPaths = new Set([...sessionReadPaths, ...completedReadPaths]);
		const unreadAgentsFiles: string[] = [];

		for (const agentsPath of getAncestorAgentsFiles(ctx.cwd, targetPath)) {
			if (knownReadPaths.has(agentsPath) || completedReadPaths.has(agentsPath)) {
				continue;
			}
			if (!(await fileExists(agentsPath))) continue;

			// Filesystem checks yield to the sibling calls. Recheck completion,
			// then wait only for an instructions read under the same parent
			// tool (or another direct call), not an unrelated codemode script.
			if (completedReadPaths.has(agentsPath)) continue;
			const siblings = [...pendingAgentsReads.values()].filter(
				(read) => read.path === agentsPath && read.parentToolCallId === event.parentToolCallId,
			);
			const successes = await Promise.all(
				siblings.map((read) => waitForRead(read.done, ctx.signal)),
			);
			if (!successes.some(Boolean) && !completedReadPaths.has(agentsPath)) {
				unreadAgentsFiles.push(agentsPath);
			}
		}

		if (unreadAgentsFiles.length === 0) {
			return undefined;
		}

		const paths = unreadAgentsFiles.map((path) => `- ${path}`).join("\n");
		return {
			block: true,
			reason:
				`Read these AGENTS.md files before retrying ${targetPath}. ` +
				`Read them in the order listed, then retry the original file:\n${paths}`,
		};
	});

	// Record successful reads after the selected implementation has run. This
	// works for the built-in tool and for any extension that overrides it.
	pi.on("tool_result", (event, ctx) => {
		if (!isReadToolResult(event) || event.isError) {
			return;
		}

		const path = event.input.path;
		if (typeof path === "string" && !pendingAgentsReads.has(event.toolCallId)) {
			completedReadPaths.add(normalizePath(ctx.cwd, path));
		}
	});

	// Unlike tool_result, this also fires for blocked calls and observes the
	// final outcome after all result-transforming extensions have run.
	pi.on("tool_execution_end", (event) => {
		const read = pendingAgentsReads.get(event.toolCallId);
		if (!read) return;
		pendingAgentsReads.delete(event.toolCallId);
		if (!event.isError) completedReadPaths.add(read.path);
		read.finish(!event.isError);
	});

	const clearPendingReads = () => {
		for (const read of pendingAgentsReads.values()) read.finish(false);
		pendingAgentsReads.clear();
	};
	pi.on("agent_end", clearPendingReads);
	pi.on("session_shutdown", clearPendingReads);
}
