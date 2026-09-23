/**
 * De lijstnotitie is de waarheid, ook als twee apparaten er tegelijk aan
 * werken en Obsidian Sync de vault nog niet helemaal gebracht heeft.
 *
 * Twee dingen die op 2026-09-09 mis konden gaan:
 *
 * - een mandje-regel voor een product dat op dít apparaat (nog) niet bestaat
 *   viel stil weg bij het teruglezen, en de eerstvolgende schrijfactie maakte
 *   dat verlies definitief;
 * - een vinkje dat van een ander apparaat kwam werd overschreven door een
 *   schrijfactie vanuit het geheugen van dit apparaat, dat het vinkje nog
 *   niet had verwerkt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const DINNER = { date: "2026-08-26", meal: "Dinner", recipe: "Rijst met ui" };

async function run() {
	const h = makeHarness(loadFixture("week-basis"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [DINNER] });
	assert.ok(list);
	return { h, list };
}

const product = (h: Awaited<ReturnType<typeof run>>["h"], name: string) =>
	h.plugin.products.byPath(`Products/${name}.md`)!;

/** Zet een mandje-regel in de frontmatter, zoals een ander apparaat dat zou doen. */
function withBasket(note: string, lines: string[]): string {
	const extra = ["basket:", ...lines].join("\n");
	return note.replace(/^---\n([\s\S]*?)\n---/, (_all, yaml: string) =>
		`---\n${yaml.includes("\nbasket:") ? yaml.replace("\nbasket:", `\n${extra}\n  # was: basket:`) : `${yaml}\n${extra}`}\n---`
	);
}

test("een mandje-regel voor een onbekend product overleeft het herschrijven", async () => {
	const { h, list } = await run();
	// Van de telefoon: 'Hummus' zit in het mandje, maar Products/Hummus.md is
	// hier nog niet aangekomen.
	h.vault.write(list.path, withBasket(h.note(list), ["  - product: '[[Hummus]]'", "    count: 2"]));
	await h.plugin.lists.refreshAll();

	const known = h.plugin.lists.byPath(list.path);
	assert.ok(known);
	assert.deepEqual(known.unresolved.basket, [{ name: "Hummus", entry: { count: 2, check: false } }]);
	assert.match(h.note(list), /product: '\[\[Hummus\]\]'\n {4}count: 2/, "staat er nog na de spiegel-verversing");

	// Een eigen tik erbij schrijft de notitie opnieuw — en Hummus blijft.
	await h.plugin.lists.markBought(known, product(h, "Ui"));
	assert.match(h.note(list), /\[\[Hummus\]\]/);
	assert.match(h.note(list), /\[\[Ui\]\]'\n {4}count: 0/);

	// Dan komt het product alsnog binnen: het mandje herkent het.
	h.vault.write("Products/Hummus.md", "---\nminimum: 1\nunit: bakje\nshop: Lidl\nstorage: Koelkast\nshelf: Koeling\ncount: 0\n---\n");
	h.plugin.products.build();
	await h.plugin.lists.refreshAll();
	const again = h.plugin.lists.byPath(list.path);
	assert.ok(again);
	assert.deepEqual(again.unresolved.basket, []);
	assert.deepEqual(again.basket.get("Products/Hummus.md"), { count: 2, check: false });
	assert.match(h.note(list), /## In the basket\n\n- \[x\] \[\[Hummus\]\]\n- \[x\] \[\[Ui\]\]/);
});

test("een vinkje van een ander apparaat wordt niet overschreven door een eigen tik", async () => {
	const { h, list } = await run();
	// Het andere apparaat vinkte Rijst af; hier is die wijziging nog niet
	// verwerkt (de cache-event komt pas later).
	h.vault.write(list.path, withBasket(h.note(list), ["  - product: '[[Rijst]]'", "    count: 1"]));
	assert.equal(list.basket.has("Products/Rijst.md"), false, "het geheugen loopt achter");

	await h.plugin.lists.markBought(list, product(h, "Ui"));

	assert.ok(list.basket.has("Products/Rijst.md"), "overgenomen uit de notitie");
	assert.ok(list.basket.has("Products/Ui.md"));
	const note = h.note(list);
	assert.match(note, /\[\[Rijst\]\]'\n {4}count: 1/);
	assert.match(note, /\[\[Ui\]\]'\n {4}count: 0/);
	assert.match(note, /- \[x\] \[\[Rijst\]\]\n- \[x\] \[\[Ui\]\]/);
});

test("een lijst waarvan de notitie weg is wordt niet opnieuw aangemaakt", async () => {
	const { h, list } = await run();
	h.vault.files.delete(list.path);

	await assert.rejects(h.plugin.lists.markBought(list, product(h, "Ui")), /is gone/);
	assert.equal(h.vault.files.has(list.path), false);

	// De spiegel-verversing zwijgt: er is niets om te verversen.
	await h.plugin.lists.write(list);
	assert.equal(h.vault.files.has(list.path), false);
});

test("Done zet de lijst opzij in Done/, en sweep ruimt hem later op", async () => {
	const { h, list } = await run();
	const was = list.path;
	await h.plugin.lists.finish(list);

	assert.equal(h.vault.files.has(was), false, "weg uit de lijstmap");
	const done = "Cupboard/Shopping/Done/2026-08-25 Lidl.md";
	const note = h.vault.read(done);
	assert.match(note, /^---\npantry: shopping-done\n/, "herkenbaar als afgerond");
	assert.match(note, /\ndone: '?\d{4}-\d{2}-\d{2}'?\n/);
	assert.match(note, /- \[ \] \[\[Ui\]\]/, "de afvinklijst is het verslag");
	assert.equal(h.plugin.lists.byPath(done), null, "niet meer in de index");
	await h.plugin.lists.refreshAll();
	assert.deepEqual(h.plugin.lists.all(), [], "ook niet na herlezen van de map");

	// Vers afgerond: blijft. Oud genoeg: gaat weg. Een eigen notitie: blijft.
	h.vault.write("Cupboard/Shopping/Done/Eigen aantekening.md", "# Mijn lijstje\n");
	await h.plugin.lists.sweep();
	assert.ok(h.vault.files.has(done));
	h.vault.write(done, note.replace(/\ndone: '?\d{4}-\d{2}-\d{2}'?\n/, "\ndone: 2020-01-01\n"));
	await h.plugin.lists.sweep();
	assert.equal(h.vault.files.has(done), false, "opgeruimd na de bewaartermijn");
	assert.ok(h.vault.files.has("Cupboard/Shopping/Done/Eigen aantekening.md"));
});
