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
	assert.deepEqual(change.used, { "Products/Rijst.md": 2 });

	const rijst = h.plugin.products.byPath("Products/Rijst.md")!;
	assert.equal(rijst.count, 0, "er stond er één, dus verder dan nul kan niet");
	assert.equal(rijst.check, true, "de boekhouding klopte al niet — vraag het na");

	// En het staat ook echt in de notitie, niet alleen in het geheugen.
	assert.match(h.vault.read("Products/Rijst.md"), /^count: 0$/m);
});

test(
	"undo zet terug wat er echt af ging, niet wat er gevraagd werd",
	{ todo: "H1 — consume.ts:118/90 telt 1 − 2 = 0, en undo maakt er 2 van" },
	async () => {
		const h = makeHarness(loadFixture("afboeken"));
		h.plugin.products.build();

		const amounts = await consumptionOf(h.plugin, entry("[[Rijstschotel]]"));
		await takeFromStock(h.plugin, amounts);

		const change = await returnToStock(h.plugin, { "Products/Rijst.md": 2 });
		void change;

		const rijst = h.plugin.products.byPath("Products/Rijst.md")!;
		assert.equal(
			rijst.count,
			1,
			"er stond er één, er ging er één af, dus er komt er één terug"
		);
	}
);

test(
	"stuks uit een verpakking worden verpakkingen, geen stuks",
	{ todo: "H4 — needs.ts:56 zet de tak zonder eenheid vóór de verpakkingsgrootte" },
	async () => {
		const h = makeHarness(loadFixture("eieren"));
		h.plugin.products.build();

		const amounts = await consumptionOf(h.plugin, entry("[[Omelet]]"));
		assert.equal(
			amounts.get("Products/Eieren.md"),
			1,
			"zes eieren uit een doos van zes is één doos, niet zes dozen"
		);
	}
);
