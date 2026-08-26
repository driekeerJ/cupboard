/**
 * De telling in frontmatter is met de hand te typen, dus alles kan er staan.
 * "+" betekent "meer dan genoeg, en ik ga niet tellen" — bewust geen getal,
 * zodat de app er nooit eentje van maakt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseCount } from "../../src/products";

test("een getal blijft een getal", () => {
	assert.equal(parseCount(3), 3);
	assert.equal(parseCount("3"), 3);
	assert.equal(parseCount("2,5"), 2.5, "de komma is Nederlands");
	assert.equal(parseCount(0), 0, "nul is een antwoord, geen leegte");
});

test("een plus is genoeg, hoeveel dan ook", () => {
	assert.equal(parseCount("+"), "plus");
	assert.equal(parseCount("3+"), "plus", "meer dan drie is nog steeds genoeg");
});

test("niets ingevuld is niet hetzelfde als nul", () => {
	assert.equal(parseCount(null), null);
	assert.equal(parseCount(undefined), null);
	assert.equal(parseCount(""), null);
});

test("onzin levert geen getal op", () => {
	assert.equal(parseCount("veel"), null);
});
