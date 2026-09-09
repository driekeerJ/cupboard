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
import { assignmentFor, lateProducts } from "../src/warnings";

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
	// Rijst staat als [AH, Lidl] genoteerd. De AH-bezorging valt pas vrijdag
	// na het avondeten, dus de tweede winkel neemt het over.
	const h = await run();
	const move = assignmentFor(h.plugin, product(h, "Rijst"));
	assert.equal(move.shop, "Lidl");
	assert.equal(move.movedFrom, "AH");
	assert.equal(move.late, false);
});

test("tahini is alleen bij de AH te krijgen en is dus te laat", async () => {
	// Geen stille verhuizing naar een winkel waar het niet ligt: het blijft
	// bij de AH staan en wordt gemarkeerd, zodat je zelf kunt kiezen.
	const h = await run();
	const stuck = assignmentFor(h.plugin, product(h, "Tahini"));
	assert.equal(stuck.shop, "AH");
	assert.equal(stuck.late, true);
	assert.equal(stuck.movedFrom, undefined);
});

test("een tweede winkel toevoegen lost het op", async () => {
	const h = await run();
	const tahini = product(h, "Tahini");
	await h.plugin.products.update(tahini, { shops: [...tahini.shops, "Lidl"] });
	const fixed = assignmentFor(h.plugin, product(h, "Tahini"));
	assert.equal(fixed.shop, "Lidl");
	assert.equal(fixed.late, false);
});

test("linzen voor volgende week dinsdag blijven bij de AH", async () => {
	const h = await run();
	const stay = assignmentFor(h.plugin, product(h, "Linzen"));
	assert.equal(stay.shop, "AH");
	assert.equal(stay.movedFrom, undefined);
});

test("een Lidl-lijst voor woensdag: rijst erop, tahini als waarschuwing", async () => {
	// De lijst kiest tussen háár winkels. Rijst ligt ook bij de Lidl, dus die
	// komt gewoon op de lijst; tahini ligt alleen bij de AH en wordt geen
	// stille regel maar een waarschuwing — jij kiest wat je ermee doet.
	const h = await run();
	const list = await h.plugin.lists.create({
		date: "2026-09-02",
		arrival: null,
		shops: ["Lidl"],
		meals: [{ date: "2026-09-02", meal: "Dinner", recipe: "Rijstschotel" }],
	});
	assert.ok(list);
	const note = h.note(list);
	const lidl = note.indexOf("## Lidl");
	const notHere = note.indexOf("## Not at these shops");
	assert.ok(lidl >= 0 && notHere >= 0, note);
	assert.ok(note.indexOf("[[Rijst]]") > lidl && note.indexOf("[[Rijst]]") < notHere, note);
	assert.match(note, /^- \[\[Tahini\]\] · .* — AH$/m);
	assert.doesNotMatch(note, /\[\[Linzen\]\]/, "volgende week staat niet op deze lijst");
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
	assert.equal(assignmentFor(h.plugin, product(h, "Tahini")).late, false);
});

// ------------------------------------------------------- de waarschuwing

/** Woensdagavond is maaltijd 2 (Breakfast, Lunch, Dinner). */
const WOENSDAGAVOND = ["2026-09-02", 2] as const;

test("het maaltijdvak meldt wat je er niet op tijd voor in huis hebt", async () => {
	const h = await run();
	const stuck = lateProducts(h.plugin, ...WOENSDAGAVOND);
	assert.deepEqual(
		stuck.map((item) => item.product.name),
		["Tahini"],
		"rijst kan bij de Lidl, tahini nergens op tijd"
	);
	assert.equal(stuck[0]?.shop, "AH");
});

test("een tweede winkel bij het product laat de melding verdwijnen", async () => {
	const h = await run();
	const tahini = product(h, "Tahini");
	await h.plugin.products.update(tahini, { shops: [...tahini.shops, "Lidl"] });
	assert.deepEqual(lateProducts(h.plugin, ...WOENSDAGAVOND), []);
});

test("het al in huis hebben laat de melding ook verdwijnen", async () => {
	// Het andere geldige antwoord: je telt wat er staat.
	const h = await run();
	await h.plugin.products.update(product(h, "Tahini"), { count: 5 });
	assert.deepEqual(lateProducts(h.plugin, ...WOENSDAGAVOND), []);
});

test("een maaltijd die je wél kunt inkopen meldt niets", async () => {
	// Volgende week dinsdag: de AH-bezorging is er dan allang.
	const h = await run();
	assert.deepEqual(lateProducts(h.plugin, "2026-09-08", 2), []);
});

test("een afgevinkte maaltijd vraagt niets meer", async () => {
	const h = await run();
	await h.plugin.plans.update(new Date(2026, 7, 31), (plan) => {
		const entry = plan.days.find((day) => day.date === "2026-09-02")?.meals[0]?.recipes[0];
		assert.ok(entry);
		entry.status = "eaten";
	});
	await h.plugin.needs.rebuild(VANDAAG, 7);
	assert.deepEqual(lateProducts(h.plugin, ...WOENSDAGAVOND), []);
});
