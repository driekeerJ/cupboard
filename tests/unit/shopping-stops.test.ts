/**
 * De boodschappenmomenten in het weekplan: één regel per winkel per dag, die
 * zegt vanaf wanneer haar spul in huis staat. Het blok is met de hand te
 * bewerken, dus dit gaat vooral over wat er heen en weer moet overleven.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PlanStore, setShopping, shoppingAt } from "../../src/plan";
import { startOfWeek } from "../../src/date";
import type { WeekPlan } from "../../src/types";

const WEEK = startOfWeek(new Date(2026, 8, 2), 1);

function roundTrip(plan: WeekPlan): WeekPlan {
	// serialise hangt aan de store voor `describeUsed`; die raakt shopping niet
	// aan, dus een kale store met alleen wat hij nodig heeft volstaat.
	const store = Object.create(PlanStore.prototype) as PlanStore;
	Object.assign(store, {
		plugin: { products: { byPath: () => null, match: () => null } },
	});
	const text = store.serialise(plan);
	const body = text.split("\n").slice(1).join("\n");
	return PlanStore.parse(body, WEEK);
}

test("een winkel met een moment overleeft heen en terug", () => {
	const plan: WeekPlan = { weekStart: "2026-08-31", days: [] };
	setShopping(plan, "2026-09-04", [
		{ shop: "AH", meal: "Dinner", when: "after" },
	]);
	assert.deepEqual(roundTrip(plan).days[0]?.shopping, [
		{ shop: "AH", meal: "Dinner", when: "after" },
	]);
});

test("twee winkels op één dag blijven allebei staan", () => {
	const plan: WeekPlan = { weekStart: "2026-08-31", days: [] };
	setShopping(plan, "2026-09-02", [
		{ shop: "Lidl", meal: "Lunch", when: "before" },
		{ shop: "Picnic", meal: "Dinner", when: "after" },
	]);
	assert.equal(roundTrip(plan).days[0]?.shopping?.length, 2);
});

test("een dag met alleen een boodschappenmoment verdwijnt niet", () => {
	// serialise gooide dagen zonder maaltijden weg; een dag die alleen zegt
	// dat de bezorging komt, heeft wel degelijk iets te melden.
	const plan: WeekPlan = { weekStart: "2026-08-31", days: [] };
	setShopping(plan, "2026-09-04", [{ shop: "AH" }]);
	assert.equal(roundTrip(plan).days.length, 1);
});

test("weghalen laat de sleutel niet als lege lijst achter", () => {
	const plan: WeekPlan = { weekStart: "2026-08-31", days: [] };
	setShopping(plan, "2026-09-04", [{ shop: "AH" }]);
	setShopping(plan, "2026-09-04", []);
	assert.equal(plan.days[0]?.shopping, undefined);
	assert.ok(!roundTrip(plan).days[0]?.shopping);
});

test("een blok zonder shopping blijft byte-identiek", () => {
	// Oude plannotities mogen niet aangeraakt worden door deze uitbreiding.
	const body = [
		"weekStart: 2026-08-31",
		"days:",
		"  - date: 2026-09-02",
		"    meals:",
		"      - meal: Dinner",
		"        recipes:",
		"          - recipe: '[[Nasi]]'",
		"            eaters: []",
		"            guests: 0",
	].join("\n");
	const parsed = PlanStore.parse(body, WEEK);
	assert.equal(parsed.days[0]?.shopping, undefined);
	assert.ok(!roundTrip(parsed).days[0]?.shopping);
});

test("een regel zonder winkelnaam wordt genegeerd", () => {
	const parsed = PlanStore.parse(
		[
			"weekStart: 2026-08-31",
			"days:",
			"  - date: 2026-09-02",
			"    shopping:",
			"      - shop: ''",
			"      - shop: Lidl",
			"    meals: []",
		].join("\n"),
		WEEK
	);
	assert.deepEqual(parsed.days[0]?.shopping, [{ shop: "Lidl" }]);
});

test("shoppingAt geeft een lege lijst voor een dag die er niet staat", () => {
	assert.deepEqual(shoppingAt({ weekStart: "2026-08-31", days: [] }, "2026-09-02"), []);
});
