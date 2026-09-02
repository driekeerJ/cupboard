/**
 * Een product kan bij meerdere winkels liggen. Dit gaat over de vorm waarin
 * dat in de notitie belandt, want die notitie is van de gebruiker: één winkel
 * moet er precies zo uit blijven zien als hij altijd was.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { missingFields } from "../../src/products";
import { makeHarness } from "../harness/plugin";

const SHOP = ["---", "pantry: shop", "---", "", "## Shelves", "", "- Droogwaren"].join("\n");

function vault(shopLine: string) {
	return makeHarness({
		"Shops/AH.md": SHOP,
		"Shops/Lidl.md": SHOP,
		"Products/Ui.md": ["---", "minimum: 2", "unit: stuk", shopLine, "---", ""].join("\n"),
	});
}

async function load(shopLine: string) {
	const h = vault(shopLine);
	h.plugin.products.build();
	await h.plugin.shops.build();
	return h;
}

test("één winkel als losse waarde is een lijst van één", async () => {
	const h = await load("shop: Lidl");
	assert.deepEqual(h.plugin.products.byPath("Products/Ui.md")?.shops, ["Lidl"]);
});

test("een wikilink wordt de winkelnaam", async () => {
	const h = await load('shop: "[[Lidl]]"');
	assert.deepEqual(h.plugin.products.byPath("Products/Ui.md")?.shops, ["Lidl"]);
});

test("een lijst blijft een lijst, in de volgorde waarin hij staat", async () => {
	const h = vault("shop: [AH, Lidl]");
	h.plugin.products.build();
	await h.plugin.shops.build();
	assert.deepEqual(h.plugin.products.byPath("Products/Ui.md")?.shops, ["AH", "Lidl"]);
});

test("één winkel wordt weer als losse waarde weggeschreven", async () => {
	// Anders wordt elke bestaande productnotitie omgegooid zodra je er iets
	// anders in wijzigt, en dat is een diff die niemand heeft gevraagd.
	const h = await load("shop: Lidl");
	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	await h.plugin.products.update(ui, { shops: ["AH"] });
	assert.match(h.vault.read("Products/Ui.md"), /^shop: '?\[\[AH\]\]'?$/m);
});

test("twee winkels worden een lijst", async () => {
	const h = await load("shop: Lidl");
	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	await h.plugin.products.update(ui, { shops: ["AH", "Lidl"] });
	const note = h.vault.read("Products/Ui.md");
	assert.match(note, /shop:\n\s+- '?\[\[AH\]\]'?\n\s+- '?\[\[Lidl\]\]'?/);
});

test("een winkel zonder notitie blijft een kale naam", async () => {
	const h = await load("shop: Lidl");
	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	await h.plugin.products.update(ui, { shops: ["Buurtwinkel"] });
	assert.match(h.vault.read("Products/Ui.md"), /^shop: Buurtwinkel$/m);
});

test("hernoemen raakt alleen die ene winkel en houdt de volgorde", async () => {
	const h = vault("shop: [AH, Lidl]");
	h.plugin.products.build();
	await h.plugin.shops.build();
	assert.equal(await h.plugin.products.renameShop("AH", "Albert Heijn"), 1);
	assert.deepEqual(h.plugin.products.byPath("Products/Ui.md")?.shops, [
		"Albert Heijn",
		"Lidl",
	]);
});

test("geen winkel telt als ontbrekend gegeven", async () => {
	const h = await load('shop: ""');
	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	assert.ok(missingFields(ui).includes("shop"));
});
