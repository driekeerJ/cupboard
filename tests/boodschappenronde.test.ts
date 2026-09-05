/**
 * De boodschappenronde: wat je déze keer haalt, los van het weekplan.
 *
 * De regels die hier vastgelegd worden:
 *
 * - zonder ronde volgt de lijst het weekplan, precies zoals daarvoor;
 * - een winkel in de ronde brengt de producten mee die daar liggen én een
 *   minimum hebben — de "standaard boodschappen" — en niets van andere winkels;
 * - een recept in de ronde telt zijn ingrediënten, geschaald op de porties,
 *   en negeert intussen het minimum van producten uit winkels die niet meedoen;
 * - recept én winkel samen tellen op;
 * - de ronde overleeft een herstart en verdwijnt als je hem wist;
 * - de notitie zegt dat er een ronde staat.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { parseRound, roundLabel } from "../src/round";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const RECIPE = "Recipes/Rijst met ui.md";

async function run() {
	const harness = makeHarness(loadFixture("week-basis"));
	await harness.rebuild(WEEK);
	await harness.plugin.list.write();
	return harness;
}

/** De regel voor dit product in de notitie, of null als hij er niet staat. */
function lineFor(note: string, product: string): string | null {
	const match = new RegExp(`^- \\[ \\] \\[\\[${product}\\]\\].*$`, "m").exec(note);
	return match ? match[0] : null;
}

test("zonder ronde volgt de lijst het weekplan", async () => {
	const h = await run();
	assert.equal(h.plugin.list.hasRound(), false);
	const note = h.groceries();
	assert.ok(lineFor(note, "Ui"), "het weekplan vraagt om ui");
	assert.ok(lineFor(note, "Passata"), "en om passata");
	assert.equal(note.includes("Shopping round"), false);
});

test("alleen de Lidl: de producten met een minimum die daar liggen, en verder niets", async () => {
	const h = await run();
	await h.plugin.list.setRound({ recipes: [], shops: ["Lidl"] });

	const note = h.groceries();
	assert.match(note, /Shopping round: Lidl/);
	// Ui: minimum 2, telling 0 — de vaste voorraad van de Lidl.
	assert.equal(lineFor(note, "Ui"), "- [ ] [[Ui]] · 2 stuk");
	// Passata heeft minimum 0 en het weekplan telt niet mee: niet op de lijst.
	assert.equal(lineFor(note, "Passata"), null);
	// Olijfolie ligt bij Albert Heijn: die winkel doet niet mee.
	assert.equal(note.includes("Olijfolie"), false);
	assert.equal(note.includes("## Albert Heijn"), false);
});

test("alleen een recept: de ingrediënten, geschaald, zonder minimums van buiten de ronde", async () => {
	const h = await run();
	await h.plugin.list.setRound({
		recipes: [{ path: RECIPE, servings: 4 }],
		shops: [],
	});

	const note = h.groceries();
	assert.match(note, /Shopping round: Rijst met ui/);
	// 500 ml passata voor 4, verpakking 500 ml, telling 0 → 1 pak.
	assert.equal(lineFor(note, "Passata"), "- [ ] [[Passata]] · 1 pak");
	// 2 uien, telling 0 → 2. Het minimum van 2 telt hier niet nog eens mee.
	assert.equal(lineFor(note, "Ui"), "- [ ] [[Ui]] · 2 stuk");
	// 500 g rijst = 1 pak, telling 1: genoeg. Het minimum van 1 doet niet mee,
	// want de Lidl zit niet in de ronde.
	assert.equal(lineFor(note, "Rijst"), null);
});

test("de porties schalen het recept", async () => {
	const h = await run();
	await h.plugin.list.setRound({
		recipes: [{ path: RECIPE, servings: 8 }],
		shops: [],
	});

	const note = h.groceries();
	assert.equal(lineFor(note, "Passata"), "- [ ] [[Passata]] · 2 pak");
	assert.equal(lineFor(note, "Ui"), "- [ ] [[Ui]] · 4 stuk");
});

test("recept én winkel tellen op", async () => {
	const h = await run();
	await h.plugin.list.setRound({
		recipes: [{ path: RECIPE, servings: 4 }],
		shops: ["Lidl"],
	});

	const note = h.groceries();
	assert.match(note, /Shopping round: Rijst met ui · Lidl/);
	// Rijst: minimum 1 + 1 pak voor het recept − 1 in huis = 1.
	assert.equal(lineFor(note, "Rijst"), "- [ ] [[Rijst]] · 1 pak");
	// Ui: minimum 2 + 2 voor het recept − 0 = 4.
	assert.equal(lineFor(note, "Ui"), "- [ ] [[Ui]] · 4 stuk");
});

test("het minimum van een product buiten de ronde is even 0", async () => {
	const h = await run();
	const olijfolie = h.plugin.products.match("Olijfolie");
	const rijst = h.plugin.products.match("Rijst");
	assert.ok(olijfolie && rijst);

	assert.equal(h.plugin.needs.minimumOf(olijfolie), 1);
	await h.plugin.list.setRound({ recipes: [], shops: ["lidl"] });
	assert.equal(h.plugin.needs.minimumOf(olijfolie), 0, "Albert Heijn doet niet mee");
	assert.equal(h.plugin.needs.minimumOf(rijst), 1, "hoofdletters maken geen andere winkel");
});

test("de ronde overleeft een herstart en verdwijnt als je hem wist", async () => {
	const h = await run();
	await h.plugin.list.setRound({
		recipes: [{ path: RECIPE, servings: 3.5 }],
		shops: ["Lidl"],
	});

	const later = makeHarness(h.vault.snapshot());
	await later.plugin.list.loadState();
	await later.rebuild(WEEK);
	assert.equal(later.plugin.list.hasRound(), true);
	assert.equal(later.plugin.list.round?.recipes[0]?.servings, 3.5);
	assert.deepEqual(later.plugin.list.round?.shops, ["Lidl"]);

	await later.plugin.list.clearRound();
	assert.equal(later.plugin.list.hasRound(), false);
	// `clearRound` leest het plan vanaf vandaag; het scenario speelt in week 35.
	await later.rebuild(WEEK);
	await later.plugin.list.write();
	const note = later.groceries();
	assert.equal(note.includes("Shopping round"), false);
	assert.ok(lineFor(note, "Passata"), "het weekplan geldt weer");
});

test("een lege of kapotte ronde is geen ronde", () => {
	assert.equal(parseRound(null), null);
	assert.equal(parseRound({ recipes: [], shops: [] }), null);
	assert.equal(parseRound({ recipes: "nee", shops: 3 }), null);
	assert.equal(parseRound({ recipes: [{ path: "" }], shops: [" "] }), null);

	const round = parseRound({
		recipes: [
			{ path: RECIPE, servings: "veel" },
			{ path: RECIPE, servings: 2 },
			{ path: "Recipes/Soep.md", servings: 0 },
		],
		shops: ["Lidl", "lidl", "", "AH"],
	});
	assert.ok(round);
	// Een portie die niet klopt wordt rechtgezet, het recept blijft.
	assert.deepEqual(round.recipes, [
		{ path: RECIPE, servings: 1 },
		{ path: "Recipes/Soep.md", servings: 0.5 },
	]);
	assert.deepEqual(round.shops, ["Lidl", "AH"]);
	assert.equal(roundLabel(round, (path) => path.split("/").pop() ?? path),
		"Rijst met ui.md · Soep.md · Lidl · AH");
});
