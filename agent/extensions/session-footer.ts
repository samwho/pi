import type { AssistantMessage } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { FAST_COST_MULTIPLIER } from "./fast-mode.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type StatusColor = "success" | "warning" | "error";
type GitDelta = { additions: number; deletions: number; untracked: number };

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
  if (Number.isInteger(rate)) return rate.toFixed(0);
  return rate < 10 ? rate.toFixed(2) : rate.toFixed(0);
}

function effectiveRate(rate: number | undefined, fastEnabled: boolean): number | undefined {
  if (!fastEnabled || typeof rate !== "number" || !Number.isFinite(rate)) return rate;
  return rate * FAST_COST_MULTIPLIER;
}

function displayCwd(
  cwd: string,
  shortened: (text: string) => string,
  normal: (text: string) => string,
): string {
  const home = homedir();
  const display = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  const prefix = display.startsWith("~/") ? "~/" : display.startsWith("/") ? "/" : "";
  const segments = display.slice(prefix.length).split("/").filter(Boolean);

  if (segments.length <= 2) return normal(display);

  return normal(prefix) + segments
    .map((segment, index) => index < segments.length - 2 ? shortened(segment.slice(0, 2)) : normal(segment))
    .join(normal("/"));
}

function parseNumstat(output: string): Pick<GitDelta, "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    const [added, deleted] = line.split("\t", 2);
    if (added && added !== "-") additions += Number.parseInt(added, 10) || 0;
    if (deleted && deleted !== "-") deletions += Number.parseInt(deleted, 10) || 0;
  }

  return { additions, deletions };
}

function modelLabel(provider: string | undefined, id: string | undefined): string {
  if (!id) return "no model";
  return provider?.startsWith("openai") ? id.replace(/^gpt-\d+(?:\.\d+)*-/, "") : id;
}

export default function (pi: ExtensionAPI) {
  let requestFooterRender: (() => void) | undefined;
  let gitDelta: GitDelta | null = null;
  let gitRefreshVersion = 0;

  async function refreshGitDelta(ctx: ExtensionContext): Promise<void> {
    const version = ++gitRefreshVersion;
    const status = await pi.exec(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: ctx.cwd, timeout: 5000 },
    );

    if (version !== gitRefreshVersion) return;
    if (status.code !== 0) {
      gitDelta = null;
      requestFooterRender?.();
      return;
    }

    const hasHead = (await pi.exec("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: ctx.cwd,
      timeout: 5000,
    })).code === 0;
    const diffArgs = hasHead ? ["diff", "--numstat", "HEAD"] : ["diff", "--cached", "--numstat"];
    const diff = await pi.exec("git", diffArgs, { cwd: ctx.cwd, timeout: 5000 });

    if (version !== gitRefreshVersion) return;
    const delta = diff.code === 0 ? parseNumstat(diff.stdout) : { additions: 0, deletions: 0 };
    gitDelta = {
      ...delta,
      untracked: status.stdout.split("\n").filter((line) => line.startsWith("?? ")).length,
    };
    requestFooterRender?.();
  }

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
          const cwdText = displayCwd(
            ctx.cwd,
            (text) => theme.fg("dim", text),
            (text) => theme.fg("accent", text),
          );
          const deltaText = gitDelta
            ? [
                theme.fg(gitDelta.additions ? "success" : "dim", `+${gitDelta.additions}`),
                theme.fg(gitDelta.deletions ? "error" : "dim", `-${gitDelta.deletions}`),
                gitDelta.untracked ? theme.fg("warning", `?${gitDelta.untracked}`) : "",
              ].filter(Boolean).join(" ")
            : "";
          const divider = theme.fg("dim", "|");
          const left = [
            cwdText,
            deltaText,
            contextText,
            theme.fg("dim", `$${sessionCost(ctx).toFixed(2)}`),
          ].filter(Boolean).join(` ${divider} `);

          const model = ctx.model;
          const fastEnabled = footerData.getExtensionStatuses().has("pi-gpt-fast-mode");
          const inputRate = effectiveRate(model?.cost?.input, fastEnabled);
          const outputRate = effectiveRate(model?.cost?.output, fastEnabled);
          const displayedModel = modelLabel(model?.provider, model?.id);
          const modelText = theme.fg(
            model ? priceColor(inputRate, outputRate) : "dim",
            displayedModel,
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

    void refreshGitDelta(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit") {
      void refreshGitDelta(ctx);
    }
  });

  // These changes can happen without a message being added to the branch.
  pi.on("model_select", () => requestFooterRender?.());
  pi.on("thinking_level_select", () => requestFooterRender?.());
  pi.on("turn_end", () => requestFooterRender?.());
}
