import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const OPENAI_PROVIDERS = ["openai", "openai-codex"] as const;

export function isOpenAIProvider(provider: string | undefined): boolean {
	return OPENAI_PROVIDERS.some((candidate) => candidate === provider);
}

/** Prefer OpenAI, but try Codex when the model or authentication is unavailable. */
export async function selectOpenAIModel(
	pi: Pick<ExtensionAPI, "setModel">,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	modelId: string,
): Promise<NonNullable<ExtensionContext["model"]>> {
	let found = false;
	for (const provider of OPENAI_PROVIDERS) {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) continue;
		found = true;
		if (await pi.setModel(model)) return model;
	}
	throw new Error(
		found
			? `No authentication configured for ${modelId} (tried ${OPENAI_PROVIDERS.join(", ")}).`
			: `Model ${modelId} is unavailable (tried ${OPENAI_PROVIDERS.join(", ")}).`,
	);
}
