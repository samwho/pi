import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));
const betterleaksTool = "aqua:betterleaks/betterleaks@1.7.4";

type Finding = {
	StartLine: number;
	EndLine: number;
	StartColumn: number;
	EndColumn: number;
	Match?: string;
	/** The raw secret when Betterleaks runs with --redact=0; never log it. */
	Secret?: string;
};

function scan(text: string, signal?: AbortSignal): Promise<Finding[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"mise",
			[
				"exec",
				betterleaksTool,
				"--",
				"betterleaks",
				"stdin",
				"--no-banner",
				"--log-level",
				"error",
				// We need the raw Secret field to mask only that value rather than a
				// rule's broader Match (for example, `API_KEY=<value>`). It remains
				// inside this process, is never logged, and is replaced before Pi sees
				// the tool result.
				"--redact=0",
				"--report-format",
				"json",
				"--report-path",
				"-",
				"--exit-code",
				"0",
			],
			{
				cwd: extensionRoot,
				// Do not allow a project or user config to weaken the scan.
				env: { PATH: process.env.PATH },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`betterleaks exited with code ${code}: ${stderr}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout) as Finding[]);
			} catch {
				reject(new Error("betterleaks returned an invalid JSON report"));
			}
		});
		signal?.addEventListener("abort", () => child.kill(), { once: true });
		child.stdin.end(text);
	});
}

function offsetAt(lines: string[], line: number, column: number): number {
	let offset = 0;
	for (let index = 0; index < line - 1; index++) offset += lines[index]!.length + 1;
	return offset + column - 1;
}

function findingRange(text: string, lines: string[], finding: Finding): { start: number; end: number } {
	const matchStart = offsetAt(lines, finding.StartLine, finding.StartColumn);
	// Betterleaks' EndColumn is inclusive.
	const matchEnd = offsetAt(lines, finding.EndLine, finding.EndColumn) + 1;
	const secret = finding.Secret;
	if (!secret || secret === "REDACTED") return { start: matchStart, end: matchEnd };

	// Betterleaks reports one range for its full rule match, but also returns the
	// exact secret. Find that value within the finding's lines and pick the
	// occurrence nearest the reported match (some rules' Match starts after a
	// token prefix, such as the first character of a GitHub PAT).
	const lineStart = offsetAt(lines, finding.StartLine, 1);
	const endLine = lines[finding.EndLine - 1] ?? "";
	const lineEnd = offsetAt(lines, finding.EndLine, endLine.length + 1);
	let bestStart = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let start = text.indexOf(secret, lineStart); start !== -1 && start < lineEnd; start = text.indexOf(secret, start + 1)) {
		if (start + secret.length > lineEnd) continue;
		const distance = Math.abs(start - matchStart);
		if (distance < bestDistance) {
			bestStart = start;
			bestDistance = distance;
		}
	}
	return bestStart === -1
		? { start: matchStart, end: matchEnd }
		: { start: bestStart, end: bestStart + secret.length };
}

function mask(text: string, findings: Finding[]): string {
	const lines = text.split("\n");
	const ranges = findings
		.map((finding) => {
			const { start, end } = findingRange(text, lines, finding);
			return {
				start,
				end,
				// Preserve offsets so redacted output can safely be used for edits.
				replacement: "*".repeat(end - start),
			};
		})
		.sort((a, b) => b.start - a.start);

	let result = text;
	for (const { start, end, replacement } of ranges) {
		if (start < 0 || end > result.length || start >= end) continue;
		result = result.slice(0, start) + replacement + result.slice(end);
	}
	return result;
}

async function redact(text: string, signal?: AbortSignal): Promise<string> {
	return mask(text, await scan(text, signal));
}

async function redactContent<T extends { type: string; text?: string }>(
	content: T[],
	signal?: AbortSignal,
): Promise<T[]> {
	try {
		return await Promise.all(content.map(async (block) => {
			if (block.type !== "text" || typeof block.text !== "string") return block;
			return { ...block, text: await redact(block.text, signal) };
		}));
	} catch {
		// Never reveal output when the redactor itself is unavailable. Do not put
		// the scan error in the result: it can include the text being scanned.
		return [{ type: "text", text: "[Tool output withheld because secret redaction failed.]" } as T];
	}
}

async function redactDetails(value: unknown, signal?: AbortSignal): Promise<unknown> {
	if (typeof value === "string") return redact(value, signal);

	if (Array.isArray(value)) {
		return Promise.all(value.map((item) => redactDetails(item, signal)));
	}

	if (value !== null && typeof value === "object") {
		const entries = await Promise.all(
			Object.entries(value).map(async ([key, item]) => [
				key,
				await redactDetails(item, signal),
			]),
		);
		return Object.fromEntries(entries);
	}

	return value;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("secret-redactor", "secret redaction: active");
	});

	// Do not replace built-in tools here. Extensions such as pi-facelift wrap
	// them to attach custom renderers and metadata; registering fresh SDK tools
	// under the same names discards those wrappers. tool_result is middleware,
	// so it redacts the final result from whichever implementation is active.
	pi.on("tool_result", async (event, ctx) => {
		try {
			const [content, details] = await Promise.all([
				redactContent(event.content, ctx.signal),
				redactDetails(event.details, ctx.signal),
			]);
			return { content, details };
		} catch {
			return {
				content: [{ type: "text", text: "[Tool output withheld because secret redaction failed.]" }],
				details: { _type: "redactionFailed" },
			};
		}
	});
}
