/**
 * De winkellink op een product, en het zoekadres op een winkel.
 *
 * Deze twee velden vervingen `ahId` en `ahUrl`, die alleen werkten voor wie
 * bij Albert Heijn boodschappen doet. Wat hier vastligt is dat de plugin geen
 * enkele winkel bij naam kent: een link is een link, en waar je zoekt staat in
 * de winkelnotitie.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const LINK = "https://www.ah.nl/producten/product/wi485568/";

function vault(): Record<string, string> {
	return {
		"Shops/AH.md": [
			"---",
			"pantry: shop",
			'search: "https://www.ah.nl/zoeken?query={q}"',
			"---",
			"",
			"## Shelves",
			"",
			"- Voorraadkast",
			"",
		].join("\n"),
		"Shops/Cactus.md": ["---", "pantry: shop", "---", "", "## Shelves", "", "- Épicerie", ""].join(
			"\n"
		),
		"Products/Appelsap.md": [
			"---",
			"minimum: 1",
			"unit: stuk",
			"shop: AH",
			"storage: Voorraadkast",
			"shelf: Voorraadkast",
			`url: "${LINK}"`,
			"---",
			"",
		].join("\n"),
	};
}

async function run() {
	const h = makeHarness(vault());
	await h.rebuild(WEEK);
	return h;
}

test("de link wordt gelezen zoals hij in de notitie staat", async () => {
	const h = await run();
	assert.equal(h.plugin.products.byPath("Products/Appelsap.md")?.url, LINK);
});

test("een product zonder link heeft een lege link, geen undefined", async () => {
	const h = makeHarness({
		"Products/Zout.md": ["---", "minimum: 1", "unit: potje", "---", ""].join("\n"),
	});
	await h.rebuild(WEEK);
	assert.equal(h.plugin.products.byPath("Products/Zout.md")?.url, "");
});

test("een nieuw product bewaart de link die je meegeeft", async () => {
	const h = await run();
	const file = await h.plugin.products.create("Havermout", {
		shop: "AH",
		unit: "pak",
		minimum: 2,
		url: LINK,
	});
	assert.ok(file);

	h.plugin.products.build();
	const product = h.plugin.products.byPath("Products/Havermout.md");
	assert.equal(product?.url, LINK);
	assert.equal(product?.minimum, 2);
	// De winkel krijgt een wikilink zodra de winkelnotitie bestaat.
	assert.match(h.vault.read("Products/Havermout.md"), /shop: ['"]?\[\[AH\]\]['"]?/);
});

test('"hoeveelheid maakt niet uit" wordt alleen geschreven als het gezegd is', async () => {
	const h = await run();
	await h.plugin.products.create("Kaneel", { unit: "potje", amount: "any" });
	await h.plugin.products.create("Rijst", { unit: "pak" });
	h.plugin.products.build();

	assert.match(h.vault.read("Products/Kaneel.md"), /amount: any/);
	assert.doesNotMatch(h.vault.read("Products/Rijst.md"), /amount:/);
	assert.equal(h.plugin.products.byPath("Products/Kaneel.md")?.amountMatters, false);
});

test("de link kan gewijzigd en gewist worden", async () => {
	const h = await run();
	const product = h.plugin.products.byPath("Products/Appelsap.md");
	assert.ok(product);

	await h.plugin.products.update(product, { url: "https://winkel.lu/sap" });
	assert.equal(product.url, "https://winkel.lu/sap", "meteen in het geheugen, niet pas na build");
	assert.match(h.vault.read("Products/Appelsap.md"), /url: ['"]?https:\/\/winkel\.lu\/sap['"]?/);

	await h.plugin.products.update(product, { url: "" });
	assert.equal(product.url, "");
});

test("het zoekadres komt uit de winkelnotitie", async () => {
	const h = await run();
	assert.equal(
		h.plugin.shops.searchFor("AH", "appelsap"),
		"https://www.ah.nl/zoeken?query=appelsap"
	);
});

test("een winkel zonder zoekadres levert niets op, en dat is geen fout", async () => {
	const h = await run();
	assert.equal(h.plugin.shops.searchFor("Cactus", "riz"), null);
	assert.equal(h.plugin.shops.searchFor("Winkel die niet bestaat", "riz"), null);
});
