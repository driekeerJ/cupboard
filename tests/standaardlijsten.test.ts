/**
 * Standaardlijsten los van waar je heen gaat, en een schap per winkel.
 *
 * Jeroens vraag van 2026-11-11: in een drukke week gaat hij alleen naar de
 * Albert Heijn en haalt hij de Lidl-boodschappen daar ook. Met twee lijsten
 * stond hij twee keer voor dezelfde kast. Dus:
 *
 * - een lijst zegt apart waar je heen gaat (`shops`) en van welke winkels de
 *   standaard boodschappen meegaan (`staples`);
 * - wat zo in een andere winkel belandt krijgt daar zijn gewone schap als die
 *   winkel dat schap ook heeft, en staat anders onderaan onder "No shelf at …";
 * - een schap toewijzen in die winkel is een uitzondering op het product
 *   (`shelves`), en maakt die winkel géén vaste winkel van het product.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { STAPLES_FORMAT, WIDE_FORMAT } from "../src/format";
import { placeAt, shelfAt } from "../src/products";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const AH = "Albert Heijn";

/** week-basis, met een Albert Heijn die een eigen looproute heeft. */
async function run(extra: Record<string, string> = {}) {
	const h = makeHarness(
		{
			...loadFixture("week-basis"),
			[`Shops/${AH}.md`]: `# ${AH}\n\n## Shelves\n\n- Brood\n- Oliën\n- Koekjes\n`,
			...extra,
		},
		{ household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }] }
	);
	await h.rebuild(WEEK);
	return h;
}

const product = (h: Awaited<ReturnType<typeof run>>, name: string) =>
	h.plugin.products.byPath(`Products/${name}.md`)!;

const draft = (shops: string[], staples: string[]) => ({
	date: "2026-08-25",
	arrival: null,
	shops,
	staples,
	meals: [],
});

test("de standaardlijst van de Lidl gaat mee naar de Albert Heijn", async () => {
	// Ui ligt alleen bij de Lidl en zit onder zijn minimum. Op een AH-lijst
	// die de Lidl-lijst meeneemt is dat gewoon een boodschap, geen waarschuwing.
	const h = await run();
	const list = await h.plugin.lists.create(draft([AH], ["Lidl", AH]));
	assert.ok(list);

	assert.equal(h.plugin.lists.minimumOf(list, product(h, "Ui")), 2);
	assert.equal(h.plugin.lists.amount(list, product(h, "Ui")), 2);
	assert.equal(h.plugin.lists.shopFor(list, product(h, "Ui")), AH);

	const { buy, notHere } = h.plugin.lists.buckets(list);
	assert.ok(buy.includes(product(h, "Ui")));
	assert.deepEqual(notHere, []);
	// Het boodschappenmoment is waar je heen gaat, niet wat je meeneemt.
	assert.equal(list.path, `Cupboard/Shopping/2026-08-25 ${AH}.md`);
});

test("zonder de Lidl-lijst blijft een AH-lijst wat hij was", async () => {
	const h = await run();
	const list = await h.plugin.lists.create(draft([AH], [AH]));
	assert.ok(list);
	assert.equal(h.plugin.lists.minimumOf(list, product(h, "Ui")), 0);
	assert.doesNotMatch(h.note(list), /Ui/);
	assert.doesNotMatch(h.note(list), /staples/);
	assert.match(h.note(list), new RegExp(`^format: ${WIDE_FORMAT}$`, "m"));
});

test("een schap dat de andere winkel niet heeft staat onderaan, met de winkel in de kop", async () => {
	// "Groente" staat niet op de route van de AH; "Oliën" wel.
	const h = await run();
	const list = await h.plugin.lists.create(draft([AH], ["Lidl", AH]));
	assert.ok(list);
	await h.plugin.products.update(product(h, "Olijfolie"), { count: 0 });
	await h.plugin.lists.refresh(list);

	const [group] = h.plugin.lists.groups(list, h.plugin.lists.buckets(list).buy);
	assert.ok(group);
	assert.deepEqual(
		group.shelves.map((shelf) => [shelf.shelf, shelf.unplaced, shelf.items.map((item) => item.name)]),
		[
			["Oliën", false, ["Olijfolie"]],
			[`No shelf at ${AH}`, true, ["Ui"]],
		]
	);
	assert.match(h.note(list), new RegExp(`### No shelf at ${AH}\\n\\n- \\[ \\] \\[\\[Ui\\]\\] · 2 stuk`));
});

test("hetzelfde schap in de andere winkel is meteen een plek", async () => {
	const h = await run({
		[`Shops/${AH}.md`]: `# ${AH}\n\n## Shelves\n\n- Groente\n- Oliën\n`,
	});
	const list = await h.plugin.lists.create(draft([AH], ["Lidl"]));
	assert.ok(list);
	const [group] = h.plugin.lists.groups(list, h.plugin.lists.buckets(list).buy);
	assert.deepEqual(group?.shelves.map((shelf) => shelf.shelf), ["Groente"]);
});

test("een schap toewijzen is een uitzondering voor die ene winkel", async () => {
	const h = await run();
	const list = await h.plugin.lists.create(draft([AH], ["Lidl"]));
	assert.ok(list);
	const ui = product(h, "Ui");

	await h.plugin.products.update(ui, placeAt(ui, AH, "Brood"));
	await h.plugin.lists.refresh(list);

	assert.equal(shelfAt(ui, AH), "Brood");
	assert.equal(shelfAt(ui, "Lidl"), "Groente", "bij de Lidl ligt hij waar hij lag");
	assert.deepEqual(ui.shops, ["Lidl"], "en de AH is er geen vaste winkel van geworden");
	assert.match(h.vault.read("Products/Ui.md"), /^shelf: Groente$/m);
	assert.match(h.vault.read("Products/Ui.md"), new RegExp(`^shelves:\\n  ${AH}: Brood$`, "m"));

	const [group] = h.plugin.lists.groups(list, h.plugin.lists.buckets(list).buy);
	assert.deepEqual(group?.shelves.map((shelf) => [shelf.shelf, shelf.unplaced]), [["Brood", false]]);

	// Een gewone AH-lijst vraagt er daarna nog steeds niet om.
	const plain = await h.plugin.lists.create({ ...draft([AH], [AH]), date: "2026-08-27" });
	assert.ok(plain);
	assert.equal(h.plugin.lists.minimumOf(plain, ui), 0);
});

test("de uitzondering overleeft een herstart en verdwijnt als hij niets meer zegt", async () => {
	const h = await run();
	const ui = product(h, "Ui");
	await h.plugin.products.update(ui, placeAt(ui, AH, "Koekjes"));

	h.plugin.products.build();
	const again = product(h, "Ui");
	assert.deepEqual(again.shelfOverrides, { [AH]: "Koekjes" });

	// Terug naar het gewone schap: dan is er geen uitzondering meer nodig.
	await h.plugin.products.update(again, placeAt(again, AH, "Groente"));
	assert.deepEqual(again.shelfOverrides, {});
	assert.doesNotMatch(h.vault.read("Products/Ui.md"), /shelves/);
});

test("een product zonder schap krijgt het toegewezen schap als gewoon schap", () => {
	assert.deepEqual(placeAt({ shelf: "", shelfOverrides: {} }, AH, "Brood"), {
		shelf: "Brood",
		shelfAt: { shop: AH, shelf: "" },
	});
});

test("een winkel hernoemen neemt de uitzondering mee", async () => {
	const h = await run();
	const ui = product(h, "Ui");
	await h.plugin.products.update(ui, placeAt(ui, AH, "Brood"));

	assert.equal(await h.plugin.products.renameShop(AH, "AH"), 2, "Ui (schap) en Olijfolie (winkel)");
	assert.deepEqual(ui.shelfOverrides, { AH: "Brood" });
	assert.deepEqual(ui.shops, ["Lidl"]);
});

test("eigen standaardlijsten staan in de notitie, met het formaat dat ze kent", async () => {
	const h = await run();
	const list = await h.plugin.lists.create(draft([AH], ["Lidl", AH]));
	assert.ok(list);
	const note = h.note(list);
	assert.match(note, new RegExp(`^format: ${STAPLES_FORMAT}$`, "m"));
	assert.match(note, /^staples:\n {2}- '\[\[Lidl\]\]'\n {2}- '\[\[Albert Heijn\]\]'$/m);

	// En ze komen terug zoals ze stonden.
	await h.plugin.lists.refreshAll();
	assert.deepEqual(h.plugin.lists.byPath(list.path)?.staples, ["Lidl", AH]);
	assert.deepEqual(h.plugin.lists.byPath(list.path)?.shops, [AH]);
});

test("geen standaardlijsten is een antwoord, geen ontbrekend veld", async () => {
	// Alleen de maaltijden van deze week, bij de Lidl gehaald.
	const h = await run();
	const list = await h.list(WEEK, { shops: ["Lidl"], staples: [] });
	assert.match(h.note(list), /^staples: \[\]$/m);

	await h.plugin.lists.refreshAll();
	const again = h.plugin.lists.byPath(list.path);
	assert.deepEqual(again?.staples, []);
	assert.equal(h.plugin.lists.minimumOf(list, product(h, "Ui")), 0);
});
