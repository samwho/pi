import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { networkRate, parseNetwork } from "./network-usage.ts";
import { renderTool, type RenderEnvironment } from "./render.ts";
import {
	installBashUsage,
	measure,
	monitoredOperations,
	parseProcesses,
	processTree,
	usageLabels,
} from "./bash-usage.ts";

describe("Bash resource usage", () => {
	it("includes workers in the detached group and descendants in other groups", () => {
		const rows = parseProcesses(`
		10 1 10 1:00.00 1024
		11 1 10 1:40.00 2048
		12 11 12 1-02:03:04 4096
		13 1 13 0:01.00 8192
		`);
		const tree = processTree(rows, 10);
		expect(tree.map((row) => row.pid)).toEqual([10, 11, 12]);
		expect(tree[2].cpuSeconds).toBe(93784);
		const before = measure(tree, undefined, 1_000);
		expect(before.sample).toEqual({ rssKiB: 7168, cpu: undefined });
		for (const row of tree) row.cpuSeconds += 0.5;
		const next = measure(tree, before.baseline, 2_000);
		expect(next.sample.cpu).toBe(150);
	});

	it("formats numeric readings in their existing colors", () => {
		expect(usageLabels({ cpu: 150, rssKiB: 2048, network: { down: 2048, up: 20 } })).toEqual([
			{ label: "CPU 150%", color: "accent" },
			{ label: "RAM 2 MiB", color: "success" },
			{ label: "↓ 2.0 KiB/s", color: "muted" },
			{ label: "↑ 20 B/s", color: "muted" },
		]);
	});

	it("renders telemetry alongside elapsed time and output tokens", () => {
		const view = {
			id: "call",
			name: "bash",
			args: {},
			complete: true,
			status: "running" as const,
			startedAt: performance.now(),
			stats: { tokens: 5 },
		};
		const env = {
			theme: { fg: (_color: string, text: string) => text },
			spinner: "⠋",
			width: 120,
			bashUsage: () => ({ cpu: 20, rssKiB: 2048, network: { down: 500, up: 600 } }),
		} as unknown as RenderEnvironment;
		expect(renderTool(view, env).map(({ text }) => text)).toEqual([
			expect.stringMatching(
				/^⠋ bash · .* elapsed · ~5 output tokens · CPU 20% · RAM 2 MiB · ↓ 500 B\/s · ↑ 600 B\/s$/,
			),
		]);
		const narrow = renderTool(view, { ...env, width: 53 })[0].text;
		expect(narrow.length).toBeLessThanOrEqual(53);
		expect(narrow).toContain("~5 output tokens");
		expect(renderTool({ ...view, status: "success" }, env)[0].text).not.toContain("CPU");
	});

	it("sums network deltas only for the selected Bash workers", () => {
		const counters = parseNetwork(
			",bytes_in,bytes_out,\nnode.worker.100,1000,2000,\nother.102,3000,4000,",
		);
		const current = parseNetwork(
			",bytes_in,bytes_out,\nnode.worker.100,3000,500,\nchild.101,500,700,\nother.102,90000,90000,",
		);
		if (!counters || !current) throw new Error("Missing counters");
		const before = { at: 1000, counters };
		const after = { at: 3000, counters: current };
		expect(networkRate([100, 101], undefined, after)).toBeUndefined();
		expect(networkRate([100, 101], before, after)).toEqual({ down: 1250, up: 350 });
		expect(networkRate([103], before, after)).toEqual({ down: 0, up: 0 });
		expect(parseNetwork(",bytes_in,bytes_out,")).toEqual(new Map());
		expect(parseNetwork("unexpected")).toBeUndefined();
	});

	it.skipIf(!["darwin", "linux"].includes(process.platform))(
		"hands off the actual Bash PID without adding output",
		async () => {
			let file = "";
			let stopped = false;
			let output = "";
			const ops = monitoredOperations((path) => {
				file = path;
				return () => {
					stopped = true;
				};
			});
			let pid = "";
			const result = await ops.exec(`printf '%s' "$$"; exit 7`, process.cwd(), {
				onData: (data) => {
					output += data.toString();
					pid = readFileSync(file, "utf8").trim();
				},
			});
			expect(result.exitCode).toBe(7);
			expect(pid).toMatch(/^\d+$/);
			expect(output).toBe(pid);
			expect(stopped).toBe(true);
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(!["darwin", "linux"].includes(process.platform))(
		"samples a silent running worker and clears telemetry on cancel",
		async () => {
			const handlers = new Map<string, () => void>();
			const ctx = {
				mode: "tui",
				cwd: process.cwd(),
				sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
			} as ExtensionToolContext;
			let tool: ToolDefinition | undefined;
			const getUsage = installBashUsage({
				on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => void) => {
					handlers.set(event, () => handler({ type: event }, ctx));
				},
				getSettings: () => ({}),
				getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
				registerTool: (definition: ToolDefinition) => {
					tool = definition;
				},
			} as unknown as ExtensionAPI);
			handlers.get("session_start")?.();
			const controller = new AbortController();
			const onUpdate = vi.fn();
			if (!tool) throw new Error("Bash wrapper was not registered");
			const done = Promise.resolve(
				tool.execute("parent/0", { command: "sleep 10 & wait" }, controller.signal, onUpdate, ctx),
			).catch((error: unknown) => error);
			try {
				await vi.waitFor(
					() => {
						const latest = getUsage("parent/0");
						expect(latest?.rssKiB ?? 0).toBeGreaterThan(0);
						expect(latest?.cpu).toBeDefined();
						expect(latest?.network).toEqual(
							process.platform === "darwin" ? { down: 0, up: 0 } : undefined,
						);
					},
					{ timeout: 4_000 },
				);
				expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ content: [], details: undefined });
			} finally {
				controller.abort();
				await done;
				handlers.get("session_shutdown")?.();
			}
			expect(await done).toMatchObject({ message: "Command aborted" });
			expect(getUsage("parent/0")).toBeUndefined();
		},
	);
});
