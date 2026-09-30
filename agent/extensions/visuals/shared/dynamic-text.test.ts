import { describe, expect, it, vi } from "vitest";
import { DynamicText } from "./dynamic-text.ts";

describe("DynamicText", () => {
	it("keeps dynamic views live by default", () => {
		let value = "first";
		const render = vi.fn(() => value);
		const component = new DynamicText(render);
		expect(component.render(40)).toEqual(["first"]);
		value = "second";
		expect(component.render(40)).toEqual(["second"]);
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("caches stable views per width and refreshes after invalidation", () => {
		let value = "first";
		const render = vi.fn(() => value);
		const component = new DynamicText(render, true);
		expect(component.render(40)).toEqual(["first"]);
		value = "second";
		expect(component.render(40)).toEqual(["first"]);
		component.render(30);
		expect(render).toHaveBeenCalledTimes(2);
		component.invalidate();
		expect(component.render(30)).toEqual(["second"]);
		expect(render).toHaveBeenCalledTimes(3);
	});
});
