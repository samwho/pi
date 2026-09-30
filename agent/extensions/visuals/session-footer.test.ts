import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { countUntrackedLines } from "./session-footer.ts";

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
