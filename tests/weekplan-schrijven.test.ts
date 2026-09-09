/**
 * Het weekplan wordt nooit vanuit een geheugenkopie geschreven.
 *
 * Het scenario van 2026-09-09, in de winkel: de planner op de telefoon had de
 * weeknotitie geladen vóórdat Obsidian Sync de versie van de Mac bracht — een
 * lege week dus. "Maaltijd toevoegen" schreef die lege week plus één maaltijd
 * over alles heen, inclusief het boodschappenmoment dat de boodschappenlijst
 * er had neergezet. Sindsdien is er geen `save(plan)` meer: elke wijziging
 * gaat via `update(week, change)`, en `change` werkt op het plan zoals het
 * **nu** in de notitie staat.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { addRecipe, entryAt, refOf, setShopping, shoppingAt } from "../src/plan";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const PATH = "Meal plans/2026-W35.md";
const DINNER = { id: "dinner", name: "Dinner" };

const GESYNCT = [
	"# Week 35",
	"",
	"```meal-plan",
	"weekStart: 2026-08-24",
	"days:",
	"  - date: 2026-08-26",
	"    shopping:",
	"      - shop: Lidl",
	"        before: Dinner",
	"    meals:",
	"      - meal: Dinner",
	"        recipes:",
	"          - recipe: '[[Rijst met ui]]'",
	"            eaters:",
	"              - Jeroen",
	"            guests: 0",
	"```",
	"",
].join("\n");

test("een maaltijd erbij bewaart wat er intussen van een ander apparaat kwam", async () => {
	// Telefoon: de notitie is er nog niet, de planner toont een lege week.
	const h = makeHarness({});
	const stale = await h.plugin.plans.load(WEEK);
	assert.deepEqual(stale.days, []);

	// Dan brengt Sync de notitie van de Mac: een maaltijd én een boodschappenmoment.
	h.vault.write(PATH, GESYNCT);

	// De gebruiker voegt op de telefoon een maaltijd toe, vanuit het scherm
	// dat nog de lege week toont.
	const written = await h.plugin.plans.update(WEEK, (plan) => {
		addRecipe(plan, "2026-08-27", DINNER, { recipe: "[[Nasi]]", eaters: ["Jeroen"], guests: 0 });
	});

	const after = await h.plugin.plans.load(WEEK);
	assert.equal(after.days.length, 2, "beide dagen staan erin");
	assert.equal(after.days[0]?.meals[0]?.recipes[0]?.recipe, "[[Rijst met ui]]", "de maaltijd van de Mac is er nog");
	assert.deepEqual(shoppingAt(after, "2026-08-26"), [{ shop: "Lidl", meal: "Dinner", when: "before" }], "het boodschappenmoment ook");
	assert.equal(after.days[1]?.meals[0]?.recipes[0]?.recipe, "[[Nasi]]");
	assert.deepEqual(written, after, "update geeft terug wat er geschreven is");
});

test("een wijziging vindt zijn maaltijd op positie, en anders op naam", async () => {
	const h = makeHarness({ [PATH]: GESYNCT });
	const plan = await h.plugin.plans.load(WEEK);
	const entry = plan.days[0]?.meals[0]?.recipes[0];
	assert.ok(entry);
	const ref = refOf("2026-08-26", DINNER, 0, entry);

	// Een ander apparaat zette er intussen een maaltijd vóór.
	await h.plugin.plans.update(WEEK, (fresh) => {
		addRecipe(fresh, "2026-08-26", DINNER, { recipe: "[[Soep]]", eaters: [], guests: 0 }, 0);
	});

	await h.plugin.plans.update(WEEK, (fresh) => {
		const target = entryAt(fresh, ref);
		assert.ok(target, "op index 0 staat nu de soep, maar de rijst is er nog");
		target.status = "eaten";
	});

	const after = await h.plugin.plans.load(WEEK);
	const recipes = after.days[0]?.meals[0]?.recipes ?? [];
	assert.equal(recipes[0]?.recipe, "[[Soep]]");
	assert.equal(recipes[0]?.status, undefined);
	assert.equal(recipes[1]?.recipe, "[[Rijst met ui]]");
	assert.equal(recipes[1]?.status, "eaten");
});

test("een onleesbaar blok is geen lege week: er wordt niets geschreven", async () => {
	const kapot = GESYNCT.replace("    meals:", "    meals: [ dit: is geen yaml");
	const h = makeHarness({ [PATH]: kapot });

	const plan = await h.plugin.plans.load(WEEK);
	assert.ok(plan.unreadable, "gemarkeerd als onleesbaar");
	assert.deepEqual(plan.days, [], "en leeg, want we weten het niet");

	await assert.rejects(
		h.plugin.plans.update(WEEK, (fresh) => setShopping(fresh, "2026-08-27", [{ shop: "AH" }])),
		/not valid YAML/
	);
	assert.equal(h.vault.read(PATH), kapot, "de notitie is niet aangeraakt");
});

test("het boodschappenmoment van een lijst landt in de notitie zoals hij nu is", async () => {
	// De lijst zet haar moment neer terwijl de week op schijf al een maaltijd
	// heeft die de lijst zelf nooit gezien heeft.
	const h = makeHarness(loadFixture("week-basis"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	h.vault.write(PATH, GESYNCT.replace("shopping:\n      - shop: Lidl\n        before: Dinner\n    ", ""));

	const list = await h.plugin.lists.create({ date: "2026-08-27", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(list);

	const after = await h.plugin.plans.load(WEEK);
	assert.equal(after.days[0]?.meals[0]?.recipes[0]?.recipe, "[[Rijst met ui]]");
	assert.deepEqual(shoppingAt(after, "2026-08-27"), [{ shop: "Lidl" }]);

	await h.plugin.lists.discard(list);
	const gone = await h.plugin.plans.load(WEEK);
	assert.equal(gone.days[0]?.meals[0]?.recipes[0]?.recipe, "[[Rijst met ui]]", "Delete laat de maaltijd staan");
	assert.deepEqual(shoppingAt(gone, "2026-08-27"), []);
});
