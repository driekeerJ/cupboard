/**
 * Standaardlijsten en het schap per winkel, op het scherm.
 *
 * De regels staan in tests/standaardlijsten.test.ts. Dit zijn de twee
 * schermen waar je ze kiest: de setup-stap van een lijst, en de Shelf-knop
 * in de winkelstap.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../../src/date";
import { ListView } from "../../src/ui/list-view";
import { all, byText, click, text } from "../harness/dom";
import { loadFixture } from "../harness/fixtures";
import { makeScreenHarness } from "../harness/screen";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const AH = "Albert Heijn";

/** week-basis, met een Albert Heijn die een eigen looproute en zoekadres heeft. */
async function run() {
	const h = makeScreenHarness(
		{
			...loadFixture("week-basis"),
			[`Shops/${AH}.md`]:
				`---\nsearch: "https://ah.example/zoeken?query={q}"\n---\n# ${AH}\n\n## Shelves\n\n- Brood\n- Oliën\n- Koekjes\n`,
		},
		{ household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }] }
	);
	await h.rebuild(WEEK);
	return h;
}

/** De keuzerijen van een sectie op de setup-stap, met of ze aan staan. */
function picks(root: HTMLElement, staple: boolean): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	const selector = staple
		? "button.pantry-pick-staple"
		: "button.pantry-pick-row:not(.pantry-pick-staple):not(.pantry-pick-day):not(.pantry-pick-meal)";
	for (const row of all(root, selector)) {
		out[text(row.querySelector(".pantry-pick-name"))] = row.getAttribute("aria-pressed") === "true";
	}
	return out;
}

const pick = (root: HTMLElement, staple: boolean, shop: string) =>
	all(root, staple ? "button.pantry-pick-staple" : "button.pantry-pick-row:not(.pantry-pick-staple)").find(
		(row) => text(row.querySelector(".pantry-pick-name")) === shop
	);

test("de standaardlijsten volgen de winkels tot je ze uit elkaar trekt", async () => {
	const h = await run();
	const { root } = await h.open(ListView, { path: null, step: "setup" });
	assert.deepEqual(picks(root, false), { [AH]: false, Lidl: false });
	assert.deepEqual(picks(root, true), { [AH]: false, Lidl: false });

	// De gewone week: één tik op de winkel neemt haar standaardlijst mee.
	await click(pick(root, false, AH));
	assert.deepEqual(picks(root, true), { [AH]: true, Lidl: false });

	// De drukke week: de Lidl-lijst erbij, zonder erheen te gaan.
	await click(pick(root, true, "Lidl"));
	assert.deepEqual(picks(root, false), { [AH]: true, Lidl: false }, "je gaat nog steeds alleen naar de AH");
	assert.deepEqual(picks(root, true), { [AH]: true, Lidl: true });
	assert.match(
		text(pick(root, true, "Lidl")?.querySelector(".pantry-pick-meta")),
		/^\d+ products? with a minimum · bought at Albert Heijn$/
	);

	// Eenmaal uit elkaar blijven ze uit elkaar: de winkel uitzetten haalt
	// haar standaardlijst niet stiekem ook weg.
	await click(pick(root, false, AH));
	assert.deepEqual(picks(root, true), { [AH]: true, Lidl: true });
});

test("Create list schrijft de keuzes zoals ze op het scherm staan", async () => {
	const h = await run();
	const { root } = await h.open(ListView, { path: null, step: "setup" });
	await click(pick(root, false, AH));
	await click(pick(root, true, "Lidl"));
	await click(byText(root, "button", "Create list"));

	const [list] = h.plugin.lists.all();
	assert.ok(list, "de lijst is aangemaakt");
	assert.deepEqual(list.shops, [AH]);
	assert.deepEqual(list.staples, [AH, "Lidl"]);
	assert.match(h.note(list), /^staples:\n {2}- '\[\[Albert Heijn\]\]'\n {2}- '\[\[Lidl\]\]'$/m);
});

test("een product zonder schap in deze winkel krijgt er één in een tik", async () => {
	// De Lidl-lijst, gehaald bij de AH: ui ligt daar bij "Groente", en dat
	// schap heeft de AH niet.
	const h = await run();
	const list = await h.plugin.lists.create({
		date: "2026-08-25", arrival: null, shops: [AH], staples: ["Lidl"], meals: [],
	});
	assert.ok(list);
	const { root } = await h.open(ListView, { path: list.path, step: "shop" });

	const row = (): HTMLElement | null => root.querySelector('.pantry-buy-row[data-flip="Products/Ui.md"]');
	assert.equal(text(root.querySelector(".pantry-shelf")), `No shelf at ${AH}`);
	assert.equal(text(row()?.querySelector(".pantry-buy-meta")), "Groente at Lidl");

	await click(row()?.querySelector("button.pantry-place"));
	const modal = document.querySelector(".modal-container .modal");
	assert.equal(text(modal?.querySelector(".pantry-sheet-name")), "Ui");
	const options = all(modal!, "button.pantry-sheet-option").map((option) => text(option));
	assert.deepEqual(options.slice(0, 3), ["Brood", "Oliën", "Koekjes"], "de schappen van de AH, in haar volgorde");
	assert.ok(options.includes(`Search at ${AH}`), "en haar zoekpagina, want die staat in de winkelnotitie");

	await click(byText(modal!, "button.pantry-sheet-option", "Brood"));
	assert.equal(document.querySelector(".modal-container"), null, "het venster is dicht");

	const note = h.vault.read("Products/Ui.md");
	assert.match(note, /^shelf: Groente$/m, "het schap bij de Lidl blijft staan");
	assert.match(note, /^shelves:\n {2}Albert Heijn: Brood$/m);
	assert.match(note, /^shop: Lidl$/m, "en de AH is geen vaste winkel geworden");

	assert.equal(text(root.querySelector(".pantry-shelf")), "", "één schap, dus geen kopje meer nodig");
	assert.equal(row()?.querySelector("button.pantry-place"), null);
});
