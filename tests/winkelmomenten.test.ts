/**
 * Het geval waarvoor de boodschappenmomenten bestaan.
 *
 * Woensdag 2 september loop je naar de Lidl. De AH-bestelling van diezelfde
 * woensdag komt vrijdag ná het avondeten binnen. Alles wat je vóór dat moment
 * op tafel moet zetten, kan dus niet van de AH komen — hoe nadrukkelijk het
 * product ook `shop: AH` zegt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { atMidnight } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";
import { assignmentFor } from "../src/list";

const HOUSEHOLD = [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }];
/** Woensdag 2 september 2026: de dag waarop hij bestelt. */
const VANDAAG = atMidnight(new Date(2026, 8, 2));

async function run(days = 7) {
	const harness = makeHarness(loadFixture("winkelmomenten"), {
		household: HOUSEHOLD,
		horizonDays: days,
	});
	harness.plugin.products.build();
	await harness.plugin.shops.build();
	await harness.plugin.needs.rebuild(VANDAAG, days);
	await harness.plugin.list.write();
	return harness;
}

const product = (h: Awaited<ReturnType<typeof run>>, name: string) =>
	h.plugin.products.byPath(`Products/${name}.md`)!;

test("de horizon leest over de weekgrens heen", async () => {
	// Rijst staat in week 36, linzen in week 37. Een lijst die op zondag stopt
	// mist de helft van waar hij vandaag voor bestelt.
	const h = await run();
	assert.equal(h.plugin.needs.get(product(h, "Rijst")), 1);
	assert.equal(h.plugin.needs.get(product(h, "Linzen")), 1, "volgende week dinsdag");
});

test("een kortere horizon knipt de tweede week er weer af", async () => {
	const h = await run(3);
	assert.equal(h.plugin.needs.get(product(h, "Linzen")), 0);
});

test("rijst voor woensdagavond verhuist van de AH naar de Lidl", async () => {
	// De AH-bezorging valt pas vrijdag na het avondeten.
	const h = await run();
	const move = assignmentFor(h.plugin, product(h, "Rijst"));
	assert.equal(move.shop, "Lidl");
	assert.equal(move.movedFrom, "AH");
	assert.equal(move.late, false);
});

test("linzen voor volgende week dinsdag blijven bij de AH", async () => {
	const h = await run();
	const stay = assignmentFor(h.plugin, product(h, "Linzen"));
	assert.equal(stay.shop, "AH");
	assert.equal(stay.movedFrom, undefined);
});

test("de boodschappennotitie zet ze onder de juiste kop, met de reden erbij", async () => {
	const h = await run();
	const note = h.groceries();
	const lidl = note.indexOf("## Lidl");
	const ah = note.indexOf("## AH");
	assert.ok(lidl >= 0 && ah >= 0, note);
	// De winkel waar je het eerst bent, staat bovenaan.
	assert.ok(lidl < ah, note);
	assert.ok(note.indexOf("[[Rijst]]") > lidl && note.indexOf("[[Rijst]]") < ah, note);
	assert.ok(note.indexOf("[[Linzen]]") > ah, note);
	assert.match(note, /\[\[Rijst\]\].*needed before AH arrives/);
});

test("zonder boodschappenmomenten blijft alles bij zijn eigen winkel", async () => {
	// De regressietest die telt: een plan van vóór deze functie mag niets
	// merken van het bestaan ervan.
	const files = loadFixture("winkelmomenten");
	const plan = files["Meal plans/2026-W36.md"] ?? "";
	files["Meal plans/2026-W36.md"] = plan
		.split("\n")
		.filter((line) => !/shopping:|shop: (Lidl|AH)|before: Lunch|after: Dinner/.test(line))
		.join("\n");

	const h = makeHarness(files, { household: HOUSEHOLD, horizonDays: 7 });
	h.plugin.products.build();
	await h.plugin.shops.build();
	await h.plugin.needs.rebuild(VANDAAG, 7);

	assert.equal(assignmentFor(h.plugin, product(h, "Rijst")).shop, "AH");
});
