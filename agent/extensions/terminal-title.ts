import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE = "pi";

function setTerminalTitle(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") ctx.ui.setTitle(TITLE);
}

async function setHerdrTabTitle(pi: ExtensionAPI, title: string): Promise<void> {
	const tabId = process.env.HERDR_TAB_ID;
	if (process.env.HERDR_ENV !== "1" || !tabId) return;
	await pi.exec(process.env.HERDR_BIN_PATH || "herdr", ["tab", "rename", tabId, title]);
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		setTerminalTitle(ctx);
		await setHerdrTabTitle(pi, TITLE);
	});
	// An empty label hands the tab back to Herdr Auto Title when Pi exits.
	pi.on("session_shutdown", async () => setHerdrTabTitle(pi, ""));
}
