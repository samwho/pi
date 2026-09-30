import { execFile as execFileCallback, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { scrollingFixture } from "./fixture.mjs";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: {
		session: { type: "string" },
		"agent-dir": { type: "string" },
		out: { type: "string" },
		hz: { type: "string", default: "120" },
		events: { type: "string", default: "600" },
		turns: { type: "string", default: "120" },
		width: { type: "string", default: "160" },
		height: { type: "string", default: "50" },
		"render-budget": { type: "string" },
		"latency-budget": { type: "string", default: "50" },
		profile: { type: "boolean" },
		bare: { type: "boolean" },
		expanded: { type: "boolean" },
		pages: { type: "boolean" },
		"no-check": { type: "boolean" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(
		"Usage: npm run test:scroll -- [--session path] [--profile] [--out dir] [--expanded] [--pages] [--hz 120|0] [--events 600] [--turns 250] [--bare] [--no-check]\nSee visuals/perf/README.md for budgets and limitations.",
	);
	process.exit(0);
}
const hz = Number(values.hz);
const count = Number(values.events);
const turns = Number(values.turns);
const width = Number(values.width);
const height = Number(values.height);
const renderBudget = Number(values["render-budget"] ?? (values.expanded ? "16" : "8"));
const latencyBudget = Number(values["latency-budget"]);
if (
	![hz, count, turns, width, height, renderBudget, latencyBudget].every(Number.isFinite) ||
	hz < 0 ||
	count < 120 ||
	turns < 1 ||
	width < 40 ||
	height < 20 ||
	renderBudget <= 0 ||
	latencyBudget <= 0 ||
	![count, turns, width, height].every(Number.isInteger)
)
	throw new Error("Invalid numeric benchmark option (events must be >= 120)");

const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "pi-scroll-"));
await mkdir(out, { recursive: true });
for (const name of ["ready", "started", "done", "session.jsonl"])
	if (await stat(join(out, name)).catch(() => undefined))
		throw new Error(`Use a fresh output directory: ${out}`);
const cwd = resolve(here, "../../../..");
if (values.session) await copyFile(resolve(values.session), join(out, "session.jsonl"));
else await writeFile(join(out, "session.jsonl"), scrollingFixture(cwd, turns));
await writeFile(
	join(out, "tmux.conf"),
	"set -g default-shell /bin/bash\nset -g extended-keys on\nset -g extended-keys-format csi-u\n",
);
let tmux = "tmux";
try {
	await execFile(tmux, ["-V"]);
} catch {
	const { stdout } = await execFile("mise", ["where", "aqua:tmux/tmux-builds"]);
	const root = stdout.trim();
	tmux = await stat(join(root, "tmux"))
		.then(() => join(root, "tmux"))
		.catch(() => join(root, "bin/tmux"));
}
const socket = `pi-scroll-perf-${process.pid}`;
const tm = async (...args) =>
	(await execFile(tmux, ["-L", socket, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout;
const wait = async (name) => {
	const deadline = performance.now() + 60000;
	while (!(await stat(join(out, name)).catch(() => undefined))) {
		if (performance.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
		await sleep(25);
	}
};
const command = async (text) => {
	await tm("send-keys", "-t", "scroll", "-l", text);
	await tm("send-keys", "-t", "scroll", "Enter");
};
const sent = [];
let control;
let controlError;
let piPid;
try {
	const piVersion = (await execFile("pi", ["--version"])).stdout.trim();
	const tmuxVersion = (await execFile(tmux, ["-V"])).stdout.trim();
	await tm(
		"-f",
		join(out, "tmux.conf"),
		"new-session",
		"-d",
		"-s",
		"scroll",
		"-c",
		cwd,
		"-x",
		String(width),
		"-y",
		String(height),
		"env",
		`PI_SCROLL_OUT=${out}`,
		`PI_SCROLL_PROFILE=${values.profile ? "1" : "0"}`,
		...(values["agent-dir"] ? [`PI_CODING_AGENT_DIR=${resolve(values["agent-dir"])}`] : []),
		"pi",
		"--offline",
		"--tui-mode",
		"fullscreen",
		"--session",
		join(out, "session.jsonl"),
		"--extension",
		join(here, "probe.ts"),
		...(values.bare ? ["--no-extensions"] : []),
	);
	piPid = Number((await tm("display-message", "-p", "-t", "scroll", "#{pane_pid}")).trim());
	await wait("ready");
	// Let deferred highlighting/formatting and plugin startup finish outside the measurement.
	await sleep(5000);
	if (values.expanded) {
		await tm("send-keys", "-t", "scroll", "C-o");
		await sleep(3000);
	}
	await command("/scroll-performance-probe start");
	await wait("started");
	// A persistent control client avoids spawning a process per scroll event.
	// ignore-size keeps the detached pane at our specified geometry.
	control = spawn(tmux, [
		"-L",
		socket,
		"-C",
		"attach-session",
		"-f",
		"ignore-size",
		"-t",
		"scroll",
	]);
	control.stderr.on("data", (data) => {
		controlError = String(data);
	});
	control.on("error", (error) => {
		controlError = String(error);
	});
	await new Promise((resolveReady, reject) => {
		let buffer = "";
		control.stdout.on("data", (data) => {
			buffer += data;
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("%error")) {
					controlError = line;
					reject(new Error(line));
				}
				if (line.startsWith("%end")) resolveReady();
			}
		});
		control.once("error", reject);
		control.once("exit", (code) => reject(new Error(`tmux control client exited: ${code}`)));
	});
	const started = performance.now();
	for (let i = 0; i < count; i++) {
		// Page tests alternate direction every 30 events, staying away from the ends.
		const sequence = values.pages
			? Math.floor(i / 30) % 2
				? "\x1b[6~"
				: "\x1b[5~"
			: `\x1b[<64;${Math.min(width - 5, 80)};${Math.min(height - 5, 20)}M`;
		sent.push(Date.now());
		const hex = [...Buffer.from(sequence)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(" ");
		control.stdin.write(`send-keys -H -t scroll ${hex}\n`);
		if (hz > 0) await sleep(Math.max(0, started + ((i + 1) * 1000) / hz - performance.now()));
		else if (i % 4 === 0) await sleep(0); // Saturate without blocking the control pipe.
	}
	await sleep(1000); // Drain queued input. Missed input or frames fail below.
	if (controlError) throw new Error(controlError);
	await command("/scroll-performance-probe stop");
	await wait("done");
	await writeFile(join(out, "screen.txt"), await tm("capture-pane", "-p", "-t", "scroll"));
	const metrics = JSON.parse(await readFile(join(out, "metrics.json"), "utf8"));
	const frames = metrics.frames.filter((frame) => frame.inputCount > 0);
	const latencies = [];
	let acknowledged = 0;
	let previousTop = metrics.initialTop;
	const changedFrames = [];
	for (const frame of frames) {
		for (; acknowledged < frame.inputCount; acknowledged++)
			latencies.push(frame.end - sent[acknowledged]);
		if (frame.top !== previousTop) changedFrames.push(frame);
		previousTop = frame.top;
	}
	const percentile = (numbers, p) =>
		numbers.length
			? [...numbers].sort((a, b) => a - b)[
					Math.min(numbers.length - 1, Math.floor(numbers.length * p))
				]
			: Infinity;
	const round = (value) => Number(value.toFixed(2));
	const inputDuration = (metrics.inputs.at(-1) - metrics.inputs[0]) / 1000;
	const fps = changedFrames.length / inputDuration;
	const result = {
		pi: piVersion,
		node: process.version,
		tmux: tmuxVersion,
		width,
		height,
		session: values.session ? resolve(values.session) : `synthetic: ${turns} turns`,
		profile: !!values.profile,
		expanded: !!values.expanded,
		pages: !!values.pages,
		bare: !!values.bare,
		sent: count,
		received: metrics.inputs.length,
		acknowledged,
		changedFrames: changedFrames.length,
		inputHz: round(count / inputDuration),
		changedFps: round(fps),
		renderP50Ms: round(
			percentile(
				frames.map((f) => f.ms),
				0.5,
			),
		),
		renderP95Ms: round(
			percentile(
				frames.map((f) => f.ms),
				0.95,
			),
		),
		renderMaxMs: round(
			percentile(
				frames.map((f) => f.ms),
				1,
			),
		),
		inputToFrameP95Ms: round(percentile(latencies, 0.95)),
		renderBudgetMs: renderBudget,
		latencyBudgetMs: latencyBudget,
		initialTop: metrics.initialTop,
		finalTop: previousTop,
	};
	const failures = [];
	if (result.received !== count || acknowledged !== count)
		failures.push("scroll input was lost or not rendered");
	if (changedFrames.length < (hz === 0 ? 3 : 10))
		failures.push("viewport did not scroll enough to be a valid measurement");
	if (result.renderP95Ms > renderBudget) failures.push(`p95 render exceeded ${renderBudget}ms`);
	if (result.renderMaxMs > 50) failures.push("a render stalled for more than 50ms");
	if (result.inputToFrameP95Ms > latencyBudget)
		failures.push(`p95 input-to-frame exceeded ${latencyBudget}ms`);
	if (hz > 0 && result.inputHz < hz * 0.8)
		failures.push("input driver could not sustain the requested rate; measurement invalid");
	if (hz >= 60 && fps < 50) failures.push("scrolling fell below 50 changed frames/s");
	await writeFile(join(out, "sent.json"), JSON.stringify(sent));
	await writeFile(
		join(out, "summary.json"),
		JSON.stringify({ ...result, failures }, null, 2) + "\n",
	);
	console.log(JSON.stringify(result, null, 2));
	console.log(`Artifacts: ${out}`);
	if (failures.length) {
		console.error(failures.join("\n"));
		if (!values["no-check"]) process.exitCode = 1;
	}
} catch (error) {
	console.error(
		await tm("capture-pane", "-p", "-t", "scroll").catch(() => "Pi exited before capture"),
	);
	console.error(`Artifacts: ${out}`);
	throw error;
} finally {
	// Only our isolated server, never the user's tmux sessions.
	control?.kill();
	await tm("kill-server").catch(() => {});
	// A microtask/redraw loop can starve SIGHUP handling even after tmux exits.
	// Never leave the disposable benchmark burning CPU after a failed run.
	if (Number.isInteger(piPid) && piPid > 0) {
		try {
			process.kill(piPid, "SIGTERM");
			await sleep(250);
			process.kill(piPid, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") {
				console.error(`Could not clean up benchmark PID ${piPid}:`, error);
				process.exitCode = 1;
			}
		}
	}
}
