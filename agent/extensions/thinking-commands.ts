import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export default function (pi: ExtensionAPI): void {
  for (const level of THINKING_LEVELS) {
    pi.registerCommand(level, {
      description: `Set thinking level to ${level}`,
      handler: async (_args, ctx) => {
        pi.setThinkingLevel(level);
        const effectiveLevel = pi.getThinkingLevel();
        const notificationType = effectiveLevel === level ? "info" : "warning";
        ctx.ui.notify(`Thinking level: ${effectiveLevel}`, notificationType);
      },
    });
  }
}
