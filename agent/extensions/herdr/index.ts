import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerActivitySummary from "./activity-summary.ts";
import registerAgentState from "./agent-state.ts";

const TAB_TITLE = "pi";

function herdrBinary(): string | undefined {
	const binary = process.env.HERDR_BIN_PATH;
	return binary && existsSync(binary) ? binary : undefined;
}

function isRootHerdrSession(): boolean {
	return (
		process.env.HERDR_ENV === "1" &&
		Boolean(process.env.HERDR_SOCKET_PATH) &&
		Boolean(process.env.HERDR_PANE_ID) &&
		Boolean(process.env.HERDR_TAB_ID) &&
		Boolean(herdrBinary()) &&
		!process.env.PI_SESSION_ID
	);
}

async function setTabTitle(pi: ExtensionAPI, title: string): Promise<void> {
	const binary = herdrBinary();
	const tabId = process.env.HERDR_TAB_ID;
	if (!binary || !tabId) return;
	await pi.exec(binary, ["tab", "rename", tabId, title]);
}

export default function (pi: ExtensionAPI): void {
	// Stay inert outside a root Pi process running in an installed Herdr session.
	if (!isRootHerdrSession()) return;

	registerAgentState(pi);
	registerActivitySummary(pi);

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await setTabTitle(pi, TAB_TITLE);
	});

	// An empty label hands the tab back to Herdr Auto Title when Pi exits.
	pi.on("session_shutdown", async () => setTabTitle(pi, ""));
}
