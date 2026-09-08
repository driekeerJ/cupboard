/**
 * Losse boodschappen: wat je onderweg bedenkt en wat geen product is.
 *
 * De regels die hier vastgelegd worden:
 *
 * - een los regeltje staat in de winkel en op het schap die jij kiest, tussen
 *   je gewone boodschappen, en niet in een apart hoekje onderaan;
 * - het hoort bij één lijst en overleeft een herstart, want het staat in de
 *   frontmatter van die lijst;
 * - afvinken is wissen — er is geen voorraad om naar terug te vallen, dus er
 *   blijft ook niets achter om op te ruimen;
 * - de notitie is nog steeds een spiegel: een vinkje dat je dáár zet doet
 *   hetzelfde als een vinkje in het scherm.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run(files?: Record<string, string>) {
	const harness = makeHarness({ ...loadFixture("week-basis"), ...files });
	await harness.rebuild(WEEK);
	const list = await harness.list(WEEK, { shops: ["Lidl"] });
	return { ...harness, list };
}

test("een los regeltje komt in de gekozen winkel en op het gekozen schap", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, {
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	const note = h.note(h.list);
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
	await h.plugin.lists.addExtra(h.list, { name: "Bloemen", amount: 1, shop: "", shelf: "" });

	const note = h.note(h.list);
	assert.match(note, /## Anywhere/);
	assert.match(note, /- \[ \] Bloemen$/m, "één stuk krijgt geen · 1 achter zich");
});

test("een winkel waar alleen een los regeltje voor is, krijgt toch een kopje", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, { name: "Kaartje", amount: 1, shop: "Bruna", shelf: "" });

	const groups = h.plugin.lists.groups(h.list, h.plugin.lists.buckets(h.list).buy);
	const bruna = groups.find((group) => group.shop === "Bruna");
	assert.ok(bruna, "Bruna staat op de lijst, ook zonder producten");
	assert.equal(bruna.items.length, 0);
	assert.deepEqual(bruna.shelves.map((shelf) => shelf.shelf), ["Other"]);
	assert.equal(bruna.shelves[0]?.extras[0]?.name, "Kaartje");
});

test("hoofdletters maken er geen tweede winkel of schap van", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, {
		name: "Kroepoek",
		amount: 1,
		shop: "lidl",
		shelf: "droogwaren",
	});

	const note = h.note(h.list);
	assert.equal(note.match(/^## Lidl$/gm)?.length, 1, "één Lidl-kopje");
	assert.equal(note.match(/^### Droogwaren$/gm)?.length, 1, "één schapkopje");
	assert.match(note, /Kroepoek/);
});

test("het regeltje overleeft een herstart", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, {
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});
	assert.match(h.note(h.list), /^extras:\n {2}- id: x\w+\n {4}name: Batterijen\n {4}amount: 2\n {4}shop: Lidl\n {4}shelf: Droogwaren$/m);

	// Een verse start op dezelfde vault: de telefoon, of Obsidian opnieuw.
	const later = makeHarness(h.vault.snapshot());
	await later.rebuild(WEEK);
	await later.plugin.lists.refreshAll();

	const list = later.plugin.lists.byPath(h.list.path);
	assert.ok(list);
	assert.equal(list.extras.length, 1);
	assert.equal(list.extras[0]?.shelf, "Droogwaren");
});

test("afvinken is wissen: er blijft niets in het mandje achter", async () => {
	const h = await run();
	const extra = await h.plugin.lists.addExtra(h.list, {
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});
	assert.ok(extra);

	await h.plugin.lists.removeExtra(h.list, extra.id);

	assert.equal(h.list.extras.length, 0);
	assert.equal(h.note(h.list).includes("Batterijen"), false, "ook niet onder In the basket");
});

test("een vinkje in de notitie haalt het regeltje van de lijst", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, {
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	const getikt = h.note(h.list).replace("- [ ] Batterijen · 2", "- [x] Batterijen · 2");
	h.vault.write(h.list.path, getikt);

	await h.plugin.lists.syncFromNote(h.vault.vault.getFileByPath(h.list.path)!);

	assert.equal(h.list.extras.length, 0);
	assert.equal(h.note(h.list).includes("Batterijen"), false);
});

test("een handgeschreven regel die niets van ons is blijft met rust", async () => {
	const h = await run();
	await h.plugin.lists.addExtra(h.list, {
		name: "Batterijen",
		amount: 2,
		shop: "Lidl",
		shelf: "Droogwaren",
	});

	// Een afgevinkt regeltje buiten het blok, over iets dat wij niet kennen.
	const note = `${h.note(h.list)}\n- [x] briefje voor de slager\n`;
	h.vault.write(h.list.path, note);

	await h.plugin.lists.syncFromNote(h.vault.vault.getFileByPath(h.list.path)!);

	assert.equal(h.list.extras.length, 1, "onze eigen regel blijft staan");
	assert.match(h.note(h.list), /briefje voor de slager/);
});

test("onzin in de frontmatter wordt overgeslagen, de rest niet", async () => {
	const h = await run({
		"Pantry/Shopping/2026-08-24 Lidl.md": [
			"---",
			"pantry: shopping",
			"date: 2026-08-24",
			"shops:",
			"  - '[[Lidl]]'",
			"extras:",
			"  - { id: a, name: '  ', amount: 2, shop: Lidl, shelf: '' }",
			"  - { id: b, name: Bloemen, amount: -4, shop: 7, shelf: null }",
			"  - dit is geen regel",
			"  - { name: Kaartje, amount: 1.6, shop: Bruna, shelf: Papier }",
			"---",
			"",
			"# Lidl · Mon 24 Aug",
			"",
		].join("\n"),
	});
	// `run` maakte zelf ook een lijst; die kreeg een volgnummer omdat het pad bezet was.
	assert.equal(h.list.path, "Pantry/Shopping/2026-08-24 Lidl 2.md");
	await h.plugin.lists.refreshAll();
	const list = h.plugin.lists.byPath("Pantry/Shopping/2026-08-24 Lidl.md");
	assert.ok(list);

	const extras = list.extras;
	assert.equal(extras.length, 2, "de naamloze en de niet-objecten vallen af");
	assert.equal(extras[0]?.name, "Bloemen");
	assert.equal(extras[0]?.amount, 1, "een onmogelijk aantal wordt er één");
	assert.equal(extras[0]?.shop, "", "een winkel die geen tekst is telt niet");
	assert.ok(extras[1]?.id, "een regel zonder id krijgt er een");
	assert.equal(extras[1]?.amount, 2, "1,6 wordt afgerond");
});

test("een lijst met alleen een los regeltje is geen lege lijst", async () => {
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
	const list = await h.list(WEEK);
	assert.match(h.note(list), /Nothing needed\./);

	await h.plugin.lists.addExtra(list, { name: "Bloemen", amount: 1, shop: "", shelf: "" });
	const note = h.note(list);
	assert.equal(note.includes("Nothing needed."), false);
	assert.match(note, /- \[ \] Bloemen/);
});
