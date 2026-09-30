// Deterministic, private-data-free history. No tools or model requests are executed.
export function scrollingFixture(cwd, turns = 250) {
	const timestamp = Date.parse("2026-01-01T00:00:00Z");
	const entries = [
		{
			type: "session",
			version: 3,
			id: "pi-scroll-fixture",
			timestamp: new Date(timestamp).toISOString(),
			cwd,
		},
	];
	let parentId = null;
	const append = (message) => {
		const id = entries.length.toString(16).padStart(8, "0");
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp + entries.length).toISOString(),
			message,
		});
		parentId = id;
	};
	const usage = {
		input: 10000,
		output: 200,
		cacheRead: 9000,
		cacheWrite: 0,
		totalTokens: 19200,
		cost: { input: 0.01, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.013 },
	};
	const assistant = (content, stopReason = "stop") => ({
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6.1-sol",
		usage,
		stopReason,
		timestamp,
	});
	for (let turn = 0; turn < turns; turn++) {
		append({ role: "user", content: `Inspect rendering example ${turn}.`, timestamp });
		const name =
			turn % 4 === 2 ? "mcp__chrome-devtools__take_snapshot" : turn % 2 ? "bash" : "read";
		const args =
			name === "bash"
				? { command: "printf 'fixture output'", timeout: 10 }
				: name === "read"
					? { path: `src/example-${turn}.ts` }
					: { pageId: 2 };
		const text = Array.from({ length: 60 }, (_, i) =>
			name.startsWith("mcp__")
				? `uid=${turn}_${i} StaticText "Snapshot row ${i} 🌍 café"`
				: `export const item${i} = ${turn + i}; // 🌍 café`,
		).join("\n");
		const nativeId = `tool-${turn}`;
		const codeId = `codemode-${turn}`;
		const code = Array.from({ length: 12 }, (_, i) => `text(${i} + "example ${turn}");`).join("\n");
		append(
			assistant(
				[
					{ type: "thinking", thinking: `Check example ${turn} without changing its behaviour.` },
					{ type: "toolCall", id: nativeId, name, arguments: args },
					{ type: "toolCall", id: codeId, name: "codemode", arguments: { code } },
				],
				"toolUse",
			),
		);
		append({
			role: "toolResult",
			toolCallId: nativeId,
			toolName: name,
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
			details:
				name === "read"
					? { _type: "readFile", filePath: args.path, content: text, offset: 1, lineCount: 60 }
					: name === "bash"
						? { _type: "bashResult", text, exitCode: 0, command: args.command }
						: { server: "chrome-devtools", tool: "take_snapshot" },
		});
		append({
			role: "toolResult",
			toolCallId: codeId,
			toolName: "codemode",
			timestamp,
			isError: turn % 17 === 0,
			content: [
				{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n" },
				{
					type: "text",
					text: JSON.stringify(
						{ turn, items: Array.from({ length: 15 }, (_, i) => ({ id: i, label: "fixture 🌍" })) },
						null,
						2,
					),
				},
			],
			details: {
				calls: [
					{
						id: `${codeId}/1`,
						name: "read",
						args: JSON.stringify(args),
						status: "success",
						durationMs: 2,
					},
					{
						id: `${codeId}/2`,
						name: "bash",
						args: JSON.stringify({ command: "echo fixture" }),
						status: "success",
						durationMs: 3,
					},
				],
			},
		});
		append(
			assistant([
				{
					type: "text",
					text: `## Example ${turn}\n\nRendering **still works**. [Reference](https://example.com/${turn}).\n\n\`\`\`ts\nconst unicode = "🌍 café";\n\`\`\`\n\n- Compact preview\n- Full output on expansion\n- Narrow-width wrapping`,
				},
			]),
		);
	}
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
