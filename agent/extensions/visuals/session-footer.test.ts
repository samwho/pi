import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseColor, styleText, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import sessionFooter, {
	countUntrackedLines,
	formatWeeklyUsage,
	sessionStatsReader,
} from "./session-footer.ts";

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

it("adds every untracked text line, not a count of files or directories", async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-footer-git-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	await writeFile(join(dir, ".gitignore"), "*.ignored\n");
	execFileSync("git", ["add", ".gitignore"], { cwd: dir });

	await writeFile(join(dir, "new.txt"), "alpha\nbeta\n"); // 2
	await writeFile(join(dir, "no-newline.txt"), "last line"); // 1
	await writeFile(join(dir, "empty.txt"), ""); // 0
	await writeFile(join(dir, "binary.dat"), Buffer.from([1, 0, 2])); // 0 (Git numstat)
	await writeFile(join(dir, "private.ignored"), "not counted\n");
	await writeFile(join(dir, "line\nbreak.txt"), "one\n"); // 1
	await writeFile(join(dir, "large.txt"), "x".repeat(64 * 1024 - 1) + "\ntail"); // 2
	await symlink("new.txt", join(dir, "link.txt")); // 1
	await mkdir(join(dir, "subdir"));
	await writeFile(join(dir, "subdir", "nested.txt"), "one\ntwo\n"); // 2

	const args = ["ls-files", "--others", "--exclude-standard", "-z", "--", ":/"];
	const untracked = execFileSync("git", args, { cwd: dir }).toString();
	expect(untracked).toContain("line\nbreak.txt\0");
	expect(untracked).not.toContain("private.ignored");
	expect(await countUntrackedLines(dir, untracked)).toBe(9);

	const subdir = join(dir, "subdir");
	const fromSubdir = execFileSync("git", args, { cwd: subdir }).toString();
	expect(fromSubdir).toContain("../new.txt\0");
	expect(await countUntrackedLines(subdir, fromSubdir)).toBe(9);
});

it("shows live subscription usage to the right of model pricing", () => {
	let start: any;
	let footer: any;
	let usageChanged: any;
	const statuses = new Map<string, string>();
	const style = vi.fn((text: string, options: Parameters<typeof styleText>[1]) => {
		// Concrete colors must be Color objects, not strings treated as theme tokens.
		expect(typeof options.fg).toBe("object");
		styleText(text, options);
		return text;
	});
	const pi = {
		events: {
			on: (_event: string, handler: unknown) => {
				usageChanged = handler;
			},
		},
		on: (event: string, handler: unknown) => {
			if (event === "session_start") start = handler;
		},
		exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp",
		model: { provider: "openai", id: "gpt-6.1-sol", cost: { input: 5, output: 20 } },
		sessionManager: { getLeafId: () => null, getEntries: () => [] },
		getContextUsage: () => undefined,
		ui: {
			setFooter: (factory: any) => {
				footer = factory(
					{ requestRender: vi.fn() },
					{ fg: (_color: string, text: string) => text, style },
					{ getExtensionStatuses: () => statuses, onBranchChange: () => () => {} },
				);
			},
		},
	};
	sessionFooter(pi);
	start({}, ctx);
	const original = footer.render(100);
	expect(original).toHaveLength(1);
	usageChanged({
		status: "ready",
		windows: [
			{ kind: "hourly", usedPercent: 99 },
			{ kind: "weekly", usedPercent: 15, resetsAt: Date.now() / 1000 + 3 * 86400 },
		],
	});
	expect(footer.render(100)).toHaveLength(1);
	expect(footer.render(100)[0]).toMatch(/sol off \$5\/\$20 15% 3d$/);
	expect(style).toHaveBeenCalledWith("15% 3d", { fg: parseColor("#60a5fa") });
	usageChanged({
		status: "ready",
		availableResets: 2,
		windows: [{ kind: "weekly", usedPercent: 15, resetsAt: Date.now() / 1000 + 3 * 86400 }],
	});
	expect(footer.render(100)[0]).toMatch(/15% 3d \[2\]$/);
	usageChanged({
		status: "ready",
		availableResets: 2,
		nextResetExpiresAt: Date.now() / 1000 + 5 * 86400,
		windows: [{ kind: "weekly", usedPercent: 15 }],
	});
	expect(footer.render(100)[0]).toMatch(/15% \[2 5d\]$/);
	usageChanged({ status: "ready", windows: [{ kind: "weekly", usedPercent: 20 }] });
	expect(footer.render(100)[0]).toMatch(/\$5\/\$20 20%$/);
	for (const line of footer.render(8)) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
	usageChanged({ status: "unavailable" });
	expect(footer.render(100)).toEqual(original);
	footer.dispose();
});

it("formats used percentage and a single rounded-up reset unit", () => {
	const now = 1_900_000_000_000;
	const format = (seconds: number) =>
		formatWeeklyUsage(
			{
				kind: "weekly",
				usedPercent: 23.4,
				resetsAt: now / 1000 + seconds,
			},
			now,
		);
	expect(format(3 * 86400 + 1)).toBe("23% 4d");
	expect(format(86401)).toBe("23% 2d");
	expect(format(86400)).toBe("23% 24h");
	expect(format(3601)).toBe("23% 2h");
	expect(format(3600)).toBe("23% 1h");
	expect(format(3599)).toBe("23% 60m");
	expect(format(61)).toBe("23% 2m");
	expect(format(1)).toBe("23% 1m");
	expect(format(0)).toBe("23%");
	expect(format(-1)).toBe("23%");
	expect(formatWeeklyUsage(undefined, now)).toBeUndefined();
});

it("only shows positive, verified reset counts", () => {
	const now = 1_900_000_000_000;
	const window = { kind: "weekly", usedPercent: 23, resetsAt: now / 1000 + 2 * 86400 };
	expect(formatWeeklyUsage(window, now, 2)).toBe("23% 2d [2]");
	for (const count of [undefined, 0, -1, 1.5, NaN, Infinity]) {
		expect(formatWeeklyUsage(window, now, count)).toBe("23% 2d");
	}
	expect(formatWeeklyUsage({ ...window, resetsAt: undefined }, now, 1)).toBe("23% [1]");
});

it("shows the soonest ticket expiry inside the reset-count brackets", () => {
	const now = 1_900_000_000_000;
	const window = { kind: "weekly", usedPercent: 23, resetsAt: now / 1000 + 2 * 86400 };
	for (const [seconds, label] of [
		[5 * 86400, "5d"],
		[3601, "2h"],
		[61, "2m"],
	] as const) {
		expect(formatWeeklyUsage(window, now, 2, now / 1000 + seconds)).toBe(`23% 2d [2 ${label}]`);
	}
	for (const expiry of [undefined, NaN, Infinity, now / 1000, now / 1000 - 1]) {
		expect(formatWeeklyUsage(window, now, 2, expiry)).toBe("23% 2d [2]");
	}
	expect(formatWeeklyUsage(window, now, 0, now / 1000 + 60)).toBe("23% 2d");
});

it("ignores files removed after Git lists them", async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-footer-git-"));
	expect(await countUntrackedLines(dir, "gone.txt\0")).toBe(0);
});

it("does not rebuild session projections or scan costs while scrolling", () => {
	let leaf = "first";
	const entries: any[] = [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } },
		{ type: "message", message: { role: "toolResult", usage: { cost: { total: 2 } } } },
		{ type: "compaction", usage: { cost: { total: 3 } } },
		{ type: "branch_summary", usage: { cost: { total: 4 } } },
	];
	const getEntries = vi.fn(() => entries);
	const getContextUsage = vi.fn(() => ({ tokens: 100, contextWindow: 1000, percent: 10 }));
	const ctx = {
		model: { id: "fixture" },
		sessionManager: { getLeafId: () => leaf, getEntries },
		getContextUsage,
	} as unknown as ExtensionContext;
	const stats = sessionStatsReader(ctx);
	for (let i = 0; i < 1000; i++) expect(stats.read().cost).toBe(10);
	expect(getEntries).toHaveBeenCalledTimes(1);
	expect(getContextUsage).toHaveBeenCalledTimes(1);

	// Appends, compaction, and branch navigation all change the leaf.
	entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 5 } } } });
	leaf = "second";
	expect(stats.read().cost).toBe(15);
	leaf = "first";
	expect(stats.read().cost).toBe(15); // Cost includes abandoned branches, as before.
	expect(getContextUsage).toHaveBeenCalledTimes(3);
	ctx.model = { id: "other" } as ExtensionContext["model"];
	stats.read();
	expect(getContextUsage).toHaveBeenCalledTimes(4);
	stats.invalidate();
	stats.read();
	expect(getContextUsage).toHaveBeenCalledTimes(5);
});
