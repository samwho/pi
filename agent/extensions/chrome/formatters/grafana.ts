import type { Result } from "../render.ts";
import { count, join, json, object, payloads, reference, text, tokens, words } from "./shared.ts";
import type { ToolFormatter } from "./types.ts";

type Args = Record<string, unknown>;
const datasource = (args: Args) => reference(args.datasourceUid, "source");
const dashboard = (args: Args) => reference(args.uid, "dashboard");
const page = (value: unknown) => (typeof value === "number" && value > 1 ? `page ${value}` : "");

function timeRange(start: unknown, end: unknown): string {
	const from = text(start);
	const to = text(end);
	return from ? `${from} → ${to || "now"}` : to ? `at ${to}` : "";
}

// Keep the query structure visible without copying label values into the collapsed row.
function queryPreview(value: unknown): string {
	return typeof value === "string"
		? text(
				value.replace(
					/"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|`[^`]*(?:`|$)|#[^\r\n]*/g,
					(part) => (part.startsWith("#") ? " " : `${part[0]}…${part[0]}`),
				),
			)
		: "";
}

function prometheusSummary(result: Result): string | undefined {
	for (const payload of payloads(result)) {
		const root = object(payload);
		const raw = json(root.data ?? payload);
		const data = object(raw);
		const kind = data.resultType ?? root.resultType;
		const entries = Array.isArray(raw) ? raw : json(data.result ?? root.result);
		if (!Array.isArray(entries)) continue;
		if ((kind === "scalar" || kind === "string") && entries.length === 2) return count(1, "sample");
		let samples = 0;
		let valid = true;
		for (const entry of entries as unknown[]) {
			const series = object(entry);
			if (Array.isArray(series.values) || Array.isArray(series.histograms))
				samples +=
					(Array.isArray(series.values) ? series.values.length : 0) +
					(Array.isArray(series.histograms) ? series.histograms.length : 0);
			else if (Array.isArray(series.value) || Array.isArray(series.histogram)) samples++;
			else {
				valid = false;
				break;
			}
		}
		if (valid) return join(count(entries.length, "series", "series"), count(samples, "sample"));
	}
	return undefined;
}

function returned(
	result: Result,
	keys: string[],
	singular: string,
	plural?: string,
): string | undefined {
	for (const payload of payloads(result)) {
		const root = object(payload);
		const entries = Array.isArray(payload)
			? payload
			: keys.map((key) => json(root[key])).find(Array.isArray);
		if (!Array.isArray(entries)) continue;
		return join(
			count(entries.length, singular, plural),
			root.hasMore === true ? "more available" : "",
		);
	}
	return undefined;
}

type Presentation = {
	action: string;
	subject: (args: Args) => string;
	summary: (result: Result) => string | undefined;
	fallback?: string;
};
const presentations: Record<string, Presentation> = {
	query_prometheus: {
		action: "PromQL",
		subject: (args) => {
			const range = args.queryType === "range";
			return join(
				queryPreview(args.expr),
				range ? "range" : "instant",
				timeRange(range ? args.startTime : undefined, args.endTime),
				range && typeof args.stepSeconds === "number" ? `step ${args.stepSeconds}s` : "",
				datasource(args),
			);
		},
		summary: prometheusSummary,
		fallback: "? series",
	},
	search_dashboards: {
		action: "dashboards",
		subject: (args) =>
			join(
				args.query,
				args.starred === true ? "starred" : "",
				text(args.folderPath) || reference(args.folderUid, "folder"),
				words(args.tag),
				page(args.page),
			),
		summary: (result) => returned(result, ["dashboards"], "dashboard"),
		fallback: "? dashboards",
	},
	list_prometheus_label_names: {
		action: "Prometheus labels",
		subject: (args) =>
			join(
				datasource(args),
				Array.isArray(args.matches) && args.matches.length
					? count(args.matches.length, "selector")
					: "",
				timeRange(args.startRfc3339, args.endRfc3339),
			),
		summary: (result) => returned(result, ["labels", "labelNames", "data"], "label"),
		fallback: "? labels",
	},
	list_prometheus_metric_names: {
		action: "Prometheus metrics",
		subject: (args) =>
			join(
				args.regex,
				datasource(args),
				timeRange(args.startRfc3339, args.endRfc3339),
				page(args.page),
			),
		summary: (result) => returned(result, ["metrics", "metricNames", "data"], "metric"),
		fallback: "? metrics",
	},
	get_dashboard_property: {
		action: "dashboard property",
		subject: (args) => join(queryPreview(args.jsonPath), dashboard(args)),
		// A property can be a scalar, object, or array. Don't guess at its meaning.
		summary: () => undefined,
	},
	list_datasources: {
		action: "datasources",
		subject: (args) =>
			join(
				args.type,
				args.name,
				typeof args.offset === "number" && args.offset > 0 ? `offset ${args.offset}` : "",
			),
		summary: (result) => returned(result, ["datasources"], "datasource"),
		fallback: "? datasources",
	},
	get_dashboard_panel_queries: {
		action: "panel queries",
		subject: (args) =>
			join(
				dashboard(args),
				typeof args.panelId === "number" ? `panel ${args.panelId}` : "",
				timeRange(args.start, args.end),
			),
		summary: (result) => returned(result, ["queries"], "query", "queries"),
		fallback: "? queries",
	},
};

const grafana: ToolFormatter[] = Object.entries(presentations).map(([method, view]) => ({
	tools: [`mcp__grafana__${method}`],
	call: (args) => ({ label: `grafana ${view.action}`, subject: view.subject(args) }),
	result: (result, context) => ({ summary: view.summary(result) ?? tokens(context.tokens) }),
	unavailableSummary: view.fallback ?? "~? tokens",
}));
export default grafana;
