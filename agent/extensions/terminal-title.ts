import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE = "pi";

function setTerminalTitle(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") ctx.ui.setTitle(TITLE);
}

function enforceTerminalTitle(ctx: ExtensionContext): void {
	setTerminalTitle(ctx);
	// Pi's session rebind updates its built-in `π - <directory>` title after
	// session_start handlers complete. Run once more on the next event-loop turn
	// so our local title is the final write.
	setImmediate(() => setTerminalTitle(ctx)).unref();
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => enforceTerminalTitle(ctx));
	// Pi also rewrites the title when a session is renamed.
	pi.on("session_info_changed", (_event, ctx) => enforceTerminalTitle(ctx));
}
