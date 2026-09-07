import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("astra", {
    description: "Switch to GPT-6 Astra with medium thinking",
    handler: async (_args, ctx) => {
      const model = ctx.modelRegistry.find("openai-codex", "gpt-6-astra");
      if (!model) {
        ctx.ui.notify("Model openai-codex/gpt-6-astra is unavailable", "error");
        return;
      }

      if (!(await pi.setModel(model))) {
        ctx.ui.notify("No authentication configured for openai-codex/gpt-6-astra", "error");
        return;
      }

      pi.setThinkingLevel("medium");
      ctx.ui.notify(`Model: ${model.name}; thinking: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
