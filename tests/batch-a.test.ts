/**
 * De rekenkern van batch A, in één scenario.
 *
 * Elk product heeft hier zijn eigen bevinding, zodat de getallen niet door
 * elkaar lopen. Dit is dezelfde set die op 27 augustus in de vault stond om de
 * reparaties met eigen ogen te kunnen zien; hier staat hij als vangnet, zodat
 * niemand er ooit ongemerkt eentje terugdraait.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const HOUSEHOLD = [
	{ id: "me", name: "Jeroen", portionFactor: 1 },
	{ id: "person", name: "Jacorine", portionFactor: 1 },
	{ id: "person-2", name: "Iemand", portionFactor: 0.5 },
];

/** Woensdag 26 augustus 2026; met maandag als weekstart is dat 2026-W35. */
const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run() {
	const harness = makeHarness(loadFixture("zz-test"), {
		household: HOUSEHOLD,
		meals: [{ id: "dinner", name: "Dinner" }],
	});
	await harness.rebuild(WEEK);
	await harness.plugin.list.write();
	return harness;
}

test("batch A: wat de boodschappenlijst van deze week zegt", async () => {
	const h = await run();
	const buy = (name: string) =>
		h.plugin.list.amount(h.plugin.products.byPath(`Products/ZZ Test ${name}.md`)!);

	// H4 — zes eieren uit een doos van zes is één doos. De tak zonder
	// maateenheid stond vóór de verpakkingsgrootte, dus dit werd 6.
	assert.equal(buy("Eieren"), 1);

	// M6 — beide staan onder een subkop binnen de ingrediëntenlijst. Een
	// subkop kapte de lijst af, dus dit recept leverde nul ingrediënten.
	assert.equal(buy("Passata"), 1);
	assert.equal(buy("Ui"), 2);

	// R7 — het recept zegt `Porties: 4`, met hoofdletter en niet het ingestelde
	// veld. Zonder aliassen viel het stil terug op factor 1 en werd dit 2.
	assert.equal(buy("Rijst"), 1);

	// R6 — "1 1/2 kg" werd als 1 gelezen: een onderschatting van een derde die
	// je nergens aan kon zien. 1500 g uit pakken van 500 g is 3.
	assert.equal(buy("Meel"), 3);

	// R5 — "3 zz test preien (in ringen)" heeft geen wikilink; de naam moet de
	// alias raken zonder de bereidingsnoot.
	assert.equal(buy("Prei"), 3);

	// Geen recept vraagt erom en het minimum is 0, dus hier valt niets te kopen.
	assert.equal(buy("Bakpapier"), 0);
	// De gebruiker zei dat de hoeveelheid er niet toe doet.
	assert.equal(buy("Saffraan"), 0);
});

test("batch A: de prei-regel belandt niet in Opruimen", async () => {
	// R5 nog een keer, van de andere kant: zonder het afknippen van de
	// bereidingsnoot matchte de regel niets en kwam hij als onbekend
	// ingrediënt in de opruimlijst.
	const h = await run();
	await h.plugin.cleanup.rebuild();

	assert.deepEqual(h.plugin.cleanup.missing(), []);
	assert.deepEqual(
		h.plugin.cleanup.open().map((issue) => issue.product.name),
		["ZZ Test Kokosmelk"],
		"alleen het product dat echt geen eenheid en geen grootte heeft"
	);
});

test("batch A + H1: afboeken klemt op nul, undo zet precies terug", async () => {
	const h = await run();
	const path = "Products/ZZ Test Bulgur.md";
	const bulgur = () => h.plugin.products.byPath(path)!;

	// Er staat er één en het recept vraagt om twee pakken.
	assert.equal(bulgur().count, 1);

	const { consumptionOf, takeFromStock, returnToStock } = await import("../src/consume");
	const entry = { recipe: "[[ZZ Test Schotel]]", eaters: ["Jeroen"], guests: 0 };

	const amounts = await consumptionOf(h.plugin, entry);
	assert.equal(amounts.get(path), 2, "1 kg uit pakken van 500 g");

	const change = await takeFromStock(h.plugin, amounts);
	assert.deepEqual(change.used, { [path]: 1 }, "er kon er maar één op");
	assert.equal(bulgur().count, 0);
	assert.equal(bulgur().check, true);

	// M2 — een afgeleide stand is geen telling.
	assert.match(h.vault.read(path), /^counted: '?2026-08-01'?$/m);
	assert.doesNotMatch(h.vault.read(path), /^previous:/m);

	await returnToStock(h.plugin, change.used);
	assert.equal(bulgur().count, 1, "precies terug bij af");
});
