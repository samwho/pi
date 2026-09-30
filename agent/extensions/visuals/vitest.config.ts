import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Pi supplies these packages at runtime; resolve the same installation for
// tests without installing duplicate copies into the extension directory.
const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const hostModules = resolve(
	dirname(realpathSync(resolve(dirname(piBin), "../@earendil-works/pi-coding-agent"))),
	"..",
);

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-visuals-tests-"));
process.on("exit", () => rmSync(testAgentDir, { recursive: true, force: true }));

export default defineConfig({
	test: { env: { PI_AGENT_DIR: testAgentDir, FACELIFT_THEME: "github-dark" } },
	resolve: {
		alias: Object.fromEntries(
			["pi-ai", "pi-coding-agent", "pi-tui"].map((name) => [
				`@earendil-works/${name}`,
				resolve(hostModules, `@earendil-works/${name}/dist/index.js`),
			]),
		),
	},
});
