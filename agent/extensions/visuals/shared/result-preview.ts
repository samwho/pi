import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { previewLineLimit } from "../config.ts";
import { frameBodyLines, getFrameStatus } from "../common/tool-frame/index.ts";

/** Limit rendered body rows, leaving the result's bottom border and full expanded view intact. */
export function limitResultPreview(
	component: Component,
	toolName: string,
	expanded: boolean,
	theme: Theme,
	context: { isPartial?: boolean; isError?: boolean },
): Component {
	if (expanded) return component;
	const limit = previewLineLimit(toolName);
	return {
		render(width) {
			const rows = component.render(width);
			const last = rows.at(-1);
			const framed =
				last !== undefined && /^(?:│)?╰/.test(last.replace(/\x1b\[[0-9;]*m/g, "").trimStart());
			const body = framed ? rows.slice(0, -1) : rows;
			if (body.length <= limit) return rows;
			const shown = limit - 1; // Reserve one of the configured rows for the notice.
			const notice = theme.fg("muted", `… ${body.length - shown} more lines · Ctrl+O to expand`);
			return [
				...body.slice(0, shown),
				framed ? frameBodyLines(notice, getFrameStatus(context), theme, width) : notice,
				...(framed && last !== undefined ? [last] : []),
			];
		},
		invalidate() {
			component.invalidate?.();
		},
	};
}
