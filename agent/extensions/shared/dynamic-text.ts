import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** A width-aware text component for renderers that draw their own frame. */
export class DynamicText implements Component {
	constructor(private readonly renderText: (width: number) => string | string[]) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const rendered = this.renderText(safeWidth);
		const lines = typeof rendered === "string" ? rendered.split("\n") : rendered;
		return lines.map(line => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {}
}
