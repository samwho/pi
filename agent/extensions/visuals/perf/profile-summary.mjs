import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path)
	throw new Error("Usage: node visuals/perf/profile-summary.mjs path/to/scroll.cpuprofile");
const profile = JSON.parse(await readFile(path, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map(
	profile.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id])),
);
const self = new Map();
const inclusive = new Map();
for (let i = 0; i < profile.samples.length; i++) {
	const id = profile.samples[i];
	self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[i]);
}
for (const [id, weight] of self) {
	for (let current = id; current !== undefined; current = parents.get(current))
		inclusive.set(current, (inclusive.get(current) ?? 0) + weight);
}
for (const { name, weights } of [
	{ name: "Self", weights: self },
	{ name: "Inclusive", weights: inclusive },
]) {
	console.log(`\n${name} CPU samples (ms; inclusive rows overlap):`);
	for (const [id, weight] of [...weights].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
		const frame = nodes.get(id).callFrame;
		const url = frame.url.replace("file://", "");
		console.log(
			`${(weight / 1000).toFixed(1).padStart(8)}  ${(frame.functionName || "(anonymous)").padEnd(28)} ${url ? `${url}:${frame.lineNumber + 1}` : ""}`,
		);
	}
}
