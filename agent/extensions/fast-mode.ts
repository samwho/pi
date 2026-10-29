import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_COST_MULTIPLIER = 2.5;
const CONFIG_FIELD = "pi-gpt-fast-mode";
const FAST_SERVICE_TIER = "priority";

const SUPPORTED_MODELS = new Set([
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.5",
	"openai/gpt-5.6",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai/gpt-6-luna",
	"openai/gpt-6-sol",
	"openai/gpt-6.1-sol",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.4-mini",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-6-luna",
	"openai-codex/gpt-6-sol",
	"openai-codex/gpt-6.1-sol",
]);

type JsonObject = Record<string, unknown>;

type PiFileOptions = {
	env?: Record<string, string | undefined>;
	home?: string;
};

function expandHome(input: string, home: string): string {
	if (input === "~") return home;
	if (input.startsWith("~/")) return join(home, input.slice(2));
	return input;
}

function resolvePiFilePath(fileName: string, options: PiFileOptions = {}): string {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const piDir = env.PI_CODING_AGENT_DIR?.trim();
	if (piDir) return join(resolve(expandHome(piDir, home)), fileName);

	const xdgHome = env.XDG_CONFIG_HOME?.trim()
		? resolve(expandHome(env.XDG_CONFIG_HOME, home))
		: join(home, ".config");
	const xdgCandidates = [join(xdgHome, "pi", "agent", fileName), join(xdgHome, "pi", fileName)];
	for (const candidate of xdgCandidates) {
		if (existsSync(candidate)) return candidate;
	}
	return join(home, ".pi", "agent", fileName);
}

function readJson(path: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: undefined;
	} catch {
		return undefined;
	}
}

function loadDefaultEnabled(): boolean {
	const config = readJson(resolvePiFilePath("settings.json"))?.[CONFIG_FIELD];
	return Boolean(
		config &&
		typeof config === "object" &&
		!Array.isArray(config) &&
		(config as JsonObject).enabled === true,
	);
}

function saveEnabled(enabled: boolean): void {
	const path = resolvePiFilePath("settings.json");
	const settings = readJson(path) ?? {};
	const current = settings[CONFIG_FIELD];
	settings[CONFIG_FIELD] = {
		...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
		enabled,
	};

	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}`;
	const serialized = `${JSON.stringify(settings, null, 2)}\n`;
	writeFileSync(temporaryPath, serialized, "utf8");
	try {
		renameSync(temporaryPath, path);
	} catch (error) {
		// A settings file projected into the VM as an individual bind mount cannot
		// be replaced with rename(2). Fall back to updating that mounted file in
		// place; normal filesystems retain the safer atomic replacement above.
		if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		writeFileSync(path, serialized, "utf8");
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function modelKey(model: { provider?: string; id?: string } | undefined): string {
	return `${model?.provider}/${model?.id}`;
}

function supportedModel(model: { provider?: string; id?: string } | undefined): boolean {
	return Boolean(model?.provider && model.id && SUPPORTED_MODELS.has(modelKey(model)));
}

function setFastStatus(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setStatus(CONFIG_FIELD, enabled && supportedModel(ctx.model) ? "fast" : undefined);
}

export default function (pi: ExtensionAPI): void {
	let enabled = loadDefaultEnabled();

	const announceState = (ctx: ExtensionContext, state: boolean): void => {
		setFastStatus(ctx, state);
		if (!state) {
			ctx.ui.notify("GPT Fast mode disabled.", "info");
		} else if (supportedModel(ctx.model)) {
			ctx.ui.notify(`GPT Fast mode enabled (service_tier: ${FAST_SERVICE_TIER}).`, "info");
		} else {
			ctx.ui.notify(
				`GPT Fast mode enabled, but ${modelKey(ctx.model)} is not supported.`,
				"warning",
			);
		}
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext): void => {
		enabled = next;
		saveEnabled(enabled);
		setFastStatus(ctx, enabled);
	};

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		setEnabled(!enabled, ctx);
		announceState(ctx, enabled);
	};

	pi.registerCommand("fast", {
		description: "Toggle GPT Fast mode (service_tier: priority)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.events.on("fast-mode/set-enabled", (data) => {
		const { enabled: next, ctx } = data as { enabled: boolean; ctx: ExtensionContext };
		setEnabled(next, ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = loadDefaultEnabled();
		setFastStatus(ctx, enabled);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!enabled ||
			!model ||
			!supportedModel(model) ||
			!event.payload ||
			typeof event.payload !== "object"
		)
			return undefined;

		const payload = event.payload as Record<string, unknown>;
		if (payload.model !== model.id) return undefined;
		return { ...payload, service_tier: FAST_SERVICE_TIER };
	});

	pi.on("model_select", (_event, ctx) => {
		setFastStatus(ctx, enabled);
	});
}
