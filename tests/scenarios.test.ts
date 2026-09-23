/**
 * Scenario's over de hele keten.
 *
 * De vorm is steeds dezelfde:
 *
 *     gegeven deze productnotities, receptnotities en dit weekplan
 *     → maak een boodschappenlijst voor die week
 *     → dit is de notitie van die lijst
 *
 * De lijstnotitie gaat er in zijn geheel in, want die wil je kunnen zien.
 * Maar de getallen worden daarnáást expliciet geassert — anders wordt een
 * rode snapshot blind opnieuw goedgekeurd en verdwijnt precies de fout die je
 * wilde vangen.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const HOUSEHOLD = [
	{ id: "jeroen", name: "Jeroen", portionFactor: 1 },
	{ id: "kind", name: "Kind", portionFactor: 0.5 },
];

/** Woensdag 26 augustus 2026; met maandag als weekstart is dat 2026-W35. */
const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run(scenario: string) {
	const harness = makeHarness(loadFixture(scenario), { household: HOUSEHOLD });
	await harness.rebuild(WEEK);
	const list = await harness.list(WEEK);
	return { ...harness, list };
}

test("week-basis: één gepland recept vult de boodschappenlijst", async () => {
	const h = await run("week-basis");
	const need = (name: string) =>
		h.plugin.lists.needsOf(h.list).get(h.plugin.products.byPath(`Products/${name}.md`)!);
	const buy = (name: string) =>
		h.plugin.lists.amount(h.list, h.plugin.products.byPath(`Products/${name}.md`)!);

	// Recept voor 4, gegeten door 1 + 0,5 persoon → factor 0,375.
	// 500 g rijst wordt 187,5 g, en een pak is 500 g: 0,375 pak, omhoog naar 1.
	assert.equal(need("Rijst"), 1, "500 g van een pak van 500 g, geschaald");
	assert.equal(buy("Rijst"), 1, "minimum 1 + nodig 1 − in huis 1");

	// "2 [[Ui]]" heeft geen maat, dus het recept telt in dezelfde stuks.
	assert.equal(need("Ui"), 1, "0,75 ui, omhoog naar 1");
	assert.equal(buy("Ui"), 3, "minimum 2 + nodig 1 − in huis 0");

	// 500 ml passata uit een pak van 500 ml: zelfde rekensom, ander stelsel.
	assert.equal(need("Passata"), 1);
	assert.equal(buy("Passata"), 1, "minimum 0, dus alleen wat het recept vraagt");

	// "1 el olijfolie" en "een snufje zout": de gebruiker heeft gezegd dat de
	// hoeveelheid er niet toe doet. Die tellen voor niets mee — geen gok.
	assert.equal(need("Olijfolie"), 0);
	assert.equal(buy("Olijfolie"), 0, "voorraad 1 dekt het minimum van 1");
	assert.equal(need("Zout"), 0);
	assert.equal(buy("Zout"), null, "nooit geteld, dus onbeantwoordbaar");

	// De notitie: de keuzes in de frontmatter, de lijst eronder. Schappen in
	// looproutevolgorde: Groente vóór Droogwaren, want zo staat het in
	// Shops/Lidl.md. Olijfolie ligt bij Albert Heijn, dus die winkel staat
	// ook op de lijst — en krijgt geen kopje, want er valt daar niets te halen.
	assert.equal(h.list.path, "Cupboard/Shopping/2026-08-24 Lidl · Albert Heijn.md");
	// Kale datums, zoals Obsidian ze ook schrijft.
	assert.equal(
		h.note(h.list),
		[
			"---",
			"pantry: shopping",
			"format: 2",
			"date: 2026-08-24",
			"shops:",
			"  - '[[Lidl]]'",
			"  - '[[Albert Heijn]]'",
			"meals:",
			"  - date: 2026-08-26",
			"    meal: Dinner",
			"    recipe: '[[Rijst met ui]]'",
			"---",
			"",
			"# Lidl · Albert Heijn · Mon 24 Aug",
			"",
			"<!-- pantry:shopping -->",
			"*Kept up to date by Cupboard. Tick a box and that product counts as full again.*",
			"",
			"## Lidl",
			"",
			"### Groente",
			"",
			"- [ ] [[Ui]] · 3 stuk",
			"",
			"### Droogwaren",
			"",
			"- [ ] [[Passata]] · 1 pak",
			"- [ ] [[Rijst]] · 1 pak",
			"",
			"## Check first",
			"",
			"- [ ] [[Zout]] · ?",
			"<!-- /pantry:shopping -->",
			"",
		].join("\n")
	);
});

test("de lijst zet haar boodschappenmoment in het weekplan", async () => {
	// Eén begrip: de datum van de lijst is het moment waarop het spul van die
	// winkel in huis is. De planner rekent daarmee, zonder dat je het apart
	// hoeft in te vullen.
	const h = await run("week-basis");
	const plan = await h.plugin.plans.load(WEEK);
	const day = plan.days.find((entry) => entry.date === "2026-08-24");
	assert.deepEqual(day?.shopping, [{ shop: "Lidl" }, { shop: "Albert Heijn" }]);

	// Weggooien haalt het weer weg; klaar laat het staan.
	await h.plugin.lists.discard(h.list);
	const after = await h.plugin.plans.load(WEEK);
	assert.equal(after.days.find((entry) => entry.date === "2026-08-24")?.shopping, undefined);
	assert.equal(h.vault.files.has(h.list.path), false, "de notitie is weg");
});

test("wat je zelf onder de lijst zet blijft staan", async () => {
	// H5. De notitie werd volledig geregenereerd: een handgeschreven regel, een
	// Dataview-blok of een briefje aan de slager was bij de eerstvolgende
	// verversing weg — en die verversing draait bij elke vaultwijziging.
	const h = await run("week-basis");

	const eigen = `${h.note(h.list).trimEnd()}\n\n## Niet vergeten\n\n- [ ] batterijen\n- vraag bij de slager naar de tijm\n`;
	h.vault.write(h.list.path, eigen);

	// Iets verandert, dus de lijst wordt opnieuw geschreven.
	await h.plugin.lists.markBought(h.list, h.plugin.products.byPath("Products/Ui.md")!);

	const after = h.note(h.list);
	assert.match(after, /## Niet vergeten/);
	assert.match(after, /- \[ \] batterijen/);
	assert.match(after, /vraag bij de slager naar de tijm/);
	assert.match(after, /## In the basket/, "en de lijst zelf is wel bijgewerkt");
	assert.match(after, /basket:\n {2}- product: '\[\[Ui\]\]'\n {4}count: 0/, "het mandje staat in de frontmatter");
});

test("een eigen frontmatter-veld blijft staan", async () => {
	const h = await run("week-basis");
	const note = h.note(h.list).replace("pantry: shopping\n", "pantry: shopping\ntags:\n  - boodschappen\n");
	h.vault.write(h.list.path, note);

	await h.plugin.lists.markBought(h.list, h.plugin.products.byPath("Products/Ui.md")!);

	assert.match(h.note(h.list), /^tags:\n {2}- boodschappen$/m);
});

test("een notitie in de lijstmap die geen lijst is blijft ongemoeid", async () => {
	const h = await run("week-basis");

	const vanJeroen = "# Mijn eigen lijstje\n\n- [ ] kaarsen\n";
	h.vault.write("Cupboard/Shopping/Eigen.md", vanJeroen);
	await h.plugin.lists.refreshAll();

	assert.equal(h.vault.read("Cupboard/Shopping/Eigen.md"), vanJeroen, "geen frontmatter, geen markers, niet aankomen");
	assert.equal(h.plugin.lists.all().length, 1, "en het is geen lijst geworden");
});

test("een lege productindex wist de lijst niet", async () => {
	// M40. Klopt de productmap even niet, dan is er niets te melden — en dat is
	// iets anders dan "niets nodig". Het mandje mag niet verdwijnen terwijl je
	// in de winkel staat.
	const h = await run("week-basis");
	const before = h.note(h.list);

	h.plugin.settings.productFolder = "Bestaat niet";
	h.plugin.products.build();
	await h.plugin.lists.write(h.list);

	assert.equal(h.note(h.list), before);
});

test("uitvinken zet de check-vlag terug", async () => {
	// M9. markBought wist de vlag, undoBought gaf hem niet terug: een product
	// uit "Check first" raakte hem kwijt zodra je het per ongeluk afvinkte.
	const h = await run("week-basis");
	const zout = h.plugin.products.byPath("Products/Zout.md")!;
	await h.plugin.products.update(zout, { count: 2, check: true });

	await h.plugin.lists.markBought(h.list, zout);
	assert.equal(zout.check, false, "afvinken haalt hem uit Check first");

	await h.plugin.lists.undoBought(h.list, zout);
	assert.equal(zout.check, true, "en uitvinken zet hem terug");
	assert.equal(zout.count, 2, "net als de telling van ervoor");
});

test("een reeks tikken in de notitie wordt in één keer weggeschreven", async () => {
	// M8. Elke tik schreef de hele notitie opnieuw vanuit één momentopname, dus
	// een vinkje dat je zette tussen het lezen en het laatste schrijven werd
	// stil weer uitgevinkt.
	const h = await run("week-basis");

	const getikt = h
		.note(h.list)
		.split("\n")
		.map((line) => (line.startsWith("- [ ] [[") ? line.replace("- [ ]", "- [x]") : line))
		.join("\n");
	h.vault.write(h.list.path, getikt);

	await h.plugin.lists.syncFromNote(h.vault.vault.getFileByPath(h.list.path)!);

	for (const name of ["Ui", "Passata", "Rijst", "Zout"]) {
		assert.equal(h.list.basket.has(`Products/${name}.md`), true, `${name} staat in het mandje`);
	}
	assert.match(h.note(h.list), /## In the basket/);
	assert.equal(h.plugin.products.byPath("Products/Ui.md")!.count, "plus");
});

test("het mandje overleeft een herstart, met de telling van ervoor", async () => {
	// Je begint op je laptop en staat met je telefoon in de winkel; de notitie
	// is het enige wat mee reist.
	const h = await run("week-basis");
	await h.plugin.lists.markBought(h.list, h.plugin.products.byPath("Products/Ui.md")!);

	const later = makeHarness(h.vault.snapshot(), { household: HOUSEHOLD });
	await later.rebuild(WEEK);
	await later.plugin.lists.refreshAll();
	const list = later.plugin.lists.byPath(h.list.path);
	assert.ok(list);
	assert.deepEqual(list.basket.get("Products/Ui.md"), { count: 0, check: false });
	assert.deepEqual(list.meals, [{ date: "2026-08-26", meal: "Dinner", recipe: "Rijst met ui" }]);

	await later.plugin.lists.undoBought(list, later.plugin.products.byPath("Products/Ui.md")!);
	assert.equal(later.plugin.products.byPath("Products/Ui.md")!.count, 0);
});
