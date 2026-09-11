import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const WORKING_TIME_ENTRY = "simple-working-time";

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export default function (pi: ExtensionAPI): void {
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.registerEntryRenderer(WORKING_TIME_ENTRY, (entry, _options, theme) => {
    const elapsedMs = (entry.data as { elapsedMs?: unknown })?.elapsedMs;
    if (typeof elapsedMs !== "number") return new Text("", 0, 0);
    return new Text(theme.fg("dim", `⏱ worked ${formatElapsed(elapsedMs)}`), 0, 0);
  });

  function stop(ctx?: ExtensionContext): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    startedAt = undefined;
    if (ctx?.hasUI) ctx.ui.setWorkingMessage();
  }

  function update(ctx: ExtensionContext): void {
    if (startedAt === undefined || !ctx.hasUI) return;
    ctx.ui.setWorkingMessage(`Working... ${formatElapsed(Date.now() - startedAt)}`);
  }

  pi.on("before_agent_start", (_event, ctx) => {
    stop();
    startedAt = Date.now();
    update(ctx);
    timer = setInterval(() => update(ctx), 1000);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const elapsedMs = startedAt === undefined ? undefined : Date.now() - startedAt;
    stop(ctx);
    if (elapsedMs !== undefined) pi.appendEntry(WORKING_TIME_ENTRY, { elapsedMs });
  });

  pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
