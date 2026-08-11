import type { AssistantMessage } from "@earendil-works/pi-ai";
import { FAST_COST_MULTIPLIER } from "./fast-mode.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type StatusColor = "success" | "warning" | "error";

// Rates in Pi's model catalogue are USD per million tokens. The highest of
// input/output is used so an expensive output price is not hidden by cheap input.
const CHEAP_PRICE = 5;
const EXPENSIVE_PRICE = 20;

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

function priceColor(input: number | undefined, output: number | undefined): StatusColor {
  const rates = [input, output].filter((rate): rate is number => typeof rate === "number" && Number.isFinite(rate));
  if (rates.length === 0) return "warning";

  const highestRate = Math.max(...rates);
  if (highestRate <= CHEAP_PRICE) return "success";
  if (highestRate <= EXPENSIVE_PRICE) return "warning";
  return "error";
}

function thinkingColor(level: string): StatusColor {
  if (level === "off" || level === "minimal" || level === "low") return "success";
  if (level === "medium") return "warning";
  return "error";
}

function contextColor(percent: number | null | undefined): StatusColor | undefined {
  if (percent == null || !Number.isFinite(percent)) return undefined;
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "success";
}

function formatRate(rate: number | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "?";
  return rate < 10 ? rate.toFixed(2) : rate.toFixed(0);
}

function effectiveRate(rate: number | undefined, fastEnabled: boolean): number | undefined {
  if (!fastEnabled || typeof rate !== "number" || !Number.isFinite(rate)) return rate;
  return rate * FAST_COST_MULTIPLIER;
}

export default function (pi: ExtensionAPI) {
  let requestFooterRender: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        render(width: number): string[] {
          const context = ctx.getContextUsage();
          const contextPercent = context?.percent;
          const contextLabel = contextPercent == null ? "?" : `${contextPercent.toFixed(1)}%`;
          const contextStatusColor = contextColor(contextPercent);
          const contextText = contextStatusColor
            ? theme.fg(contextStatusColor, contextLabel)
            : theme.fg("dim", contextLabel);
          const left = `${contextText} ${theme.fg("dim", `$${sessionCost(ctx).toFixed(3)}`)}`;

          const model = ctx.model;
          const fastEnabled = footerData.getExtensionStatuses().has("pi-gpt-fast-mode");
          const inputRate = effectiveRate(model?.cost?.input, fastEnabled);
          const outputRate = effectiveRate(model?.cost?.output, fastEnabled);
          const modelLabel = model?.id ?? "no model";
          const modelText = theme.fg(
            model ? priceColor(inputRate, outputRate) : "dim",
            modelLabel,
          );
          const thinkingLevel = model?.reasoning ? ctx.thinkingLevel ?? "off" : "off";
          const thinkingText = theme.fg(thinkingColor(thinkingLevel), thinkingLevel);
          const ratesText = model
            ? theme.fg("dim", `$${formatRate(inputRate)}/$${formatRate(outputRate)}`)
            : "";
          const fastText = fastEnabled ? theme.fg("warning", "fast") : "";
          const right = [modelText, thinkingText, fastText, ratesText].filter(Boolean).join(" ");
          const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));

          return [truncateToWidth(left + padding + right, width)];
        },
        invalidate() {},
        dispose() {
          unsubscribe();
          requestFooterRender = undefined;
        },
      };
    });
  });

  // These changes can happen without a message being added to the branch.
  pi.on("model_select", () => requestFooterRender?.());
  pi.on("thinking_level_select", () => requestFooterRender?.());
  pi.on("turn_end", () => requestFooterRender?.());
}
