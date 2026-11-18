import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	getShellConfig,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
	networkRate,
	readNetwork,
	type NetworkRate,
	type NetworkSnapshot,
} from "./network-usage.ts";

const INTERVAL_MS = 1_000;
const exec = promisify(execFile);
export type UsageSample = {
	cpu?: number;
	rssKiB: number;
	network?: NetworkRate;
};
type ProcessRow = {
	pid: number;
	parent: number;
	group: number;
	cpuSeconds: number;
	rssKiB: number;
};

function parseCpuTime(time: string): number {
	const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
	return (
		Number(days) * 86400 +
		clock.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0)
	);
}

export function parseProcesses(output: string): ProcessRow[] {
	return output.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\d+)\s*$/.exec(line);
		if (!match) return [];
		return [
			{
				pid: Number(match[1]),
				parent: Number(match[2]),
				group: Number(match[3]),
				cpuSeconds: parseCpuTime(match[4]),
				rssKiB: Number(match[5]),
			},
		];
	});
}

export function processTree(rows: ProcessRow[], root: number): ProcessRow[] {
	const children = new Map<number, ProcessRow[]>();
	// Pi starts each call in a detached process group. This also finds workers that
	// outlive the shell, and the traversal includes children with their own PGIDs.
	const tree = rows.filter((row) => row.group === root || row.pid === root);
	for (const row of rows) {
		const siblings = children.get(row.parent);
		if (siblings) siblings.push(row);
		else children.set(row.parent, [row]);
	}
	const seen = new Set(tree.map((row) => row.pid));
	for (const row of tree) {
		for (const child of children.get(row.pid) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			tree.push(child);
		}
	}
	return tree;
}

export function measure(
	rows: ProcessRow[],
	previous?: { at: number; times: Map<number, number> },
	at = performance.now(),
) {
	let delta = 0;
	let rssKiB = 0;
	const times = new Map<number, number>();
	for (const { pid, cpuSeconds, rssKiB: rss } of rows) {
		const before = previous?.times.get(pid);
		if (before !== undefined) delta += Math.max(0, cpuSeconds - before);
		rssKiB += rss;
		times.set(pid, cpuSeconds);
	}
	return {
		sample: {
			rssKiB,
			cpu: previous && at > previous.at ? (delta * 100_000) / (at - previous.at) : undefined,
		},
		baseline: { at, times },
	};
}

function quote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Hand off the PID before exec, without changing the user's command or using its output pipes. */
export function monitoredOperations(track: (file: string) => () => void): BashOperations {
	const local = createLocalBashOperations();
	return {
		async exec(command, cwd, options) {
			let dir: string | undefined;
			let stop: (() => void) | undefined;
			try {
				let launcher: string;
				let pidFile: string;
				try {
					const { shell, args, commandTransport } = getShellConfig();
					if (commandTransport === "stdin" || args.join(" ") !== "-c")
						throw new Error("Unsupported shell transport");
					dir = await mkdtemp(join(tmpdir(), "pi-chrome-bash-"));
					launcher = join(dir, "launch");
					pidFile = join(dir, "pid");
					await writeFile(
						launcher,
						`#!/bin/sh\nprintf '%s\\n' "$$" 2>/dev/null > ${quote(pidFile)} || :\nexec ${quote(shell)} "$@"\n`,
						{ mode: 0o700 },
					);
					await access(launcher, constants.X_OK);
				} catch {
					return await local.exec(command, cwd, options);
				}
				stop = track(pidFile);
				return await createLocalBashOperations({ shellPath: launcher }).exec(command, cwd, options);
			} finally {
				stop?.();
				if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
}

type Running = {
	file: string;
	pid?: number;
	baseline?: ReturnType<typeof measure>["baseline"];
	latest?: UsageSample;
	networkBaseline?: NetworkSnapshot;
};

export function installBashUsage(pi: ExtensionAPI): (id: string) => UsageSample | undefined {
	const running = new Map<string, Running>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let sampling = false;
	const psFields = "pid=,ppid=,pgid=,time=,rss=";

	function pause() {
		clearInterval(timer);
		timer = undefined;
	}
	async function sample() {
		if (sampling) return;
		sampling = true;
		try {
			const ready = await Promise.all(
				[...running].map(async ([id, call]) => {
					if (!call.pid) {
						const pid = Number(await readFile(call.file, "utf8").catch(() => ""));
						if (Number.isSafeInteger(pid) && pid > 1) call.pid = pid;
					}
					return [id, call] as const;
				}),
			);
			const groups = ready.flatMap(([id, call]) =>
				call.pid && running.get(id) === call ? [call.pid] : [],
			);
			if (!groups.length) return;
			// Darwin can query just the detached groups. Linux ps has no equivalent PGID selector.
			const psArgs =
				process.platform === "darwin"
					? ["-g", groups.join(","), "-o", psFields]
					: ["-axo", psFields];
			const { stdout } = await exec("/bin/ps", psArgs, {
				timeout: INTERVAL_MS,
				env: { LC_ALL: "C" },
			});
			const at = performance.now();
			const rows = parseProcesses(stdout);
			const trees = ready.flatMap(([id, call]) => {
				if (!call.pid || running.get(id) !== call) return [];
				const tree = processTree(rows, call.pid);
				return tree.length ? [{ id, call, tree }] : [];
			});
			const pids = new Set(trees.flatMap(({ tree }) => tree.map(({ pid }) => pid)));
			const network = await readNetwork([...pids], INTERVAL_MS);
			for (const { id, call, tree } of trees) {
				if (running.get(id) !== call) continue;
				const next = measure(tree, call.baseline, at);
				call.baseline = next.baseline;
				call.latest = {
					...next.sample,
					network: networkRate(next.baseline.times.keys(), call.networkBaseline, network),
				};
				call.networkBaseline = network;
			}
		} catch {
			// Telemetry is best-effort; failures must not change the command result.
		} finally {
			sampling = false;
		}
	}

	let disposed = false;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !["darwin", "linux"].includes(process.platform)) return;
		if (
			!pi.getAllTools().some((tool) => tool.name === "bash" && tool.sourceInfo.source === "builtin")
		)
			return;
		const { shellPath, shellCommandPrefix: commandPrefix } = pi.getSettings();
		// Leave custom shell launchers (including remote/sandbox wrappers) alone.
		if (shellPath) return;
		const builtin = createBashToolDefinition(ctx.cwd, { commandPrefix });
		pi.registerTool({
			...builtin,
			defaultActive: false, // Preserve Pi's existing active tool selection.
			execute(id, params, signal, onUpdate, toolCtx) {
				const operations = monitoredOperations((file) => {
					if (disposed) return () => {};
					const call: Running = { file };
					running.set(id, call);
					timer ??= setInterval(() => void sample(), INTERVAL_MS).unref();
					return () => {
						if (running.get(id) === call) running.delete(id);
						if (!running.size) pause();
					};
				});
				const tool = createBashToolDefinition(toolCtx.cwd, { commandPrefix, operations });
				return tool.execute(id, params, signal, onUpdate, toolCtx);
			},
		});
	});
	pi.on("session_shutdown", () => {
		disposed = true;
		pause();
		running.clear();
	});
	return (id) => running.get(id)?.latest;
}

type Color = "accent" | "success" | "muted";
type UsageLabel = { label: string; color: Color };

function formatRate(bytes?: number): string {
	if (bytes === undefined) return "—";
	if (bytes < 1024) return `${Math.round(bytes)} B/s`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB/s`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MiB/s`;
}

export function usageLabels(latest?: UsageSample): UsageLabel[] {
	if (!latest) return [];
	const cpu = latest.cpu === undefined ? "—" : `${Math.round(latest.cpu)}%`;
	const mib = latest.rssKiB / 1024;
	const ram = mib < 1024 ? `${Math.round(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`;
	return [
		{ label: `CPU ${cpu}`, color: "accent" },
		{ label: `RAM ${ram}`, color: "success" },
		{ label: `↓ ${formatRate(latest.network?.down)}`, color: "muted" },
		{ label: `↑ ${formatRate(latest.network?.up)}`, color: "muted" },
	];
}
