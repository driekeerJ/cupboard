/**
 * Afboeken en terugboeken over de hele keten.
 *
 * Het scherm doet dit met één tik op "Gegeten": lees het recept, reken elke
 * regel om naar de teleenheid, en schrijf de nieuwe telling in de frontmatter
 * van de productnotitie. Undo moet daarna precies terugzetten wat er af ging —
 * niet meer, want dan maakt de app voorraad die nooit in huis was.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { consumptionOf, returnToStock, takeFromStock } from "../src/consume";
import type { PlannedRecipe } from "../src/types";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

function entry(recipe: string): PlannedRecipe {
	return { recipe, eaters: [], guests: 0 };
}

test("een gegeten maaltijd gaat van de telling af", async () => {
	const h = makeHarness(loadFixture("afboeken"));
	h.plugin.products.build();

	const amounts = await consumptionOf(h.plugin, entry("[[Rijstschotel]]"));
	assert.equal(amounts.get("Products/Rijst.md"), 2, "1 kg uit pakken van 500 g");

	const change = await takeFromStock(h.plugin, amounts);
	// Er stond er één, dus er kon er maar één op. Dat is wat er geboekt wordt.
	assert.deepEqual(change.used, { "Products/Rijst.md": 1 });

	const rijst = h.plugin.products.byPath("Products/Rijst.md")!;
	assert.equal(rijst.count, 0, "er stond er één, dus verder dan nul kan niet");
	assert.equal(rijst.check, true, "de boekhouding klopte al niet — vraag het na");

	// En het staat ook echt in de notitie, niet alleen in het geheugen.
	assert.match(h.vault.read("Products/Rijst.md"), /^count: 0$/m);
});

test("een maaltijd-vinkje doet niet alsof je vandaag geteld hebt", async () => {
	// M2. `counted` moet blijven betekenen: wanneer heb jij voor het laatst
	// gekeken. Een afgeleide stand is geen telling.
	const h = makeHarness(loadFixture("afboeken"));
	h.plugin.products.build();

	await takeFromStock(h.plugin, await consumptionOf(h.plugin, entry("[[Rijstschotel]]")));

	const note = h.vault.read("Products/Rijst.md");
	assert.match(note, /^counted: '?2026-08-24'?$/m, "de teldatum blijft staan");
	assert.doesNotMatch(note, /^previous:/m, "en er wordt geen vorige stand verzonnen");
});

test("undo zet terug wat er echt af ging, niet wat er gevraagd werd", async () => {
	// H1. Er stond er één, de maaltijd vroeg er twee, er ging er één af. Wie
	// de gevraagde twee terugboekt, heeft er na aan- en uitvinken twee staan.
	const h = makeHarness(loadFixture("afboeken"));
	h.plugin.products.build();

	const change = await takeFromStock(
		h.plugin,
		await consumptionOf(h.plugin, entry("[[Rijstschotel]]"))
	);
	await returnToStock(h.plugin, change.used);

	const rijst = h.plugin.products.byPath("Products/Rijst.md")!;
	assert.equal(rijst.count, 1, "precies terug bij af");
});

test("stuks uit een verpakking worden verpakkingen, geen stuks", async () => {
	// H4. Zes eieren uit een doos van zes is één doos. Stond de tak zonder
	// maateenheid vóór de verpakkingsgrootte, dan werd het zes dozen — op de
	// lijst én van de voorraad af.
	const h = makeHarness(loadFixture("eieren"));
	h.plugin.products.build();

	const amounts = await consumptionOf(h.plugin, entry("[[Omelet]]"));
	assert.equal(amounts.get("Products/Eieren.md"), 1);
});

test("een product dat niet geschreven kan worden laat de rest doorgaan", async () => {
	// H3. Klapte de lus halverwege, dan stonden de eerste producten wél
	// afgeboekt terwijl het plan nog "niet gegeten" zei — en boekte de
	// volgende tik ze nog een keer af.
	const h = makeHarness(loadFixture("schrijffout"));
	h.plugin.products.build();
	h.vault.refuseWrites.add("Products/Passata.md");

	const change = await takeFromStock(
		h.plugin,
		await consumptionOf(h.plugin, entry("[[Schotel]]"))
	);

	assert.deepEqual(change.failed, ["Passata"], "en het wordt gemeld");
	assert.deepEqual(
		change.used,
		{ "Products/Rijst.md": 1 },
		"alleen wat écht geschreven is telt mee voor undo"
	);
	assert.equal(h.plugin.products.byPath("Products/Rijst.md")!.count, 2);
	assert.equal(
		h.plugin.products.byPath("Products/Passata.md")!.count,
		3,
		"het mislukte product blijft staan zoals het stond"
	);
});
