import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

type ProbeTui = TUI & {
	doRender(): void;
	handleTerminalInput(data: string): void;
	viewportTop: number;
};
type Frame = { start: number; end: number; ms: number; top: number; inputCount: number };
const scrollInput = /\x1b\[(?:[56]~|<6[45];\d+;\d+M)/g;

// Explicitly loaded by run.mjs, never part of normal extension discovery.
export default function (pi: ExtensionAPI) {
	const out = process.env.PI_SCROLL_OUT;
	if (!out) throw new Error("PI_SCROLL_OUT is required");
	const profiler = new Session();
	let tui: ProbeTui | undefined;
	let restore: (() => void) | undefined;
	let active = false;
	let label = "";
	let frames: Frame[] = [];
	let inputs: number[] = [];
	let initialTop = 0;
	const profiling = process.env.PI_SCROLL_PROFILE === "1";

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("scroll-performance-probe", (ui) => {
			tui = ui as ProbeTui;
			if (typeof tui.doRender !== "function" || typeof tui.handleTerminalInput !== "function")
				throw new Error("Pi's render/input internals changed; update the scrolling probe");
			// These internal methods are only patched in the disposable benchmark process.
			// oxlint-disable-next-line typescript/unbound-method
			const render = tui.doRender;
			// oxlint-disable-next-line typescript/unbound-method
			const input = tui.handleTerminalInput;
			tui.doRender = function () {
				if (!active) return render.call(this);
				const start = performance.now();
				render.call(this);
				const end = performance.now();
				frames.push({
					start: performance.timeOrigin + start,
					end: performance.timeOrigin + end,
					ms: end - start,
					top: this.viewportTop,
					inputCount: inputs.length,
				});
			};
			tui.handleTerminalInput = function (data) {
				if (active) {
					for (const _match of data.matchAll(scrollInput))
						inputs.push(performance.timeOrigin + performance.now());
				}
				input.call(this, data);
			};
			restore = () => {
				(ui as ProbeTui).doRender = render;
				(ui as ProbeTui).handleTerminalInput = input;
			};
			return { render: () => [], invalidate() {} };
		});
		writeFileSync(join(out, "ready"), String(process.pid));
	});

	pi.registerCommand("scroll-performance-probe", {
		description: "Control the disposable scrolling benchmark",
		handler: async (args) => {
			if (!tui) throw new Error("No fullscreen TUI captured");
			if (args === "start") {
				if (active) throw new Error("Already measuring");
				label = "scroll";
				if (profiling) {
					profiler.connect();
					await profiler.post("Profiler.enable");
					await profiler.post("Profiler.setSamplingInterval", { interval: 1000 });
					await profiler.post("Profiler.start");
				}
				frames = [];
				inputs = [];
				initialTop = tui.viewportTop;
				active = true;
				writeFileSync(join(out, "started"), "");
			} else if (args === "stop") {
				if (!active) throw new Error("Not measuring");
				active = false;
				if (profiling) {
					const { profile } = await profiler.post("Profiler.stop");
					writeFileSync(join(out, `${label}.cpuprofile`), JSON.stringify(profile));
					profiler.disconnect();
				}
				writeFileSync(join(out, "metrics.json"), JSON.stringify({ frames, inputs, initialTop }));
				writeFileSync(join(out, "done"), "");
			}
		},
	});
	pi.on("session_shutdown", () => {
		active = false;
		restore?.();
		profiler.disconnect();
	});
}
