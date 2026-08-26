/**
 * Het portieveld in een receptnotitie heet niet overal hetzelfde.
 *
 * Losse test omdat het misgaan hier onzichtbaar is: een gemiste sleutel valt
 * terug op factor 1, en dan klopt de hele boodschappenlijst niet zonder dat
 * er ergens iets rood wordt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { consumptionOf } from "../../src/consume";
import { loadFixture } from "./../harness/fixtures";
import { makeHarness } from "./../harness/plugin";

const HOUSEHOLD = [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }];

test("een andere sleutel dan de ingestelde wordt herkend", async () => {
	// R7. Het recept zegt `Porties: 4` — hoofdletter, en niet het ingestelde
	// `servings`. Zonder aliassen schaalt hij niet en vraagt één portie om de
	// hele kilo rijst.
	const h = makeHarness(loadFixture("porties"), { household: HOUSEHOLD });
	h.plugin.products.build();

	const amounts = await consumptionOf(h.plugin, {
		recipe: "[[Nasi]]",
		eaters: ["Jeroen"],
		guests: 0,
	});

	// 1 kg voor 4 personen, gekookt voor 1 → 250 g → een half pak van 500 g.
	assert.equal(amounts.get("Products/Rijst.md"), 0.5);
});
