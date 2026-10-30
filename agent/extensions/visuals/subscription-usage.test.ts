import { expect, it } from "vitest";
import { resetCredits } from "../subscription-usage/src/data.ts";

const now = 1_900_000_000_000;
const ticket = (seconds?: number) => ({
	id: "reset-ticket",
	status: "available",
	reset_type: "codex_rate_limits",
	is_supported_by_plan: true,
	...(seconds === undefined ? {} : { expires_at: new Date(now + seconds * 1000).toISOString() }),
});

it("retains the soonest available reset expiry regardless of ticket order", () => {
	expect(
		resetCredits({ available_count: 3, credits: [ticket(900), ticket(60), ticket()] }, now),
	).toEqual({ availableResets: 3, nextResetExpiresAt: now / 1000 + 60 });
});

it("ignores expired, used, unsupported, and unrelated tickets", () => {
	const credits = [
		ticket(-1),
		ticket(0),
		{ ...ticket(1), status: "used" },
		{ ...ticket(2), is_supported_by_plan: false },
		{ ...ticket(3), reset_type: "other" },
		ticket(900),
	];
	expect(resetCredits({ available_count: 6, credits }, now)).toEqual({
		availableResets: 1,
		nextResetExpiresAt: now / 1000 + 900,
	});
});

it("omits expiry for zero resets or tickets without expiry", () => {
	expect(resetCredits({ available_count: 0, credits: [ticket(60)] }, now)).toEqual({
		availableResets: 0,
	});
	expect(resetCredits({ available_count: 1, credits: [ticket()] }, now)).toEqual({
		availableResets: 1,
	});
	expect(resetCredits({ available_count: 1, credits: [ticket(), ticket()] }, now)).toEqual({
		availableResets: 1,
	});
});

it("does not expose unverified reset data", () => {
	for (const payload of [
		{},
		{ available_count: -1, credits: [] },
		{ available_count: 1, credits: [{ ...ticket(), id: "" }] },
		{ available_count: 1, credits: [{ ...ticket(), expires_at: "invalid" }] },
	])
		expect(resetCredits(payload, now)).toBeUndefined();
});
