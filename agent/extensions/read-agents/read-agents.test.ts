import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import readAgents from "../read-agents.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(extraExtensions: ExtensionFactory[] = []) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-read-agents-"));
	const agentDir = join(cwd, "agent");
	await mkdir(join(cwd, "project"));
	await Promise.all([
		writeFile(join(cwd, "project/AGENTS.md"), "Project instructions.\n"),
		writeFile(join(cwd, "project/a.txt"), "alpha\n"),
		writeFile(join(cwd, "project/b.txt"), "beta\n"),
	]);
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			readAgents,
			createCodemodeExtension({ models: false }),
			...extraExtensions,
		],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing static test model");
	const sessionManager = SessionManager.inMemory(cwd);
	// Supply an issuing assistant message without making any model requests.
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "script", name: "codemode", arguments: {} }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	sessionManager.appendMessage(assistant);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager,
		tools: ["read", "codemode"],
	});
	cleanups.push(async () => {
		session.dispose();
	});
	await session.bindExtensions({});
	session.agent.toolExecution = "parallel";
	return { cwd, session };
}

async function runScript(session: AgentSession, code: string, toolCallId = "script") {
	const tool = session.agent.state.tools.find((candidate) => candidate.name === "codemode");
	if (!tool) throw new Error("Missing codemode tool");
	// Its real wrapper supplies ctx.executeTool(), so nested reads go through
	// Pi's validation, extension hooks, and the actual QuickJS worker.
	const result = await tool.execute(toolCallId, { code }, new AbortController().signal);
	const output = result.content.filter((block) => block.type === "text").map((block) => block.text);
	expect(output[0]).toContain("Script completed");
	return output.slice(1).join("\n");
}

function parallelReads(paths: string[]) {
	return `return await Promise.all(${JSON.stringify(paths)}.map(async path => {
		try { return { path, status: "ok", value: await tools.read({path}) }; }
		catch (error) { return { path, status: "error", error: error.message }; }
	}));`;
}

interface ReadOutcome {
	path: string;
	status: "ok" | "error";
	value?: string;
	error?: string;
}

async function reads(session: AgentSession, paths: string[]): Promise<ReadOutcome[]> {
	return JSON.parse(await runScript(session, parallelReads(paths))) as ReadOutcome[];
}

describe("read-agents through codemode", () => {
	it("blocks reads when the batch omits AGENTS.md", async () => {
		const { session } = await setup();
		const outcomes = await reads(session, ["project/a.txt", "project/b.txt"]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "error"]);
		for (const outcome of outcomes) expect(outcome.error).toContain("project/AGENTS.md");
	});

	it.each([0, 1, 2])("allows sibling reads with AGENTS.md at position %i", async (index) => {
		const { session } = await setup();
		const paths = ["project/a.txt", "project/b.txt"];
		paths.splice(index, 0, "project/AGENTS.md");
		const outcomes = await reads(session, paths);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok"]);
	});

	it("allows a large batch with the instructions read last", async () => {
		const { session } = await setup();
		const paths = [...Array<string>(100).fill("project/a.txt"), "project/AGENTS.md"];
		const outcomes = await reads(session, paths);
		expect(outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
	});

	it("waits for a slow instructions read before allowing dependent reads", async () => {
		const order: string[] = [];
		const { session } = await setup([
			(pi) => {
				pi.on("tool_call", async (event) => {
					if (event.toolName !== "read") return;
					const path = String(event.input.path);
					if (path.endsWith("AGENTS.md")) {
						await new Promise((resolve) => setTimeout(resolve, 30));
					} else {
						order.push(path);
					}
				});
				pi.on("tool_execution_end", (event) => {
					if (event.toolCallId === "script/2") order.push("instructions done");
				});
			},
		]);
		const outcomes = await reads(session, ["project/a.txt", "project/AGENTS.md", "project/b.txt"]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok"]);
		expect(order[0]).toBe("instructions done");
		expect(order.slice(1).sort()).toEqual(["project/a.txt", "project/b.txt"]);
	});

	it.each(["block", "throw", "result error"])(
		"keeps dependent reads blocked on an instructions %s",
		async (failure) => {
			const { session } = await setup([
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName !== "read" || !String(event.input.path).endsWith("AGENTS.md"))
							return undefined;
						if (failure === "block") return { block: true, reason: "Instructions denied" };
						if (failure === "throw") throw new Error("Instructions failed");
						return undefined;
					});
					pi.on("tool_result", (event) => {
						if (
							failure === "result error" &&
							event.toolName === "read" &&
							String(event.input.path).endsWith("AGENTS.md")
						) {
							return { isError: true };
						}
						return undefined;
					});
				},
			]);
			const outcomes = await reads(session, [
				"project/a.txt",
				"project/AGENTS.md",
				"project/b.txt",
			]);
			expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "error", "error"]);
			expect(outcomes[0].error).toContain("project/AGENTS.md");
			const retry = await reads(session, ["project/a.txt"]);
			expect(retry[0].status).toBe("error");
		},
	);

	it("does not waive the gate after an actual read failure", async () => {
		const { cwd, session } = await setup();
		await rm(join(cwd, "project/AGENTS.md"));
		await mkdir(join(cwd, "project/AGENTS.md"));
		const outcomes = await reads(session, ["project/a.txt", "project/AGENTS.md"]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "error"]);
	});

	it("handles a reversed batch with multiple levels of instructions", async () => {
		const { cwd, session } = await setup();
		await mkdir(join(cwd, "project/child"));
		await Promise.all([
			writeFile(join(cwd, "AGENTS.md"), "Root instructions.\n"),
			writeFile(join(cwd, "project/child/AGENTS.md"), "Child instructions.\n"),
			writeFile(join(cwd, "project/child/a.txt"), "child\n"),
		]);
		const outcomes = await reads(session, [
			"project/child/a.txt",
			"project/child/AGENTS.md",
			"project/AGENTS.md",
			"AGENTS.md",
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok", "ok"]);
	});

	it("still requires an ancestor omitted from the batch", async () => {
		const { cwd, session } = await setup();
		await writeFile(join(cwd, "AGENTS.md"), "Root instructions.\n");
		const outcomes = await reads(session, ["project/a.txt", "project/AGENTS.md"]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "error"]);
	});

	it("normalizes absolute and @-prefixed instructions paths", async () => {
		const { cwd, session } = await setup();
		const outcomes = await reads(session, ["project/a.txt", `@${join(cwd, "project/AGENTS.md")}`]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok"]);
	});

	it("remembers successful codemode reads for later scripts", async () => {
		const { session } = await setup();
		expect((await reads(session, ["project/AGENTS.md"]))[0].status).toBe("ok");
		expect((await reads(session, ["project/a.txt"]))[0].status).toBe("ok");
	});

	it("does not wait for instructions in an unrelated script", async () => {
		const { session } = await setup([
			(pi) => {
				pi.on("tool_call", async (event) => {
					if (event.toolName === "read" && String(event.input.path).endsWith("AGENTS.md")) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				});
			},
		]);
		const [instructions, dependent] = await Promise.all([
			runScript(session, parallelReads(["project/AGENTS.md"]), "instructions"),
			runScript(session, parallelReads(["project/a.txt"]), "unrelated"),
		]);
		expect((JSON.parse(instructions) as ReadOutcome[])[0].status).toBe("ok");
		expect((JSON.parse(dependent) as ReadOutcome[])[0].status).toBe("error");
	});

	it("does not deadlock when tools execute sequentially", async () => {
		const { session } = await setup();
		session.agent.toolExecution = "sequential";
		const outcomes = await reads(session, ["project/a.txt", "project/AGENTS.md", "project/b.txt"]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["error", "ok", "ok"]);
	});
});
