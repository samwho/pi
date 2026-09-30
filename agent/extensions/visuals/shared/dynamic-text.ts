import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** A width-aware text component for renderers that draw their own frame.
 * Cache only views that change via a new component or invalidate(); live spinners stay uncached.
 */
export class DynamicText implements Component {
	private cached?: { width: number; lines: string[] };

	constructor(
		private readonly renderText: (width: number) => string | string[],
		private readonly cache = false,
	) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (this.cache && this.cached?.width === safeWidth) return this.cached.lines;
		const rendered = this.renderText(safeWidth);
		const lines = typeof rendered === "string" ? rendered.split("\n") : rendered;
		const clipped = lines.map((line) => truncateToWidth(line, safeWidth, ""));
		if (this.cache) this.cached = { width: safeWidth, lines: clipped };
		return clipped;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}
