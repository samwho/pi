// Adapted from specode/pi-subscription-usage and @narumitw/pi-usage (MIT).
export type UsageWindow = { kind: "hourly" | "weekly"; usedPercent: number; resetsAt?: number };
export type UsageStatus =
	| { v: 1; status: "ready"; windows: UsageWindow[]; availableResets?: number }
	| { v: 1; status: "unavailable" };

export function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function tokenClaims(authorization: string): Record<string, unknown> | undefined {
	try {
		const token = /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1];
		const parts = token?.split(".");
		return parts?.length === 3
			? object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")))
			: undefined;
	} catch {
		return undefined;
	}
}

export function openaiClientId(authorization: string): string {
	const claims = tokenClaims(authorization);
	if (
		claims?.iss !== "https://auth.openai.com" ||
		claims.aud !== "https://api.openai.com/v1" ||
		typeof claims.scope !== "string" ||
		!claims.scope.split(/\s+/u).includes("chatgpt.tokens.use.direct") ||
		typeof claims.client_id !== "string" ||
		!/^oaiapp_[a-zA-Z0-9_-]+$/u.test(claims.client_id)
	)
		throw new Error("OpenAI application identity unavailable.");
	return claims.client_id;
}

export function accountId(authorization: string): string | undefined {
	const id = object(
		tokenClaims(authorization)?.["https://api.openai.com/auth"],
	)?.chatgpt_account_id;
	return typeof id === "string" && id.length > 0 && id.length <= 512 && !/[^\x20-\x7e]/u.test(id)
		? id
		: undefined;
}

export function planWindows(payload: Record<string, unknown>): UsageWindow[] {
	const limits = object(payload.rate_limit);
	const windows: UsageWindow[] = [];
	for (const raw of [limits?.primary_window, limits?.secondary_window]) {
		if (raw == null) continue;
		const window = object(raw);
		const used = Number(window?.used_percent);
		const seconds = Number(window?.limit_window_seconds);
		const reset = Number(window?.reset_at);
		if (
			window?.used_percent == null ||
			!Number.isFinite(used) ||
			!Number.isFinite(seconds) ||
			seconds <= 0
		) {
			throw new Error("Invalid OpenAI usage window.");
		}
		windows.push({
			kind: seconds === 604800 ? "weekly" : "hourly",
			usedPercent: Math.min(100, Math.max(0, used)),
			...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset } : {}),
		});
	}
	if (windows.length === 0) throw new Error("No OpenAI usage windows.");
	return windows;
}

/** Count only explicit, available, supported, unexpired reset tickets. */
export function resetCount(payload: Record<string, unknown>, now = Date.now()): number | undefined {
	const count = Number(payload.available_count);
	if (
		payload.available_count == null ||
		!Number.isSafeInteger(count) ||
		count < 0 ||
		!Array.isArray(payload.credits)
	)
		return undefined;
	let available = 0;
	for (const raw of payload.credits) {
		const credit = object(raw);
		if (
			credit?.status !== "available" ||
			credit.reset_type !== "codex_rate_limits" ||
			credit.is_supported_by_plan !== true
		)
			continue;
		if (typeof credit.id !== "string" || !credit.id || credit.id.length > 1024) return undefined;
		if (credit.expires_at != null) {
			if (typeof credit.expires_at !== "string") return undefined;
			const expires = Date.parse(credit.expires_at);
			if (!Number.isFinite(expires)) return undefined;
			if (expires <= now) continue;
		}
		available++;
	}
	return Math.min(count, available);
}
