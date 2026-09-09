/**
 * Boodschappenlijsten: één per keer boodschappen doen, naast elkaar.
 *
 * De regels die hier vastgelegd worden komen uit Jeroens antwoorden van
 * 2026-09-08:
 *
 * - het minimum van een product telt alleen op een lijst met die winkel;
 * - een lijst zonder winkels vraagt alleen wat haar maaltijden vragen;
 * - een maaltijd zit in hooguit één lijst;
 * - wat al op een eerdere lijst staat, staat op de latere als herinnering;
 * - een ingrediënt dat niet in de winkels van de lijst ligt is een
 *   waarschuwing, geen regel;
 * - de lijst zet haar boodschappenmoment in het weekplan en verhuist mee
 *   als je haar winkels of datum verandert.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { isOverdue, listLabel, mealKey } from "../src/shopping-list";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const HOUSEHOLD = [
	{ id: "jeroen", name: "Jeroen", portionFactor: 1 },
	{ id: "kind", name: "Kind", portionFactor: 0.5 },
];
const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const DINNER = { date: "2026-08-26", meal: "Dinner", recipe: "Rijst met ui" };

async function run() {
	const harness = makeHarness(loadFixture("week-basis"), { household: HOUSEHOLD });
	await harness.rebuild(WEEK);
	return harness;
}

const product = (h: Awaited<ReturnType<typeof run>>, name: string) =>
	h.plugin.products.byPath(`Products/${name}.md`)!;

test("het minimum telt alleen voor de winkels op de lijst", async () => {
	// Olijfolie ligt bij Albert Heijn en heeft een minimum. Op een Lidl-lijst
	// zonder maaltijden heeft die niets te zoeken — niet in de check, niet op
	// de lijst. Ui ligt bij de Lidl en zit onder zijn minimum: die wel.
	const h = await run();
	const lidl = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(lidl);

	assert.equal(h.plugin.lists.minimumOf(lidl, product(h, "Olijfolie")), 0);
	assert.equal(h.plugin.lists.relevant(lidl, product(h, "Olijfolie")), false);
	assert.equal(h.plugin.lists.amount(lidl, product(h, "Ui")), 2, "minimum 2, in huis 0");
	assert.equal(h.plugin.lists.relevant(lidl, product(h, "Ui")), true);
	assert.equal(h.plugin.lists.amount(lidl, product(h, "Passata")), 0, "minimum 0 en geen maaltijd");

	const note = h.note(lidl);
	assert.match(note, /- \[ \] \[\[Ui\]\] · 2 stuk/);
	assert.doesNotMatch(note, /Olijfolie/);
	assert.doesNotMatch(note, /Passata/);
	assert.equal(listLabel(lidl), "Lidl · Tue 25 Aug");
});

test("een lijst zonder winkels vraagt alleen wat de maaltijden vragen", async () => {
	const h = await run();
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: [], meals: [DINNER] });
	assert.ok(list);

	// Ui: minimum 2 telt niet, het recept vraagt 1 (0,75 omhoog), in huis 0.
	assert.equal(h.plugin.lists.amount(list, product(h, "Ui")), 1);
	// Rijst: minimum 1 telt niet, recept vraagt 1, in huis 1 → niets.
	assert.equal(h.plugin.lists.amount(list, product(h, "Rijst")), 0);
	assert.equal(listLabel(list), "Meals · Tue 25 Aug");
	// Gegroepeerd op de voorkeurswinkel van het product.
	assert.match(h.note(list), /## Lidl\n\n### Groente\n\n- \[ \] \[\[Ui\]\] · 1 stuk/);
});

test("een maaltijd zit in hooguit één lijst", async () => {
	const h = await run();
	const first = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [DINNER] });
	assert.ok(first);

	const claimed = h.plugin.lists.claimedMeals();
	assert.equal(claimed.get(mealKey(DINNER))?.path, first.path);
	// Hoofdletters en haakjes maken geen andere maaltijd.
	assert.equal(
		claimed.get(mealKey({ date: "2026-08-26", meal: "dinner", recipe: "[[Rijst met ui]]" }))?.path,
		first.path
	);
});

test("wat al op een eerdere lijst staat, staat op de latere als herinnering", async () => {
	// Ui is nodig voor de maaltijd (Lidl, dinsdag) én zit onder zijn minimum
	// (AH-lijst van woensdag, want ui ligt bij allebei). De AH-lijst telt hem
	// niet mee zolang de Lidl-lijst hem nog niet heeft.
	const h = await run();
	await h.plugin.products.update(product(h, "Ui"), { shops: ["Lidl", "AH"] });
	const lidl = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [DINNER] });
	const ah = await h.plugin.lists.create({ date: "2026-08-26", arrival: null, shops: ["AH"], meals: [] });
	assert.ok(lidl && ah);

	const before = h.plugin.lists.buckets(ah);
	assert.deepEqual(before.buy.map((item) => item.name), []);
	assert.deepEqual(before.elsewhere.map((item) => [item.product.name, listLabel(item.list)]), [
		["Ui", "Lidl · Tue 25 Aug"],
	]);
	assert.match(h.note(ah), /## On another list\n\n- \[\[Ui\]\] — Lidl · Tue 25 Aug/);

	// Gekocht bij de Lidl: dan is er thuis genoeg, en de AH-lijst zwijgt.
	await h.plugin.lists.markBought(lidl, product(h, "Ui"));
	await h.plugin.lists.refresh(ah);
	const after = h.plugin.lists.buckets(ah);
	assert.deepEqual(after.elsewhere, []);
	assert.doesNotMatch(h.note(ah), /Ui/);

	// De Lidl-lijst weggegooid: de AH-lijst neemt het over.
	await h.plugin.lists.undoBought(lidl, product(h, "Ui"));
	await h.plugin.lists.discard(lidl);
	await h.plugin.lists.refresh(ah);
	assert.deepEqual(h.plugin.lists.buckets(ah).buy.map((item) => item.name), ["Ui"]);
});

test("een ingrediënt dat niet in deze winkels ligt is een waarschuwing", async () => {
	// Passata ligt alleen bij de Lidl. Op een AH-lijst met de maaltijd erop
	// staat hij niet op de lijst, maar apart eronder.
	const h = await run();
	const ah = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["AH"], meals: [DINNER] });
	assert.ok(ah);

	const buckets = h.plugin.lists.buckets(ah);
	assert.deepEqual(buckets.buy, []);
	assert.deepEqual(buckets.notHere.map((item) => item.name).sort(), ["Passata", "Ui"]);
	assert.match(h.note(ah), /## Not at these shops\n\n- \[\[Passata\]\] · 1 pak — Lidl\n- \[\[Ui\]\] · 1 stuk — Lidl/);
});

test("wat niet in deze winkels ligt wordt wél geteld", async () => {
	// Tellen doe je thuis: dat een maaltijd om Passata vraagt terwijl je naar
	// de AH gaat, verandert niets aan de vraag of je hem nog hebt. Blijkt van
	// wel, dan valt de waarschuwing weg.
	const h = await run();
	const ah = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["AH"], meals: [DINNER] });
	assert.ok(ah);

	assert.equal(h.plugin.lists.relevant(ah, product(h, "Passata")), true);
	// Olijfolie ligt evenmin in deze winkel, maar geen maaltijd vraagt erom:
	// die blijft weg. Alleen wat gevraagd wordt komt erbij, niet de hele kast.
	assert.equal(h.plugin.lists.relevant(ah, product(h, "Olijfolie")), false);

	await h.plugin.products.update(product(h, "Passata"), { count: "plus" });
	await h.plugin.lists.refresh(ah);
	assert.deepEqual(h.plugin.lists.buckets(ah).notHere.map((item) => item.name), ["Ui"]);
	assert.doesNotMatch(h.note(ah), /Passata/);
	// Geteld en genoeg, maar de vraag blijft: hij hoort in de check te blijven
	// staan, zodat een correctie meteen kan.
	assert.equal(h.plugin.lists.relevant(ah, product(h, "Passata")), true);
});

test("deze keer overslaan: niet tellen, niet kopen, en de volgende lijst mag hem hebben", async () => {
	// Lopend naar de Lidl: alleen het hoognodige. Ui gaat deze keer niet mee.
	// Hij blijft in de voorraadcheck staan (in het blok onderaan), staat niet
	// op de lijst, en de AH-lijst van een dag later pakt hem gewoon op — want
	// overgeslagen is niet gehaald.
	const h = await run();
	await h.plugin.products.update(product(h, "Ui"), { shops: ["Lidl", "AH"] });
	const lidl = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [DINNER] });
	const ah = await h.plugin.lists.create({ date: "2026-08-26", arrival: null, shops: ["AH"], meals: [] });
	assert.ok(lidl && ah);
	const buying = (list: typeof lidl) =>
		h.plugin.lists.buckets(list).buy.map((item) => item.name);
	assert.deepEqual(buying(lidl), ["Passata", "Rijst", "Ui"]);

	await h.plugin.lists.setSkipped(lidl, product(h, "Ui"), true);
	assert.equal(h.plugin.lists.isSkipped(lidl, product(h, "Ui")), true);
	assert.equal(h.plugin.lists.relevant(lidl, product(h, "Ui")), true, "blijft in de check");
	assert.deepEqual(buying(lidl), ["Passata", "Rijst"]);
	assert.doesNotMatch(h.note(lidl), /- \[ \] \[\[Ui\]\]/);
	assert.match(h.note(lidl), /^skipped:\n {2}- '\[\[Ui\]\]'$/m);

	await h.plugin.lists.refresh(ah);
	const later = h.plugin.lists.buckets(ah);
	assert.deepEqual(later.elsewhere, []);
	assert.deepEqual(later.buy.map((item) => item.name), ["Ui"]);

	// De keuze staat in de notitie, dus hij overleeft een herlezing.
	h.vault.write(lidl.path, h.note(lidl));
	await h.plugin.lists.syncFromNote(h.vault.vault.getFileByPath(lidl.path)!);
	assert.equal(h.plugin.lists.isSkipped(lidl, product(h, "Ui")), true);

	// Toch meenemen: alles terug zoals het was.
	await h.plugin.lists.setSkipped(lidl, product(h, "Ui"), false);
	assert.deepEqual(buying(lidl), ["Passata", "Rijst", "Ui"]);
	assert.doesNotMatch(h.note(lidl), /^skipped:/m);
	await h.plugin.lists.refresh(ah);
	assert.deepEqual(h.plugin.lists.buckets(ah).elsewhere.map((item) => item.product.name), ["Ui"]);
});

test("overslaan wat hier toch al niet ligt haalt ook de waarschuwing weg", async () => {
	// Naar de AH voor de rijst-maaltijd; Passata ligt bij de Lidl en staat
	// dus onder "Not at these shops". Sla je hem over, dan is dat de keuze
	// en hoeft de lijst er niet meer over te beginnen.
	const h = await run();
	const ah = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["AH"], meals: [DINNER] });
	assert.ok(ah);
	assert.match(h.note(ah), /## Not at these shops\n\n- \[\[Passata\]\]/);

	await h.plugin.lists.setSkipped(ah, product(h, "Passata"), true);
	assert.deepEqual(h.plugin.lists.buckets(ah).notHere.map((item) => item.name), ["Ui"]);
	assert.doesNotMatch(h.note(ah), /\[\[Passata\]\] ·/);
});

test("de lijst verhuist mee met haar winkels en datum, met het mandje", async () => {
	const h = await run();
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(list);
	await h.plugin.lists.markBought(list, product(h, "Ui"));
	const was = list.path;

	await h.plugin.lists.update(list, {
		date: "2026-08-27",
		arrival: { meal: "Dinner", when: "after" },
		shops: ["Lidl", "AH"],
		meals: [],
	});

	assert.equal(list.path, "Pantry/Shopping/2026-08-27 Lidl · AH.md");
	assert.equal(h.vault.files.has(was), false, "de oude notitie is weg");
	assert.equal(list.basket.has("Products/Ui.md"), true, "het mandje blijft");
	assert.match(h.note(list), /^arrives: after Dinner$/m);

	// Het boodschappenmoment is meeverhuisd.
	const plan = await h.plugin.plans.load(WEEK);
	assert.equal(plan.days.find((day) => day.date === "2026-08-25")?.shopping, undefined);
	assert.deepEqual(plan.days.find((day) => day.date === "2026-08-27")?.shopping, [
		{ shop: "Lidl", meal: "Dinner", when: "after" },
		{ shop: "AH", meal: "Dinner", when: "after" },
	]);
});

test("klaar laat het boodschappenmoment staan; een verstreken datum valt op", async () => {
	const h = await run();
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(list);
	assert.equal(isOverdue(list, new Date(2026, 7, 25)), false, "vandaag is niet te laat");
	assert.equal(isOverdue(list, new Date(2026, 7, 26)), true);

	await h.plugin.lists.finish(list);
	assert.equal(h.plugin.lists.all().length, 0);
	assert.equal(h.vault.files.has(list.path), false);
	const plan = await h.plugin.plans.load(WEEK);
	assert.deepEqual(plan.days.find((day) => day.date === "2026-08-25")?.shopping, [{ shop: "Lidl" }]);
});

test("een maaltijd die je met de hand in de frontmatter zet telt mee", async () => {
	const h = await run();
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(list);
	assert.equal(h.plugin.lists.amount(list, product(h, "Passata")), 0);

	const note = h.note(list).replace(
		"shops:\n  - '[[Lidl]]'\n",
		"shops:\n  - '[[Lidl]]'\nmeals:\n  - date: 2026-08-26\n    meal: Dinner\n    recipe: '[[Rijst met ui]]'\n"
	);
	h.vault.write(list.path, note);
	await h.plugin.lists.syncFromNote(h.vault.vault.getFileByPath(list.path)!);

	assert.deepEqual(list.meals, [DINNER]);
	assert.equal(h.plugin.lists.amount(list, product(h, "Passata")), 1);
	assert.match(h.note(list), /\[\[Passata\]\] · 1 pak/);
});

test("een gegeten maaltijd is geen maaltijd meer op de lijst", async () => {
	const h = await run();
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: [], meals: [DINNER] });
	assert.ok(list);
	assert.equal(h.plugin.lists.amount(list, product(h, "Ui")), 1);

	await h.plugin.plans.update(WEEK, (plan) => {
		const entry = plan.days[0]?.meals[0]?.recipes[0];
		assert.ok(entry);
		entry.status = "eaten";
	});
	await h.plugin.lists.refresh(list);

	assert.equal(h.plugin.lists.amount(list, product(h, "Ui")), 0);
	assert.deepEqual(await h.plugin.lists.liveMeals(list), []);
	assert.match(h.note(list), /Nothing needed\./);
});
