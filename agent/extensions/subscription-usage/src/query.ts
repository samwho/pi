// Runtime-auth and origin checks adapted from @narumitw/pi-usage (MIT).
import { createHmac, randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	accountId,
	object,
	openaiClientId,
	planWindows,
	resetCount,
	type UsageStatus,
} from "./data.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const AUTH_SALT = randomBytes(32);

type Model = NonNullable<ExtensionContext["model"]>;
export type UsageAuth = { headers: Record<string, string>; clientId?: string; fingerprint: string };

export function supportsUsage(model: Model | undefined): boolean {
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

function officialOrigin(url: string | undefined, provider: string): boolean {
	try {
		return (
			new URL(url ?? "").origin ===
			(provider === "openai" ? "https://api.openai.com" : "https://chatgpt.com")
		);
	} catch {
		return false;
	}
}

async function authorization(ctx: ExtensionContext, model: Model): Promise<string | undefined> {
	if (!officialOrigin(model.baseUrl, model.provider) || !ctx.modelRegistry.isUsingOAuth(model))
		return undefined;
	const result = await ctx.modelRegistry.getProviderAuth(model.provider);
	if (!result || (result.auth.baseUrl && !officialOrigin(result.auth.baseUrl, model.provider)))
		return undefined;
	const header = Object.entries(result.auth.headers ?? {}).find(
		([key]) => key.toLowerCase() === "authorization",
	)?.[1];
	return header ?? (result.auth.apiKey ? `Bearer ${result.auth.apiKey}` : undefined);
}

export async function resolveAuth(ctx: ExtensionContext): Promise<UsageAuth | undefined> {
	const model = ctx.model;
	if (!model || !supportsUsage(model)) return undefined;
	const active = await authorization(ctx, model);
	if (!active) return undefined;
	let backend = active;
	let clientId: string | undefined;
	if (model.provider === "openai") {
		clientId = openaiClientId(active);
		const candidates = [...ctx.modelRegistry.getAvailable(), ...ctx.modelRegistry.getAll()];
		const companion = candidates.find(
			(candidate) =>
				candidate.provider === "openai-codex" &&
				officialOrigin(candidate.baseUrl, candidate.provider) &&
				ctx.modelRegistry.isUsingOAuth(candidate),
		);
		if (!companion) return undefined;
		const token = await authorization(ctx, companion);
		if (!token) return undefined;
		backend = token;
	}
	const id = accountId(backend);
	if (!id) return undefined;
	return {
		headers: { Authorization: backend, "chatgpt-account-id": id },
		clientId,
		fingerprint: createHmac("sha256", AUTH_SALT)
			.update(JSON.stringify([active, backend, id]))
			.digest("hex"),
	};
}

async function fetchJson(
	url: string,
	auth: UsageAuth,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		headers: { Accept: "application/json", ...auth.headers },
		redirect: "error",
		signal,
	});
	// Never put response bodies or credentials into errors or UI notices.
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Usage request failed (${response.status}).`);
	}
	if (!response.body) throw new Error("Empty usage response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 64 * 1024) {
				await reader.cancel();
				throw new Error("Usage response exceeded 64 KiB.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (!data) throw new Error("Invalid usage response.");
	return data;
}

export async function queryUsage(auth: UsageAuth, signal: AbortSignal): Promise<UsageStatus> {
	// An exact app match verifies that the companion belongs to this registration.
	if (auth.clientId) {
		const apps = await fetchJson(`${USAGE_URL}/chatpass/apps`, auth, signal);
		if (
			!Array.isArray(apps.items) ||
			apps.items.filter((item) => object(item)?.id === auth.clientId).length !== 1
		) {
			throw new Error("OpenAI and Codex accounts do not match.");
		}
	}
	const windows = planWindows(await fetchJson(USAGE_URL, auth, signal));
	let availableResets: number | undefined;
	try {
		availableResets = resetCount(await fetchJson(RESET_URL, auth, signal));
	} catch {
		// A failed reset lookup must not hide valid quota data.
	}
	return {
		v: 1,
		status: "ready",
		windows,
		...(availableResets === undefined ? {} : { availableResets }),
	};
}
