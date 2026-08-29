/**
 * Hernoemen is waar links stilletjes doodgaan.
 *
 * Obsidian werkt zijn eigen links bij, maar niet die in een code block — en het
 * weekplan staat in een ```meal-plan-fence. Wat daar misgaat meldt zich nooit:
 * de maaltijd stopt gewoon met meetellen voor de boodschappenlijst.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run() {
	const h = makeHarness(loadFixture("hernoemen"), {
		meals: [{ id: "dinner", name: "Dinner" }],
	});
	await h.rebuild(WEEK);
	return h;
}

test("een hernoemd recept blijft meetellen voor de lijst", async () => {
	const h = await run();
	assert.equal(h.plugin.needs.get(h.plugin.products.byPath("Products/Rijst.md")!), 2);

	// Zoals Obsidian het doet: de notitie krijgt een andere naam.
	const oud = h.vault.read("Recipes/Rijstschotel.md");
	h.vault.files.delete("Recipes/Rijstschotel.md");
	h.vault.write("Recipes/Rijst met groenten.md", oud);

	const notes = await h.plugin.plans.renameRecipe("Rijstschotel", "Rijst met groenten");
	assert.equal(notes, 1);
	assert.match(h.vault.read("Meal plans/2026-W35.md"), /\[\[Rijst met groenten\]\]/);

	await h.rebuild(WEEK);
	assert.equal(
		h.plugin.needs.get(h.plugin.products.byPath("Products/Rijst.md")!),
		2,
		"nog steeds twee pakken"
	);
});

test("een hernoemde winkel neemt zijn producten mee", async () => {
	const h = await run();
	assert.equal(h.plugin.products.byPath("Products/Rijst.md")!.shop, "Lidl");

	const oud = h.vault.read("Shops/Lidl.md");
	h.vault.files.delete("Shops/Lidl.md");
	h.vault.write("Shops/Aldi.md", oud);
	await h.plugin.shops.build();

	const changed = await h.plugin.products.renameShop("Lidl", "Aldi");
	assert.equal(changed, 1);
	assert.equal(h.plugin.products.byPath("Products/Rijst.md")!.shop, "Aldi");
	// En als wikilink weggeschreven, zodat Obsidian hem voortaan zelf bijwerkt.
	assert.match(h.vault.read("Products/Rijst.md"), /^shop: '?\[\[Aldi\]\]'?$/m);
});

test("een kale winkelnaam uit een oudere notitie wordt gewoon gelezen", async () => {
	const h = await run();
	assert.equal(h.plugin.products.byPath("Products/Rijst.md")!.shop, "Lidl");
});

test("used staat als leesbare link in het weekplan", async () => {
	// M41: `Products/Rijst.md: 0.33` zegt een mens niets, en Obsidian werkt dat
	// pad bij hernoemen niet bij.
	const h = await run();
	const week = await h.plugin.plans.load(WEEK);
	const entry = week.days[0].meals[0].recipes[0];
	entry.status = "eaten";
	entry.used = { "Products/Rijst.md": 0.334 };
	await h.plugin.plans.save(WEEK, week);

	assert.match(h.vault.read("Meal plans/2026-W35.md"), /'\[\[Rijst\]\]': 0\.334 pak/);

	// En het leest terug als getal, ook met de eenheid erachter.
	const again = await h.plugin.plans.load(WEEK);
	assert.equal(again.days[0].meals[0].recipes[0].used?.["[[Rijst]]"], 0.334);
});

test("een verdwenen product bij het terugboeken wordt gemeld", async () => {
	const { returnToStock } = await import("../src/consume");
	const h = await run();

	const change = await returnToStock(h.plugin, { "[[Bestaat niet]]": 2 });
	assert.deepEqual(change.unsure, ["Bestaat niet"]);
});
