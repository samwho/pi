import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
		(!pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== ".." && !isAbsolute(pathFromDirectory))
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

function isSessionMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
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

export default function (pi: ExtensionAPI) {
	const completedReadPaths = new Set<string>();

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
			return;
		}

		const targetPath = normalizePath(ctx.cwd, event.input.path);
		const sessionReadPaths = getReadPaths(ctx.sessionManager.getBranch(), ctx.cwd);
		const knownReadPaths = new Set([...sessionReadPaths, ...completedReadPaths]);
		const unreadAgentsFiles: string[] = [];

		for (const agentsPath of getAncestorAgentsFiles(ctx.cwd, targetPath)) {
			if (knownReadPaths.has(agentsPath)) {
				continue;
			}
			if (await fileExists(agentsPath)) {
				unreadAgentsFiles.push(agentsPath);
			}
		}

		if (unreadAgentsFiles.length === 0) {
			return;
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
		if (typeof path === "string") {
			completedReadPaths.add(normalizePath(ctx.cwd, path));
		}
	});
}
