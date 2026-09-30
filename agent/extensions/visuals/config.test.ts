import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultConfig,
	loadConfig,
	loadOrInitConfig,
	saveConfig,
	VALID_DIFF_LAYOUTS,
} from "./config.ts";

let dir: string;
let configFile: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "visuals-config-"));
	configFile = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("visuals config", () => {
	it("uses 40 lines by default and 10 for read and grep", () => {
		expect(defaultConfig().previewLines).toEqual({ default: 40, read: 10, grep: 10 });
		expect(loadConfig(configFile)).toEqual(defaultConfig());
	});

	it("round trips every setting, including arbitrary per-tool overrides", () => {
		for (const diffLayout of VALID_DIFF_LAYOUTS) {
			const cfg = defaultConfig();
			cfg.diffLayout = diffLayout;
			cfg.showWorkingTime = false;
			cfg.previewLines.bash = 22;
			cfg.highlight.cacheLimit = 64;
			cfg.diff.colors.bgAdd = "#aabbcc";
			cfg.icons = "none";
			cfg.imageProtocol = "kitty";
			cfg.quoteUrl = "https://example.com/quote";
			saveConfig(cfg, configFile);
			expect(loadConfig(configFile)).toEqual(cfg);
			expect(readFileSync(configFile, "utf8").endsWith("\n")).toBe(true);
		}
	});

	it("fills in old files and ignores invalid settings instead of dropping valid overrides", () => {
		writeFileSync(
			configFile,
			JSON.stringify({
				diffLayout: "unified",
				showWorkingTime: false,
				previewLines: { default: 25, grep: 0, bash: 12, find: "ten" },
				highlight: { maxChars: -1 },
				diff: { colors: { bgAdd: "nope" } },
			}),
		);
		expect(loadConfig(configFile)).toEqual({
			...defaultConfig(),
			diffLayout: "unified",
			showWorkingTime: false,
			previewLines: { default: 25, read: 10, grep: 10, bash: 12 },
		});
	});

	it("ignores old visual environment overrides", () => {
		const old = process.env.FACELIFT_MAX_PREVIEW_LINES;
		process.env.FACELIFT_MAX_PREVIEW_LINES = "999";
		try {
			expect(loadConfig(configFile).previewLines.default).toBe(40);
		} finally {
			if (old === undefined) delete process.env.FACELIFT_MAX_PREVIEW_LINES;
			else process.env.FACELIFT_MAX_PREVIEW_LINES = old;
		}
	});

	it("seeds missing files and migrates an old facelift config", () => {
		const oldAgentDir = process.env.PI_AGENT_DIR;
		process.env.PI_AGENT_DIR = dir;
		try {
			const oldDir = join(dir, "wierd-facelift");
			mkdirSync(oldDir);
			writeFileSync(
				join(oldDir, "config.json"),
				JSON.stringify({ diffLayout: "split", showWorkingTime: false }),
			);
			const cfg = loadOrInitConfig();
			expect(cfg).toEqual({ ...defaultConfig(), diffLayout: "split", showWorkingTime: false });
			expect(existsSync(join(dir, "visuals", "config.json"))).toBe(true);
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
			else process.env.PI_AGENT_DIR = oldAgentDir;
		}
	});
});
