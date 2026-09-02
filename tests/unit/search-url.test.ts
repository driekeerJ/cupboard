/**
 * Het zoekadres van een winkel, zoals de gebruiker het in zijn winkelnotitie
 * zet. De plugin kent geen enkele winkel bij naam; alles wat hij weet komt uit
 * dit sjabloon, en dus is dit de plek waar rommelige invoer wordt afgevangen.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { searchUrl } from "../../src/shops";

test("{q} wordt de zoekterm, url-veilig", () => {
	assert.equal(
		searchUrl("https://www.ah.nl/zoeken?query={q}", "gepelde tomaten"),
		"https://www.ah.nl/zoeken?query=gepelde%20tomaten"
	);
});

test("een sjabloon zonder {q} krijgt de term erachter", () => {
	// Dit is de vorm die mensen uit hun adresbalk plakken.
	assert.equal(
		searchUrl("https://www.lidl.nl/q/search?q=", "havermout"),
		"https://www.lidl.nl/q/search?q=havermout"
	);
});

test("zonder sjabloon of zonder term is er niets om te openen", () => {
	assert.equal(searchUrl("", "havermout"), null);
	assert.equal(searchUrl("   ", "havermout"), null);
	assert.equal(searchUrl("https://www.ah.nl/zoeken?query={q}", "  "), null);
});

test("alleen http en https", () => {
	// Een winkelnotitie is gebruikersinvoer, en de plugin opent wat hier
	// uitkomt. `javascript:` is dan geen link maar code.
	assert.equal(searchUrl("javascript:alert(1)", "x"), null);
	assert.equal(searchUrl("file:///etc/passwd?q={q}", "x"), null);
	assert.equal(searchUrl("obsidian://open?vault=x&q={q}", "x"), null);
	assert.match(searchUrl("HTTPS://Winkel.lu/zoek?q={q}", "riz") ?? "", /^HTTPS:/);
});

test("meerdere {q} in één sjabloon worden allemaal ingevuld", () => {
	assert.equal(
		searchUrl("https://winkel.lu/{q}/zoek?q={q}", "riz"),
		"https://winkel.lu/riz/zoek?q=riz"
	);
});
