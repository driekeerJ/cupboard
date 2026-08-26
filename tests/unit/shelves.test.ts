/**
 * De looproute terugschrijven in een winkelnotitie.
 *
 * Losse test omdat het misgaan hier stil groeit: `SHELF_HEADING` matcht ruim
 * ("shelves", "route", "schap", "gangpad"), en een notitie met twee van zulke
 * koppen kreeg de volledige lijst onder allebei — die verdubbelde dan bij elke
 * opslag.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { writeShelves } from "../../src/shops";

test("de route komt in de eerste routesectie", () => {
	const note = ["# Lidl", "", "## Shelves", "", "- Oud", "", "## Openingstijden", "", "- 8-21"].join("\n");
	const after = writeShelves(note, ["Groente", "Brood"]);

	assert.match(after, /## Shelves\n\n- Groente\n- Brood/);
	assert.match(after, /## Openingstijden\n\n- 8-21/, "de rest blijft staan");
	assert.doesNotMatch(after, /- Oud/);
});

test("een tweede routekop wordt niet ook volgeschreven", () => {
	// H7: hier groeide 2 -> 4 -> 8 -> 16.
	const note = [
		"## Shelves", "", "- Oud",
		"", "## Mijn route", "", "- Ook oud",
	].join("\n");

	const after = writeShelves(note, ["Groente", "Brood"]);
	const groente = after.split("\n").filter((line) => line === "- Groente");
	assert.equal(groente.length, 1, "één keer, niet onder elke kop");
	assert.match(after, /## Mijn route\n\n- Ook oud/, "de tweede kop blijft van de gebruiker");
});

test("zonder routekop wordt er een aangemaakt", () => {
	const after = writeShelves("# Lidl\n", ["Groente"]);
	assert.match(after, /## Shelves\n\n- Groente/);
	assert.match(after, /^# Lidl/);
});

test("de notitie eindigt op precies één nieuwe regel", () => {
	assert.match(writeShelves("# Lidl\n\n\n", ["A"]), /- A\n$/);
});
