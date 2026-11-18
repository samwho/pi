import { describe, expect, it } from "vitest";
import { toolFormatter } from "./formatters/index.ts";
import { resultStats, type Result } from "./render.ts";

const name = (method: string) => `mcp__grafana__${method}`;
const wrapped = (value: unknown): Result => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
});

describe("Grafana Chrome", () => {
	it("shows the query shape and range without copying PromQL string literals or comments", () => {
		const tool = name("query_prometheus");
		expect(
			toolFormatter(tool)?.call?.(
				{
					expr: 'rate(requests_total{job="secret\\\"value"}[5m]) # private note',
					queryType: "range",
					startTime: "now-30m",
					endTime: "now",
					stepSeconds: 15,
				},
				{ name: tool },
			),
		).toEqual({
			label: "grafana PromQL",
			subject: 'rate(requests_total{job="…"}[5m]) · range · now-30m → now · step 15s',
		});
	});

	it("counts instant and range query samples without including values", () => {
		const tool = name("query_prometheus");
		expect(
			resultStats(tool, wrapped([{ metric: { instance: "hidden" }, value: [1, "7"] }]))?.summary,
		).toBe("1 series · 1 sample");
		expect(
			resultStats(tool, {
				structuredContent: {
					status: "success",
					data: {
						resultType: "matrix",
						result: [
							{
								values: [
									[1, "1"],
									[2, "2"],
								],
							},
							{ values: [[1, "3"]], histograms: [[2, {}]] },
						],
					},
				},
			})?.summary,
		).toBe("2 series · 4 samples");
		expect(resultStats(tool, wrapped({ data: [] }))?.summary).toBe("0 series · 0 samples");
		expect(resultStats(tool, wrapped({ partial: "unknown" }))?.summary).toMatch(/^~\d+ tokens$/);
	});

	it.each([
		[
			"search_dashboards",
			{ dashboards: [{ title: "example" }], total: 20, hasMore: true },
			"1 dashboard · more available",
		],
		["list_datasources", { datasources: [], total: 0 }, "0 datasources"],
		["list_prometheus_label_names", ["job", "instance"], "2 labels"],
		["list_prometheus_metric_names", { data: ["up"] }, "1 metric"],
		["get_dashboard_panel_queries", [{ query: "payload" }], "1 query"],
	])("counts returned entries for %s", (method, value, expected) => {
		expect(resultStats(name(method), wrapped(value))?.summary).toBe(expected);
	});

	it("uses token estimates for dashboard properties and unknown counts for missing historical results", () => {
		expect(
			resultStats(name("get_dashboard_property"), wrapped("private dashboard title"))?.summary,
		).toMatch(/^~\d+ tokens$/);
		expect(toolFormatter(name("search_dashboards"))?.unavailableSummary).toBe("? dashboards");
	});
});
