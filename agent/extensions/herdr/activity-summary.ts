import net from "node:net";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "pi.activity-summary";
const TOKEN = "summary";
const MAX_LENGTH = 64;
const REASONING_PAUSE_MS = 600;
const WAITING = "waiting for you";
const WORKING = "working...";
const WRITING = "writing...";

const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
	process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
// Pi injects PI_SESSION_ID into bash-tool children. A nested Pi inherits Herdr's
// pane ID, but must not own that pane's metadata or clear the parent summary
// when the nested process exits.
const isNestedPi = Boolean(process.env.PI_SESSION_ID);
const enabled =
	process.env.HERDR_ENV === "1" && Boolean(socketEndpoint && paneId) && !isNestedPi;

let reportSequence = Date.now() * 1000;

function nextSequence(): number {
	reportSequence += 1;
	return reportSequence;
}

function normalize(value: string): string {
	return value
		.replace(/```[\s\S]*?```/g, " code ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.replace(/^[#>*_\-\s]+/, "")
		.trim();
}

function truncate(value: string): string {
	const text = normalize(value);
	if (text.length <= MAX_LENGTH) return text;

	const cut = text.slice(0, MAX_LENGTH - 1);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace >= 32 ? lastSpace : cut.length).trimEnd()}…`;
}

/** Return the first sentence of a reasoning line, if it is complete. */
function firstSentence(value: string): string {
	const text = value.trimStart();
	if (!text) return "";

	const sentence = text.search(/[.!?](?=\s|$)/);
	return sentence >= 0 ? truncate(text.slice(0, sentence + 1)) : "";
}

function basename(value: unknown): string {
	return typeof value === "string" && value ? path.basename(value) : "";
}

function toolSummary(toolName: string, args: unknown): string | null {
	const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

	if (toolName === "edit") {
		return truncate(`Edit ${basename(input.path) || "file"}`);
	}

	if (toolName === "write") {
		return truncate(`Creating ${basename(input.path) || "file"}`);
	}

	return null;
}

function sendAttempt(value: string | null, sequence: number, timeoutMs: number): Promise<boolean> {
	if (!enabled) return Promise.resolve(true);

	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const socket = net.createConnection(socketEndpoint!);

		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			socket.destroy();
			resolve(delivered);
		};

		socket.on("error", () => finish(false));
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					id: `${SOURCE}:${sequence}`,
					method: "pane.report_metadata",
					params: {
						pane_id: paneId,
						source: SOURCE,
						tokens: { [TOKEN]: value },
						seq: sequence,
					},
				})}\n`,
			);
		});
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
}

async function report(value: string | null): Promise<void> {
	const sequence = nextSequence();
	if (await sendAttempt(value, sequence, 500)) return;
	await sendAttempt(value, sequence, 1500);
}

export default function (pi: ExtensionAPI) {
	if (!enabled) return;

	let currentLine = "";
	let currentLinePublished = false;
	let sawReasoningDelta = false;
	let pauseTimer: ReturnType<typeof setTimeout> | undefined;
	let lastPublished: string | null = null;

	async function publish(value: string | null) {
		if (value === lastPublished) return;
		lastPublished = value;
		await report(value);
	}

	function cancelPauseTimer() {
		if (!pauseTimer) return;
		clearTimeout(pauseTimer);
		pauseTimer = undefined;
	}

	function resetReasoning() {
		cancelPauseTimer();
		currentLine = "";
		currentLinePublished = false;
		sawReasoningDelta = false;
	}

	function publishCurrentLine(ended: boolean) {
		if (currentLinePublished) return;
		const summary = firstSentence(currentLine) || (ended ? truncate(currentLine) : "");
		if (!summary) return;
		currentLinePublished = true;
		void publish(summary);
	}

	function scheduleCurrentLine() {
		cancelPauseTimer();
		if (currentLinePublished || !currentLine.trim()) return;
		pauseTimer = setTimeout(() => {
			pauseTimer = undefined;
			publishCurrentLine(true);
		}, REASONING_PAUSE_MS);
		pauseTimer.unref?.();
	}

	function consumeReasoning(delta: string) {
		const pieces = delta.split(/\r?\n/);
		for (let index = 0; index < pieces.length; index += 1) {
			currentLine += pieces[index];
			publishCurrentLine(false);

			if (index < pieces.length - 1) {
				publishCurrentLine(true);
				currentLine = "";
				currentLinePublished = false;
			}
		}
		scheduleCurrentLine();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await publish(ctx.isIdle() ? WAITING : WORKING);
	});

	pi.on("agent_start", async () => {
		resetReasoning();
		await publish(WORKING);
	});

	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start") {
			resetReasoning();
			return;
		}

		if (update.type === "thinking_delta") {
			sawReasoningDelta = true;
			consumeReasoning(update.delta);
			return;
		}

		if (update.type === "thinking_end") {
			cancelPauseTimer();
			if (!sawReasoningDelta) consumeReasoning(update.content);
			publishCurrentLine(true);
			return;
		}

		if (update.type === "text_start" || update.type === "text_delta") {
			cancelPauseTimer();
			void publish(WRITING);
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const summary = toolSummary(event.toolName, event.args);
		if (!summary) return;
		cancelPauseTimer();
		await publish(summary);
	});

	pi.on("agent_settled", async () => {
		resetReasoning();
		await publish(WAITING);
	});

	pi.on("session_shutdown", async () => {
		cancelPauseTimer();
		await publish(null);
	});
}
