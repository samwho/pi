import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	type Component,
	type ScrollView,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

export const CHROME_TOOL = Symbol.for("pi.chrome.tool-component");
export type ChromeToolComponent = Component & {
	[CHROME_TOOL]: (width: number, image?: string) => string;
	toolTimestamp?: () => number | undefined;
	prepareVisibleShell?: () => void;
	headingWithAge?: (line: string, width: number, age: string) => string;
};
type ToolInternal = { callRendererComponent?: ChromeToolComponent };
type ModeBridge = {
	chatContainer: Container;
	documentContainer: Container;
	transcriptScrollView?: ScrollView;
	ui: { terminal: { rows: number } };
	getRegisteredToolDefinition: (name: string) => unknown;
};
type RenderedChild = {
	component: Component;
	lines: string[];
	padding?: ChromeToolComponent[typeof CHROME_TOOL];
	timestamp?: number;
	headingWithAge?: ChromeToolComponent["headingWithAge"];
	prepareVisibleShell?: () => void;
};

/** Keep original components as mouse targets, even after removing Pi's leading spacer. */
function cachedChild(child: RenderedChild, skip = 0, age = ""): Component {
	return {
		render: (width) =>
			child.padding
				? child.lines.slice(skip).map((line, index) => {
						if (!child.padding) return line;
						if (line === "") return child.padding(width);
						// Pi appends image footprints after the custom tool renderer. Preserve
						// the protocol payload, painting its row and the surrounding empty rows.
						if (line.includes("\x1b_G") || line.includes("\x1b]1337;File="))
							return child.padding(width, line);
						return index === 0 && age ? (child.headingWithAge?.(line, width, age) ?? line) : line;
					})
				: child.lines,
		handleMouse: (event) =>
			child.component.handleMouse?.({
				...event,
				y: event.y + skip,
				height: child.lines.length,
			}),
		invalidate() {},
	};
}

export function toolAge(timestamp?: number, now = Date.now()): string {
	if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
	const minutes = Math.floor((now - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / 1440)}d ago`;
}

function group(calls: RenderedChild[], width: number, now: number): Container {
	const block = new Container();
	const first = calls[0];
	const padding = first.padding!;
	const blank: Component = { render: () => [padding(width)], invalidate() {} };
	block.addChild(new Spacer(1)); // Outside margin, separate from the shaded padding.
	block.addChild(blank);
	for (const call of calls) {
		// ToolExecutionComponent's self-render shell adds this spacer independently
		// of the renderer. All spacing now belongs to the outer group instead.
		const age = call === first ? toolAge(call.timestamp, now) : "";
		block.addChild(cachedChild(call, call.lines[0] === "" ? 1 : 0, age));
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

	function attach(mode: ModeBridge): void {
		const chat = mode.chatContainer;
		if (!chat || attached.has(chat)) return;
		attached.add(chat);
		const originalRender = chat.render;
		const originalMouse = chat.handleMouse;
		let layout: Container | undefined;
		let layoutWidth: number | undefined;
		const render = (width: number): string[] => {
			const container = new Container();
			const now = Date.now();
			let calls: RenderedChild[] = [];
			let height = 0;
			const shellRanges: { start: number; end: number; prepare: () => void }[] = [];
			const flush = () => {
				if (!calls.length) return;
				container.addChild(group(calls, width, now));
				height += 2; // Outer spacer and top padding.
				for (const call of calls) {
					const end = height + call.lines.length - (call.lines[0] === "" ? 1 : 0);
					if (call.prepareVisibleShell)
						shellRanges.push({ start: height, end, prepare: call.prepareVisibleShell });
					height = end;
				}
				height++; // Bottom padding.
				calls = [];
			};
			for (const component of chat.children) {
				const lines = component.render(width);
				// Empty assistant messages/hidden thinking do not split a visible run.
				if (!lines.length) continue;
				const chrome =
					component instanceof ToolExecutionComponent
						? (component as unknown as ToolInternal).callRendererComponent
						: undefined;
				const padding = chrome?.[CHROME_TOOL];
				if (padding)
					calls.push({
						component,
						lines,
						padding,
						timestamp: chrome?.toolTimestamp?.(),
						headingWithAge: chrome?.headingWithAge,
						prepareVisibleShell: chrome?.prepareVisibleShell,
					});
				else {
					flush();
					container.addChild(cachedChild({ component, lines }));
					height += lines.length;
				}
			}
			flush();
			// Fullscreen exposes scroll bounds. In normal terminal scrollback only the tail
			// can be refreshed by Pi, so leave older history in its original shell text.
			const viewport = mode.transcriptScrollView;
			const windowHeight = viewport?.viewportHeight || mode.ui.terminal.rows || 40;
			let start = height - windowHeight;
			if (viewport?.viewportHeight && !viewport.isFollowingEnd) {
				let prefixHeight = 0;
				for (const component of mode.documentContainer.children) {
					if (component === chat) break;
					prefixHeight += component.render(width).length;
				}
				start = viewport.scrollTop - prefixHeight;
			}
			// Allow one screen of lookahead so scrolls can show already prepared rows.
			for (const range of shellRanges)
				if (range.end > start - windowHeight && range.start < start + 2 * windowHeight)
					range.prepare();
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
		if (active) attach(this);
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
