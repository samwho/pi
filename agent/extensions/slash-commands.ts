import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelPreset = {
	modelId: string;
	thinking: "xhigh" | "medium";
	fast: boolean;
};

const MODEL_PRESETS = {
	luna: { modelId: "gpt-6-luna", thinking: "xhigh", fast: true },
	sol: { modelId: "gpt-6-sol", thinking: "medium", fast: false },
} satisfies Record<string, ModelPreset>;

export default function (pi: ExtensionAPI): void {
	const applyPreset = async (
		name: string,
		preset: ModelPreset,
		ctx: ExtensionContext,
	): Promise<void> => {
		const model = ctx.modelRegistry.find("openai", preset.modelId);
		if (!model) {
			ctx.ui.notify(`Model not found: openai/${preset.modelId}`, "error");
			return;
		}

		try {
			const selected = await pi.setModel(model);
			if (!selected) {
				ctx.ui.notify(`No API key configured for openai/${preset.modelId}.`, "error");
				return;
			}

			pi.setThinkingLevel(preset.thinking);
			pi.events.emit("fast-mode/set-enabled", { enabled: preset.fast, ctx });
			ctx.ui.notify(
				`${name}: ${model.provider}/${model.id}, ${preset.thinking} thinking, fast ${preset.fast ? "on" : "off"}.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	for (const [name, preset] of Object.entries(MODEL_PRESETS)) {
		pi.registerCommand(name, {
			description: `Switch to ${preset.modelId} (${preset.thinking} thinking, fast ${preset.fast ? "on" : "off"})`,
			handler: async (_args, ctx) => applyPreset(name, preset, ctx),
		});
	}

	pi.registerCommand("astra", {
		description: "Switch to GPT-6 Astra with medium thinking",
		handler: async (_args, ctx) => {
			const model = ctx.modelRegistry.find("openai", "gpt-6-astra");
			if (!model) {
				ctx.ui.notify("Model openai/gpt-6-astra is unavailable", "error");
				return;
			}

			if (!(await pi.setModel(model))) {
				ctx.ui.notify("No authentication configured for openai/gpt-6-astra", "error");
				return;
			}

			pi.setThinkingLevel("medium");
			ctx.ui.notify(`Model: ${model.name}; thinking: ${pi.getThinkingLevel()}`, "info");
		},
	});
}
