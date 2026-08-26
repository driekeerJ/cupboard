/**
 * Scenario's over de hele keten.
 *
 * De vorm is steeds dezelfde:
 *
 *     gegeven deze productnotities, receptnotities en dit weekplan
 *     → draai de echte keten
 *     → dit is Groceries.md
 *
 * De boodschappennotitie gaat er in zijn geheel in, want die wil je kunnen
 * zien. Maar de getallen worden daarnáást expliciet geassert — anders wordt
 * een rode snapshot blind opnieuw goedgekeurd en verdwijnt precies de fout
 * die je wilde vangen.
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
	await harness.plugin.list.write();
	return harness;
}

test("week-basis: één gepland recept vult de boodschappenlijst", async () => {
	const h = await run("week-basis");
	const need = (name: string) =>
		h.plugin.needs.get(h.plugin.products.byPath(`Products/${name}.md`)!);
	const buy = (name: string) =>
		h.plugin.list.amount(h.plugin.products.byPath(`Products/${name}.md`)!);

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

	// En zo ziet de notitie er dan uit. Schappen in looproutevolgorde:
	// Groente vóór Droogwaren, want zo staat het in Shops/Lidl.md.
	assert.equal(
		h.groceries(),
		[
			"---",
			"pantry: groceries",
			"---",
			"",
			"# Groceries",
			"",
			"*Anything you write outside the block below stays where it is.*",
			"",
			"<!-- pantry:groceries -->",
			"*Kept up to date by Pantry. Tick a box and that product counts as full again.*",
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
			"<!-- /pantry:groceries -->",
			"",
		].join("\n")
	);
});

test("wat je zelf in de boodschappennotitie zet blijft staan", async () => {
	// H5. De notitie werd volledig geregenereerd: een handgeschreven regel, een
	// Dataview-blok of een briefje aan de slager was bij de eerstvolgende
	// verversing weg — en die verversing draait bij elke vaultwijziging.
	const h = await run("week-basis");

	const eigen = `${h.groceries().trimEnd()}\n\n## Niet vergeten\n\n- [ ] batterijen\n- vraag bij de slager naar de tijm\n`;
	h.vault.write(h.plugin.list.path(), eigen);

	// Iets verandert, dus de lijst wordt opnieuw geschreven.
	await h.plugin.list.markBought(h.plugin.products.byPath("Products/Ui.md")!);

	const after = h.groceries();
	assert.match(after, /## Niet vergeten/);
	assert.match(after, /- \[ \] batterijen/);
	assert.match(after, /vraag bij de slager naar de tijm/);
	assert.match(after, /## In the basket/, "en de lijst zelf is wel bijgewerkt");
});

test("een notitie die niet van Pantry is blijft ongemoeid", async () => {
	const h = await run("week-basis");

	const vanJeroen = "# Mijn eigen lijstje\n\n- [ ] kaarsen\n";
	h.vault.write(h.plugin.list.path(), vanJeroen);
	await h.plugin.list.write();

	assert.equal(h.groceries(), vanJeroen, "geen frontmatter, geen markers, niet aankomen");
});

test("een lege productindex wist de lijst niet", async () => {
	// M40. Klopt de productmap even niet, dan is er niets te melden — en dat is
	// iets anders dan "niets nodig". Het mandje mag niet verdwijnen terwijl je
	// in de winkel staat.
	const h = await run("week-basis");
	const before = h.groceries();

	h.plugin.settings.productFolder = "Bestaat niet";
	h.plugin.products.build();
	await h.plugin.list.write();

	assert.equal(h.groceries(), before);
});

test("uitvinken zet de check-vlag terug", async () => {
	// M9. markBought wist de vlag, undoBought gaf hem niet terug: een product
	// uit "Check first" raakte hem kwijt zodra je het per ongeluk afvinkte.
	const h = await run("week-basis");
	const zout = h.plugin.products.byPath("Products/Zout.md")!;
	await h.plugin.products.update(zout, { count: 2, check: true });

	await h.plugin.list.markBought(zout);
	assert.equal(zout.check, false, "afvinken haalt hem uit Check first");

	await h.plugin.list.undoBought(zout);
	assert.equal(zout.check, true, "en uitvinken zet hem terug");
	assert.equal(zout.count, 2, "net als de telling van ervoor");
});

test("een reeks tikken in de notitie wordt in één keer weggeschreven", async () => {
	// M8. Elke tik schreef de hele notitie opnieuw vanuit één momentopname, dus
	// een vinkje dat je zette tussen het lezen en het laatste schrijven werd
	// stil weer uitgevinkt.
	const h = await run("week-basis");

	const getikt = h
		.groceries()
		.split("\n")
		.map((line) => (line.startsWith("- [ ] [[") ? line.replace("- [ ]", "- [x]") : line))
		.join("\n");
	h.vault.write(h.plugin.list.path(), getikt);

	await h.plugin.list.syncFromNote();

	for (const name of ["Ui", "Passata", "Rijst", "Zout"]) {
		assert.equal(
			h.plugin.list.bought.has(`Products/${name}.md`),
			true,
			`${name} staat in het mandje`
		);
	}
	assert.match(h.groceries(), /## In the basket/);
});
