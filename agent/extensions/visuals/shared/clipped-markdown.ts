import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";

type MarkdownInternals = {
	renderToken(
		token: unknown,
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	): string[];
	wrapCellText(text: string, width: number, stylePrefix?: string): string[];
};

/** Keep Markdown styling, but never turn a long tool-output line into extra rows. */
export function renderClippedMarkdown(source: string, width: number): string[] {
	if (!source) return [];
	const clip = (text: string, available: number) =>
		text
			.split("\n")
			.map((line) => truncateToWidth(line.replace(/\t/g, "   "), Math.max(1, available), ""));
	const component = new Markdown(source, 0, 0, getMarkdownTheme());
	const internal = component as unknown as MarkdownInternals;
	if (typeof internal.renderToken !== "function" || typeof internal.wrapCellText !== "function") {
		// Changed Pi internals: fall back to readable, clipped source.
		return clip(source, width);
	}
	// Pi has no no-wrap option. Clip token output before its final wrapping
	// pass, including children of lists/quotes. Only this instance is patched;
	// assistant Markdown and the global prototype are untouched.
	// oxlint-disable-next-line typescript/unbound-method
	const renderToken = internal.renderToken;
	internal.renderToken = function (token, available, nextTokenType, styleContext) {
		const table = token as { type?: string; header?: unknown[]; raw?: string };
		if (
			table.type === "table" &&
			table.header &&
			available < table.header.length * 4 + 1 &&
			table.raw
		) {
			// Native tables fall back to soft-wrapped raw Markdown when too narrow.
			return clip(table.raw, available);
		}
		return renderToken
			.call(this, token, available, nextTokenType, styleContext)
			.flatMap((line) => clip(line, available));
	};
	internal.wrapCellText = (text, available, stylePrefix = "") =>
		clip(text, available).map((line) => line + stylePrefix);
	return component.render(Math.max(1, width));
}
