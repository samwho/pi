import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageStatus } from "./src/data.ts";
import { queryUsage, resolveAuth, supportsUsage } from "./src/query.ts";

const EVENT = "subscription-usage/status/v1";
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 15_000;

export default function subscriptionUsage(pi: ExtensionAPI): void {
	let active = false;
	let controller: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cached:
		| { fingerprint: string; model: string; capturedAt: number; status: UsageStatus }
		| undefined;
	const emit = (status: UsageStatus) => pi.events.emit(EVENT, status);
	const unavailable = () => emit({ v: 1, status: "unavailable" });

	function cancel(): void {
		controller?.abort();
		controller = undefined;
		clearTimeout(timer);
		timer = undefined;
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		cancel();
		if (!active || !supportsUsage(ctx.model)) {
			cached = undefined;
			unavailable();
			return;
		}
		const key = `${ctx.model?.provider}/${ctx.model?.id}`;
		const operation = new AbortController();
		controller = operation;
		const deadline = setTimeout(() => operation.abort(), TIMEOUT_MS);
		let retryMs = REFRESH_MS;
		const current = () =>
			active && controller === operation && `${ctx.model?.provider}/${ctx.model?.id}` === key;
		// Bound credential resolution too: the registry itself has no abort signal.
		let abortListener: () => void;
		const aborted = new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(new Error("Usage refresh aborted."));
			operation.signal.addEventListener("abort", abortListener, { once: true });
		});
		try {
			const auth = await Promise.race([resolveAuth(ctx), aborted]);
			if (!current() || operation.signal.aborted) return;
			if (!auth) {
				cached = undefined;
				unavailable();
				return;
			}
			if (
				cached?.fingerprint === auth.fingerprint &&
				cached.model === key &&
				Date.now() - cached.capturedAt < REFRESH_MS
			) {
				retryMs = REFRESH_MS - (Date.now() - cached.capturedAt);
				emit(cached.status);
				return;
			}
			cached = undefined;
			unavailable();
			const status = await Promise.race([queryUsage(auth, operation.signal), aborted]);
			const checked = await Promise.race([resolveAuth(ctx), aborted]);
			if (!current() || operation.signal.aborted) return;
			if (checked?.fingerprint !== auth.fingerprint) {
				retryMs = RETRY_MS;
				return;
			}
			cached = { fingerprint: auth.fingerprint, model: key, capturedAt: Date.now(), status };
			emit(status);
		} catch {
			if (!current()) return;
			cached = undefined;
			retryMs = RETRY_MS;
			unavailable();
		} finally {
			clearTimeout(deadline);
			operation.signal.removeEventListener("abort", abortListener!);
			if (current()) {
				controller = undefined;
				timer = setTimeout(() => start(ctx), Math.max(1, retryMs));
			}
		}
	}

	function start(ctx: ExtensionContext): void {
		void refresh(ctx).catch(() => {});
	}

	pi.on("session_start", (_event, ctx) => {
		active = ctx.hasUI;
		if (active) start(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		cancel();
		cached = undefined;
		unavailable();
		if (active) start(ctx);
	});
	for (const event of ["session_tree", "agent_settled"] as const) {
		pi.on(event, (_event, ctx) => {
			if (active) start(ctx);
		});
	}
	pi.on("session_shutdown", () => {
		active = false;
		cancel();
		cached = undefined;
		unavailable();
	});
}
