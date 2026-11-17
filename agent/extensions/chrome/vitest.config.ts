import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const hostModules = resolve(
	dirname(realpathSync(resolve(dirname(piBin), "../@earendil-works/pi-coding-agent"))),
	"..",
);

export default defineConfig({
	resolve: {
		alias: Object.fromEntries(
			["pi-ai", "pi-coding-agent", "pi-tui"].map((name) => [
				`@earendil-works/${name}`,
				resolve(hostModules, `@earendil-works/${name}/dist/index.js`),
			]),
		),
	},
});
