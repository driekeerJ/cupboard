/**
 * `pantry: ignore` — een ingrediënt dat nooit een boodschap wordt.
 *
 * Water staat in tientallen recepten en is in geen enkele winkel te koop. Zonder
 * een plek om dat te zeggen bleef elke regel water als onbekend ingrediënt op de
 * opruimlijst staan, en was er niets dat je eraan kon doen. De notitie bestaat
 * zodat recepten ernaar kunnen wijzen; verder houdt hij zijn mond.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { missingFields } from "../src/products";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

function vault(): Record<string, string> {
	return {
		"Shops/AH.md": ["---", "pantry: shop", "---", "", "## Shelves", "", "- Voorraadkast", ""].join("\n"),
		"Products/Water.md": [
			"---",
			"pantry: ignore",
			"minimum: 3",
			"aliases:",
			"  - kokend water",
			"---",
			"",
		].join("\n"),
		"Products/Rijst.md": [
			"---",
			"minimum: 1",
			"unit: pak",
			"size: 500 g",
			"shop: AH",
			"storage: Voorraadkast",
			"shelf: Voorraadkast",
			"---",
			"",
		].join("\n"),
		"Recipes/Rijstschotel.md": [
			"---",
			"servings: 4",
			"---",
			"",
			"## Ingredients",
			"",
			"- 500 g [[Rijst]]",
			"- 600 ml water",
			"- 240 ml kokend water",
			"",
			"## Steps",
			"",
			"1. Koken.",
			"",
		].join("\n"),
		"Meal plans/2026-W35.md": [
			"---",
			"pantry: plan",
			"week: 2026-W35",
			"---",
			"",
			"## Wednesday 2026-08-26",
			"",
			"- Dinner: [[Rijstschotel]]",
			"",
		].join("\n"),
	};
}

test("een genegeerd product vraagt nergens om", async () => {
	const h = makeHarness(vault());
	await h.rebuild(WEEK);

	const water = h.plugin.products.all().find((p) => p.name === "Water");
	assert.ok(water, "de notitie is wel gewoon een product");
	assert.equal(water.ignored, true);

	// Geen winkel, geen schap, geen eenheid — en toch niets te vragen.
	assert.deepEqual(missingFields(water), []);

	// Ook niet op de boodschappenlijst, wat er ook in `minimum` staat.
	const list = await h.list(WEEK);
	const buckets = h.plugin.lists.buckets(list);
	assert.equal(buckets.buy.some((p) => p.name === "Water"), false);
	assert.equal(buckets.unsure.some((p) => p.name === "Water"), false);
});

test("de regels ervoor gelden niet als onopgelost", async () => {
	const h = makeHarness(vault());
	await h.rebuild(WEEK);
	await h.plugin.cleanup.rebuild();

	// Niet onbekend: de alias vangt "kokend water" op.
	assert.deepEqual(h.plugin.cleanup.missing(), []);
	// En niet "telt nog steeds niet mee": dat is een antwoord, geen probleem.
	assert.deepEqual(
		h.plugin.cleanup.stubborn().map((i) => i.product.name),
		[]
	);
});
