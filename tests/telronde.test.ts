/**
 * Meerdere winkelbezoeken, één telronde.
 *
 * Jeroens antwoorden van 2026-11-18: hij gaat woensdag naar de Lidl en vrijdag
 * naar de Albert Heijn, wil daar twee gewone lijsten voor, en wil één keer
 * tellen. Elke lijst toont alleen wat je bij díe winkel haalt:
 *
 * - een product komt op de lijst van zijn primaire winkel — de eerste in de
 *   productnotitie — en niet meer op de vroegste lijst;
 * - tenzij een maaltijd het nodig heeft voordat die winkel in huis is: dan
 *   mag de volgende winkel uit de notitie het overnemen;
 * - dat geldt ook over lijsten heen: een maaltijd op de AH-lijst kan iets
 *   vragen dat de Lidl-lijst haalt;
 * - is niemand op tijd, dan blijft het een waarschuwing.
 *
 * Het scenario staat in tests/fixtures/twee-ritten: curry met feta op
 * donderdag (Lidl-lijst), taco's op zaterdag (AH-lijst).
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { PANTRY_FORMAT, ROUND_FORMAT, WIDE_FORMAT } from "../src/format";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const AH = "Albert Heijn";
const CURRY = { date: "2026-08-27", meal: "Dinner", recipe: "Curry met feta" };
const TACOS = { date: "2026-08-29", meal: "Dinner", recipe: "Tacos" };

async function run() {
	const h = makeHarness(loadFixture("twee-ritten"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	const lists = h.plugin.lists;
	const lidl = await lists.create({
		date: "2026-08-26", arrival: null, shops: ["Lidl"], staples: ["Lidl"], meals: [CURRY],
	});
	const ah = await lists.create({
		date: "2026-08-28", arrival: null, shops: [AH], staples: [AH], meals: [TACOS],
	});
	assert.ok(lidl && ah);
	await lists.refreshAll();
	return { h, lists, lidl, ah };
}

type Run = Awaited<ReturnType<typeof run>>;
const product = (r: Run, name: string) => r.h.plugin.products.byPath(`Products/${name}.md`)!;
const names = (items: { name: string }[]) => items.map((item) => item.name).sort();

test("de primaire winkel wint, ook als een andere lijst eerder is", async () => {
	// Olijfolie: eerst AH, dan Lidl, en alleen onder zijn minimum. Tot 1.4
	// pakte de Lidl-lijst hem, alleen omdat woensdag vóór vrijdag komt.
	const r = await run();
	const olie = product(r, "Olijfolie");

	assert.equal(r.lists.placement(olie).owner, r.ah);
	assert.ok(r.lists.buckets(r.ah).unsure.includes(olie) || r.lists.buckets(r.ah).buy.includes(olie));
	assert.deepEqual(
		r.lists.buckets(r.lidl).elsewhere.filter((row) => row.product === olie).map((row) => row.list),
		[r.ah],
		"op de Lidl-lijst alleen als herinnering"
	);

	// Ui is andersom: eerst Lidl. Die blijft waar hij was.
	assert.equal(r.lists.placement(product(r, "Ui")).owner, r.lidl);
});

test("een maaltijd die niet kan wachten gaat naar de winkel die wel op tijd is", async () => {
	// Kokosmelk: eerst AH. Maar de curry is donderdag en de AH komt vrijdag.
	const r = await run();
	const kokos = product(r, "Kokosmelk");
	assert.equal(r.lists.placement(kokos).owner, r.lidl);
	assert.equal(r.lists.shopFor(r.lidl, kokos), "Lidl");
	assert.ok(r.lists.buckets(r.lidl).buy.includes(kokos));
	assert.doesNotMatch(r.h.note(r.ah), /Kokosmelk/);

	// Schuift de AH naar woensdag, dan is zij op tijd en wint de voorkeur weer.
	await r.lists.update(r.ah, { date: "2026-08-26", arrival: null, shops: [AH], staples: [AH], meals: [TACOS] });
	await r.lists.refreshAll();
	assert.equal(r.lists.placement(kokos).owner, r.ah);
});

test("wat een latere lijst vraagt kan op een eerdere lijst komen", async () => {
	// Tortilla's liggen alleen bij de Lidl; de taco's staan op de AH-lijst.
	// Dat was een waarschuwing op de AH-lijst. Je gaat woensdag naar de Lidl.
	const r = await run();
	const tortilla = product(r, "Tortilla");

	assert.equal(r.lists.placement(tortilla).owner, r.lidl);
	assert.equal(r.lists.amount(r.lidl, tortilla), 1, "wat de AH-lijst vraagt, niet de nul van de Lidl-lijst zelf");
	assert.equal(r.lists.relevant(r.lidl, tortilla), true, "en dus ook in haar voorraadcheck");
	assert.match(r.h.note(r.lidl), /- \[ \] \[\[Tortilla\]\] · 1 stuk/);

	const ah = r.lists.buckets(r.ah);
	assert.deepEqual(names(ah.notHere), []);
	assert.deepEqual(ah.elsewhere.filter((row) => row.product === tortilla).map((row) => row.list), [r.lidl]);
});

test("wie het haalt, haalt het voor alle lijsten samen", async () => {
	// Ui: minimum 2, en de taco's van zaterdag vragen er nog 2. De Lidl-lijst
	// haalt ze allemaal, want na het afvinken staat ui op '+' en vraagt de
	// AH-lijst er niet meer om.
	const r = await run();
	const ui = product(r, "Ui");
	assert.equal(r.lists.amount(r.lidl, ui), 4);
	assert.equal(r.lists.need(r.lidl, ui), 4);

	await r.lists.markBought(r.lidl, ui);
	await r.lists.refreshAll();
	assert.equal(r.lists.placement(ui).owner, null);
	assert.doesNotMatch(r.h.note(r.ah), /\[\[Ui\]\]/);
});

test("is geen winkel op tijd, dan blijft het een waarschuwing", async () => {
	// Feta ligt alleen bij de AH en de curry is donderdag.
	const r = await run();
	const feta = product(r, "Feta");

	const placed = r.lists.placement(feta);
	assert.equal(placed.owner, null);
	assert.equal(placed.late, true);
	assert.deepEqual(names(r.lists.buckets(r.lidl).notHere), ["Feta"]);
	assert.match(r.h.note(r.lidl), /## Not at these shops\n\n- \[\[Feta\]\]/);
	assert.doesNotMatch(r.h.note(r.ah), /Feta/, "en het verhuist niet stilletjes naar vrijdag");
});

test("een te late lijst die het toch houdt is geen geruststelling", async () => {
	// Krijgt feta een minimum, dan vraagt de AH-lijst er zelf ook om en houdt
	// ze hem. Voor de curry van donderdag blijft dat te laat.
	const r = await run();
	const feta = product(r, "Feta");
	await r.h.plugin.products.update(feta, { minimum: 1 });
	await r.lists.refreshAll();

	assert.equal(r.lists.placement(feta).owner, r.ah);
	assert.equal(r.lists.ownerOf(r.lidl, feta), null);
	assert.deepEqual(names(r.lists.buckets(r.lidl).notHere), ["Feta"]);
});

test("overslaan op de ene lijst geeft het terug aan de andere", async () => {
	const r = await run();
	const tortilla = product(r, "Tortilla");
	await r.lists.setSkipped(r.lidl, tortilla, true);
	await r.lists.refreshAll();

	assert.equal(r.lists.placement(tortilla).owner, null);
	assert.deepEqual(names(r.lists.buckets(r.ah).notHere), ["Tortilla"]);
});

test("met één lijst verandert er niets", async () => {
	const h = makeHarness(loadFixture("twee-ritten"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	const ah = await h.plugin.lists.create({
		date: "2026-08-28", arrival: null, shops: [AH], staples: [AH], meals: [TACOS],
	});
	assert.ok(ah);
	const buckets = h.plugin.lists.buckets(ah);
	assert.deepEqual(names(buckets.notHere), ["Tortilla"]);
	assert.deepEqual(names([...buckets.buy, ...buckets.unsure]), ["Olijfolie", "Ui"]);
	assert.match(h.note(ah), new RegExp(`^format: ${WIDE_FORMAT}$`, "m"));
});

test("lijsten die elkaars boodschappen verdelen dragen het formaat dat dat kent", async () => {
	// Een build van vóór de gedeelde verdeling zou dezelfde twee notities
	// anders invullen dan deze; die mag er dan niet aan komen.
	const r = await run();
	assert.equal(ROUND_FORMAT, PANTRY_FORMAT);
	assert.match(r.h.note(r.lidl), new RegExp(`^format: ${ROUND_FORMAT}$`, "m"));
	assert.match(r.h.note(r.ah), new RegExp(`^format: ${ROUND_FORMAT}$`, "m"));

	// Blijft er één over, dan leest elke build haar weer goed.
	await r.lists.finish(r.lidl);
	await r.lists.refreshAll();
	assert.match(r.h.note(r.ah), new RegExp(`^format: ${WIDE_FORMAT}$`, "m"));
});
