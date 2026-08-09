import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function sessionCost(ctx: ExtensionContext): number {
  let cost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += (entry.message as AssistantMessage).usage.cost.total;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      cost += entry.message.usage?.cost.total ?? 0;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      cost += entry.usage?.cost.total ?? 0;
    }
  }

  return cost;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      render(width: number): string[] {
        const context = ctx.getContextUsage();
        const contextText = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
        const left = `${contextText}  $${sessionCost(ctx).toFixed(3)}`;
        const modelText = ctx.model?.id ?? "no model";
        const reasoningText = ctx.model?.reasoning ? ctx.thinkingLevel ?? "off" : "off";
        const fastText = footerData.getExtensionStatuses().has("pi-gpt-fast-mode") ? " [FAST]" : "";
        const right = `${modelText} (${reasoningText})${fastText}`;
        const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));

        return [truncateToWidth(theme.fg("dim", left + padding + right), width)];
      },
      invalidate() {},
    }));
  });
}
