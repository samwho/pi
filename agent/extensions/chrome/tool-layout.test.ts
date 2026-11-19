import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { toolComponent, type RenderEnvironment } from "./render.ts";
import { stripVTControlCharacters } from "node:util";
import { CHROME_TOOL, installToolGrouping, toolAge } from "./tool-layout.ts";

describe("Chrome tool group timestamps", () => {
	it("shows relative ages in minutes, hours, and days", () => {
		const now = 10 * 86_400_000;
		expect(toolAge(undefined, now)).toBe("");
		expect(toolAge(now - 59_000, now)).toBe("just now");
		expect(toolAge(now - 360_000, now)).toBe("6m ago");
		expect(toolAge(now - 3_600_000, now)).toBe("1h ago");
		expect(toolAge(now - 172_800_000, now)).toBe("2d ago");
	});

	it("right-aligns the timestamp on the heading and truncates overlapping text", () => {
		const view = { id: "call", name: "bash", args: {}, status: "success", complete: true } as const;
		const style = (_color: string, value: string) => value;
		const env = { theme: { bg: style, fg: style, getBgAnsi: () => "" } } as RenderEnvironment;
		const component = toolComponent(
			() => view,
			() => env,
		);
		const heading = (line: string, width: number) =>
			stripVTControlCharacters(component.headingWithAge!(line, width, "6m ago"));
		expect(heading("bash        ", 12)).toBe("bash 6m ago ");
		expect(heading("bash · too long", 12)).toBe("bas… 6m ago ");
		expect(heading("bash · too long", 6)).toBe("6m ago");
		expect(component[CHROME_TOOL](12)).toBe(" ".repeat(12));
	});
});

const style = (_color: string, value: string) => value;
const environment = () =>
	({
		theme: { bg: style, fg: style, getBgAnsi: () => "" },
		cwd: "/",
		errorHint: "",
		spinner: "x",
		bashUsage: () => undefined,
	}) as unknown as RenderEnvironment;

it("caches settled rows by width and refreshes on invalidation or new results", () => {
	const view = { id: "call", name: "read", args: {}, status: "success", complete: true } as const;
	let result = { content: [{ type: "text", text: "first" }] };
	const component = toolComponent(() => ({ ...view, result }), environment);
	const first = component.render(80);
	expect(component.render(80)).toBe(first);
	result = { content: [{ type: "text", text: "second" }] };
	expect(component.render(80)).not.toBe(first);
	const narrower = component.render(40);
	expect(component.render(40)).toBe(narrower);
	component.invalidate();
	expect(component.render(40)).not.toBe(narrower);
});

it("measures prose once and defers old shell rows until fullscreen scroll approaches them", () => {
	const chatContainer = new Container();
	const documentContainer = new Container();
	documentContainer.addChild(chatContainer);
	const transcriptScrollView = { viewportHeight: 10, scrollTop: 0, isFollowingEnd: true };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		chatContainer,
		documentContainer,
		transcriptScrollView,
		ui: { terminal: { rows: 10 } },
	});
	Object.defineProperty(mode, "session", {
		value: {
			getToolDefinition: () => undefined,
			extensionRunner: { resolveToolRenderers: () => undefined },
		},
	});
	const shell = () => {
		const prepare = vi.fn();
		chatContainer.addChild(
			Object.assign(Object.create(ToolExecutionComponent.prototype), {
				render: () => ["", "bash"],
				callRendererComponent: { [CHROME_TOOL]: () => " ", prepareVisibleShell: prepare },
			}),
		);
		return prepare;
	};
	const old = shell();
	const prose = vi.fn(() => Array<string>(100).fill("prose"));
	chatContainer.addChild({ render: prose, invalidate() {} });
	const latest = shell();
	const stop = installToolGrouping();
	try {
		mode.getRegisteredToolDefinition("bash");
		chatContainer.render(80);
		expect(prose).toHaveBeenCalledTimes(1);
		expect(old).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledTimes(1);
		transcriptScrollView.isFollowingEnd = false;
		chatContainer.render(80);
		expect(old).toHaveBeenCalledTimes(1);
		expect(latest).toHaveBeenCalledTimes(1);
	} finally {
		stop();
	}
});
