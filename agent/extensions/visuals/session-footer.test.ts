import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { countUntrackedLines, sessionStatsReader } from "./session-footer.ts";

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
