/**
 * Losse boodschappen: wat je onderweg bedenkt en wat geen product is.
 *
 * De regels die hier vastgelegd worden:
 *
 * - een los regeltje staat in de winkel en op het schap die jij kiest, tussen
 *   je gewone boodschappen, en niet in een apart hoekje onderaan;
 * - het overleeft een herstart, want het staat in `Pantry/shopping.json`;
 * - afvinken is wissen — er is geen voorraad om naar terug te vallen, dus er
 *   blijft ook niets achter om op te ruimen;
 * - de notitie is nog steeds een spiegel: een vinkje dat je dáár zet doet
 *   hetzelfde als een vinkje in het scherm.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { groupForShopping } from "../src/list";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run(files?: Record<string, string>) {
	const harness = makeHarness({ ...loadFixture("week-basis"), ...files });
	await harness.rebuild(WEEK);
	await harness.plugin.list.write();
	return harness;
}

test("een los regeltje komt in de gekozen winkel en op het gekozen schap", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	const note = h.groceries();
	assert.match(note, /## Lidl/);
	assert.match(note, /- \[ \] Batterijen · 2/);

	// Onder het schap dat je koos, en niet onder "Other".
	const droogwaren = note.slice(note.indexOf("### Droogwaren"));
	const volgende = droogwaren.slice(3).indexOf("\n### ");
	const blok = volgende === -1 ? droogwaren : droogwaren.slice(0, volgende + 3);
	assert.match(blok, /Batterijen/);
});

test("zonder winkel valt het regeltje in de restcategorie, niet weg", async () => {
	const h = await run();
	await h.plugin.list.addExtra({ name: "Bloemen", amount: 1, shop: "", shelf: "" });

	const note = h.groceries();
	assert.match(note, /## Anywhere/);
	assert.match(note, /- \[ \] Bloemen$/m, "één stuk krijgt geen · 1 achter zich");
});

test("een winkel waar alleen een los regeltje voor is, krijgt toch een kopje", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Kaartje",
		amount: 1,
		shop: "Bruna",
		shelf: "",
	});

	const groups = groupForShopping(
		h.plugin,
		h.plugin.list.buckets().buy,
		h.plugin.list.extras
	);
	const bruna = groups.find((group) => group.shop === "Bruna");
	assert.ok(bruna, "Bruna staat op de lijst, ook zonder producten");
	assert.equal(bruna.items.length, 0);
	assert.deepEqual(
		bruna.shelves.map((shelf) => shelf.shelf),
		["Other"]
	);
	assert.equal(bruna.shelves[0]?.extras[0]?.name, "Kaartje");
});

test("hoofdletters maken er geen tweede winkel of schap van", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Kroepoek",
		amount: 1,
		shop: "lidl",
		shelf: "droogwaren",
	});

	const note = h.groceries();
	assert.equal(note.match(/^## Lidl$/gm)?.length, 1, "één Lidl-kopje");
	assert.equal(note.match(/^### Droogwaren$/gm)?.length, 1, "één schapkopje");
	assert.match(note, /Kroepoek/);
});

test("het regeltje overleeft een herstart", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	const state = JSON.parse(h.vault.read("Pantry/shopping.json")) as {
		extras: { name: string; amount: number; shop: string; shelf: string }[];
	};
	assert.equal(state.extras.length, 1);
	assert.equal(state.extras[0]?.name, "Batterijen");

	// Een verse start op hetzelfde bestand: de telefoon, of Obsidian opnieuw.
	const later = makeHarness(h.vault.snapshot());
	await later.rebuild(WEEK);
	await later.plugin.list.loadState();

	assert.equal(later.plugin.list.extras.length, 1);
	assert.equal(later.plugin.list.extras[0]?.shelf, "Droogwaren");
});

test("afvinken is wissen: er blijft niets in het mandje achter", async () => {
	const h = await run();
	const extra = await h.plugin.list.addExtra({
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});
	assert.ok(extra);

	await h.plugin.list.removeExtra(extra.id);

	assert.equal(h.plugin.list.extras.length, 0);
	const note = h.groceries();
	assert.equal(note.includes("Batterijen"), false, "ook niet onder In the basket");
});

test("een vinkje in de notitie haalt het regeltje van de lijst", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	const getikt = h
		.groceries()
		.replace("- [ ] Batterijen · 2", "- [x] Batterijen · 2");
	h.vault.write(h.plugin.list.path(), getikt);

	await h.plugin.list.syncFromNote();

	assert.equal(h.plugin.list.extras.length, 0);
	assert.equal(h.groceries().includes("Batterijen"), false);
});

test("een handgeschreven regel die niets van ons is blijft met rust", async () => {
	const h = await run();
	await h.plugin.list.addExtra({
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	// Een afgevinkt regeltje buiten het blok, over iets dat wij niet kennen.
	const note = `${h.groceries()}\n- [x] briefje voor de slager\n`;
	h.vault.write(h.plugin.list.path(), note);

	await h.plugin.list.syncFromNote();

	assert.equal(h.plugin.list.extras.length, 1, "onze eigen regel blijft staan");
	assert.match(h.groceries(), /briefje voor de slager/);
});

test("onzin in het rondebestand wordt overgeslagen, de rest niet", async () => {
	const h = await run({
		"Pantry/shopping.json": JSON.stringify({
			version: 1,
			extras: [
				{ id: "a", name: "  ", amount: 2, shop: "Lidl", shelf: "" },
				{ id: "b", name: "Bloemen", amount: -4, shop: 7, shelf: null },
				"dit is geen regel",
				{ name: "Kaartje", amount: 1.6, shop: "Bruna", shelf: "Papier" },
			],
		}),
	});
	await h.plugin.list.loadState();

	const extras = h.plugin.list.extras;
	assert.equal(extras.length, 2, "de naamloze en de niet-objecten vallen af");
	assert.equal(extras[0]?.name, "Bloemen");
	assert.equal(extras[0]?.amount, 1, "een onmogelijk aantal wordt er één");
	assert.equal(extras[0]?.shop, "", "een winkel die geen tekst is telt niet");
	assert.ok(extras[1]?.id, "een regel zonder id krijgt er een");
	assert.equal(extras[1]?.amount, 2, "1,6 wordt afgerond");
});

test("een lege lijst met alleen een los regeltje is geen lege lijst", async () => {
	const h = makeHarness({
		"Shops/Lidl.md": ["# Lidl", "", "## Looproute", "", "- Groente", ""].join("\n"),
		"Products/Ui.md": [
			"---",
			"minimum: 0",
			"unit: stuk",
			"shop: Lidl",
			"shelf: Groente",
			"count: 3",
			"---",
			"",
		].join("\n"),
	});
	await h.rebuild(WEEK);
	await h.plugin.list.write();
	// Niets nodig, dus er wordt niet eens een notitie aangemaakt.
	assert.equal(h.vault.files.has(h.plugin.list.path()), false);

	await h.plugin.list.addExtra({ name: "Bloemen", amount: 1, shop: "", shelf: "" });
	const note = h.groceries();
	assert.equal(note.includes("Nothing needed."), false);
	assert.match(note, /- \[ \] Bloemen/);
});
