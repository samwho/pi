import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type NetworkRate = { down: number; up: number };
export type NetworkSnapshot = { at: number; counters: Map<number, NetworkRate> };

/** nettop's process-summary CSV labels each row with `name.pid`. */
export function parseNetwork(output: string): NetworkSnapshot["counters"] | undefined {
	const [header, ...rows] = output.trim().split(/\r?\n/);
	const columns = header.split(",");
	const rx = columns.indexOf("bytes_in");
	const tx = columns.indexOf("bytes_out");
	if (rx < 0 || tx < 0) return undefined;
	const counters: NetworkSnapshot["counters"] = new Map();
	for (const row of rows) {
		const fields = row.split(",");
		const pid = fields[0].match(/\.(\d+)"?$/)?.[1];
		const down = fields[rx];
		const up = fields[tx];
		if (pid && /^\d+$/.test(down) && /^\d+$/.test(up))
			counters.set(Number(pid), { down: Number(down), up: Number(up) });
	}
	return counters;
}

export async function readNetwork(
	pids: readonly number[],
	timeout: number,
): Promise<NetworkSnapshot | undefined> {
	if (process.platform !== "darwin" || !pids.length) return undefined;
	try {
		const filters = pids.flatMap((pid) => ["-p", String(pid)]);
		const { stdout } = await exec(
			"/usr/bin/nettop",
			["-n", "-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out", ...filters],
			{ timeout, env: { LC_ALL: "C" } },
		);
		const counters = parseNetwork(stdout);
		return counters && { at: performance.now(), counters };
	} catch {
		return undefined;
	}
}

export function networkRate(
	pids: Iterable<number>,
	previous?: NetworkSnapshot,
	current?: NetworkSnapshot,
): NetworkRate | undefined {
	if (!previous || !current || current.at <= previous.at) return undefined;
	let down = 0;
	let up = 0;
	for (const pid of pids) {
		const now = current.counters.get(pid);
		if (!now) continue;
		const before = previous.counters.get(pid);
		// New sockets can first appear on a PID that was idle at the previous poll.
		// Ignore counter decreases when older sockets disappear from the summary.
		down += Math.max(0, now.down - (before?.down ?? 0));
		up += Math.max(0, now.up - (before?.up ?? 0));
	}
	const seconds = (current.at - previous.at) / 1_000;
	return { down: down / seconds, up: up / seconds };
}
