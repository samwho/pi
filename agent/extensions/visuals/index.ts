import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBuiltinTools, {
	type BuiltinToolApi,
	type BuiltinToolDeps,
} from "./builtin-tools.ts";
import registerCodeOutputHighlighter from "./code-output-highlighter/index.ts";
import registerCodemodeRenderer from "./codemode-renderer.ts";
import registerSessionFooter from "./session-footer.ts";
import registerSimpleWorkingTime from "./simple-working-time.ts";
import registerWebSearchRenderer from "./web-search-renderer.ts";
import registerWelcomeHeader from "./welcome-header.ts";

// Keep the ported renderer tests' injected SDK and test hooks available.
export { __hlInternals, __imageInternals, __themeInternals } from "./builtin-tools.ts";

/** Register built-in renderers first, then the shared decorators and other UI. */
export default function visuals(pi: BuiltinToolApi, deps?: BuiltinToolDeps): void {
	registerBuiltinTools(pi, deps);
	if (deps) return;

	const runtime = pi as unknown as ExtensionAPI;
	registerCodeOutputHighlighter(runtime);
	registerCodemodeRenderer(runtime);
	registerWebSearchRenderer(runtime);
	registerSimpleWorkingTime(runtime);
	registerWelcomeHeader(runtime);
	registerSessionFooter(runtime);
}
