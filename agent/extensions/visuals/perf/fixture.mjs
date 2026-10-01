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
		const chromeTools = ["take_snapshot", "evaluate_script", "list_console_messages", "list_pages"];
		const name =
			turn % 4 === 2
				? `mcp__chrome-devtools__${chromeTools[Math.floor(turn / 4) % chromeTools.length]}`
				: turn % 2
					? "bash"
					: "read";
		const args =
			name === "bash"
				? { command: "printf 'fixture output'", timeout: 10 }
				: name === "read"
					? { path: `src/example-${turn}.ts` }
					: name.endsWith("__evaluate_script")
						? {
								pageId: 2,
								function: `async()=>{const title=document.title;return{title,fixtureTurn:${turn}}}`,
							}
						: name.endsWith("__list_pages")
							? {}
							: { pageId: 2 };
		const body = Array.from({ length: 60 }, (_, i) => {
			const longTail = i % 11 === 0 ? " long column".repeat(50) : "";
			if (name.endsWith("__list_console_messages"))
				return `msgid=${turn * 100 + i} [${["log", "warn", "error"][i % 3]}] Fixture 🌍 café${longTail} (1 args)`;
			if (name.endsWith("__list_pages"))
				return `${i + 1}: Fixture 🌍 café (http://localhost:1111/fixture-${turn}/${i}${longTail.replaceAll(" ", "-")})${i === 0 ? " [selected]" : ""}`;
			return name.startsWith("mcp__")
				? `uid=${turn}_${i} StaticText "Snapshot row ${i} 🌍 café${longTail}"`
				: `export const item${i} = ${turn + i}; // 🌍 café${longTail}`;
		}).join("\n");
		const text = name.endsWith("__evaluate_script")
			? `# evaluate_script response\nScript ran on page and returned:\n\x60\x60\x60json\n${JSON.stringify({ title: "Fixture 🌍 café", turn })}\n\x60\x60\x60`
			: name.endsWith("__list_console_messages")
				? `# list_console_messages response\n## Console messages\n${body}`
				: name.endsWith("__list_pages")
					? `# list_pages response\n## Pages\n${body}`
					: body;
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
						: { server: "chrome-devtools", tool: name.split("__").at(-1) },
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
						{
							turn,
							items: Array.from({ length: 15 }, (_, i) => ({
								id: i,
								label: "fixture 🌍 " + "long output ".repeat(45),
							})),
						},
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
