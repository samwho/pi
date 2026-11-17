import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export const CHROME_TOOL = Symbol.for("pi.chrome.tool-component");
export type ChromeToolComponent = Component & {
	[CHROME_TOOL]: (width: number, image?: string) => string;
};
type ToolInternal = { callRendererComponent?: ChromeToolComponent };
type ModeBridge = {
	chatContainer: Container;
	getRegisteredToolDefinition: (name: string) => unknown;
};
type RenderedChild = {
	component: Component;
	lines: string[];
	padding?: ChromeToolComponent[typeof CHROME_TOOL];
};

/** Keep original components as mouse targets, even after removing Pi's leading spacer. */
function cachedChild(child: RenderedChild, skip = 0): Component {
	return {
		render: (width) =>
			child.lines.slice(skip).map((line) => {
				if (!child.padding) return line;
				if (line === "") return child.padding(width);
				// Pi appends image footprints after the custom tool renderer. Preserve
				// the protocol payload, painting its row and the surrounding empty rows.
				if (line.includes("\x1b_G") || line.includes("\x1b]1337;File="))
					return child.padding(width, line);
				return line;
			}),
		handleMouse: (event) =>
			child.component.handleMouse?.({
				...event,
				y: event.y + skip,
				height: child.lines.length,
			}),
		invalidate() {},
	};
}

function group(calls: RenderedChild[], width: number): Container {
	const block = new Container();
	const padding = calls[0].padding!(width);
	const blank: Component = { render: () => [padding], invalidate() {} };
	block.addChild(new Spacer(1)); // Outside margin, separate from the shaded padding.
	block.addChild(blank);
	for (const call of calls) {
		// ToolExecutionComponent's self-render shell adds this spacer independently
		// of the renderer. All spacing now belongs to the outer group instead.
		block.addChild(cachedChild(call, call.lines[0] === "" ? 1 : 0));
	}
	block.addChild(blank);
	return block;
}

/**
 * Pi has no public transcript-grouping hook. Scope this adapter to the actual
 * chat container, never the global Container renderer. Undo it on shutdown/reload.
 * Tool execution, transcript children, and their expansion state are untouched.
 */
export function installToolGrouping(): () => void {
	const prototype = InteractiveMode.prototype as unknown as ModeBridge;
	const originalDefinition = prototype.getRegisteredToolDefinition;
	if (typeof originalDefinition !== "function") return () => {};
	let active = true;
	const attached = new WeakSet<Container>();
	const cleanup = new Set<() => void>();

	function attach(chat: Container): void {
		if (!chat || attached.has(chat)) return;
		attached.add(chat);
		const originalRender = chat.render;
		const originalMouse = chat.handleMouse;
		let layout: Container | undefined;
		let layoutWidth: number | undefined;
		const render = (width: number): string[] => {
			const container = new Container();
			let calls: RenderedChild[] = [];
			const flush = () => {
				if (calls.length) container.addChild(group(calls, width));
				calls = [];
			};
			for (const component of chat.children) {
				const lines = component.render(width);
				// Empty assistant messages/hidden thinking do not split a visible run.
				if (!lines.length) continue;
				const marker =
					component instanceof ToolExecutionComponent
						? (component as unknown as ToolInternal).callRendererComponent?.[CHROME_TOOL]
						: undefined;
				const child: RenderedChild = { component, lines, padding: marker };
				if (marker) calls.push(child);
				else {
					flush();
					container.addChild(component);
				}
			}
			flush();
			layout = container;
			layoutWidth = width;
			return container.render(width);
		};
		const mouse = (event: TuiMouseEvent) => {
			if (!layout || layoutWidth !== event.width) render(event.width);
			return layout?.handleMouse(event);
		};
		chat.render = render;
		chat.handleMouse = mouse;
		cleanup.add(() => {
			if (chat.render === render) chat.render = originalRender;
			if (chat.handleMouse === mouse) chat.handleMouse = originalMouse;
			layout = undefined;
		});
	}

	const resolveDefinition = function (this: ModeBridge, name: string): unknown {
		if (active) attach(this.chatContainer);
		return originalDefinition.call(this, name);
	};
	prototype.getRegisteredToolDefinition = resolveDefinition;
	return () => {
		active = false;
		if (prototype.getRegisteredToolDefinition === resolveDefinition)
			prototype.getRegisteredToolDefinition = originalDefinition;
		for (const restore of cleanup) restore();
		cleanup.clear();
	};
}
