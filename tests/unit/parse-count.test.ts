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

test("een kale plus is genoeg, een plus met getal is een telling", () => {
	assert.equal(parseCount("+"), "plus");
	// "3+" zei eerst alleen "genoeg", en `toBuy` geeft daarvoor altijd 0. Met
	// `minimum: 6` kocht je dan niets bij terwijl er drie stonden. Het getal is
	// het meest voorzichtige antwoord: hooguit koop je een keer te veel.
	assert.equal(parseCount("3+"), 3);
	assert.equal(parseCount("veel+"), "plus", "zonder getal blijft het genoeg");
});

test("niets ingevuld is niet hetzelfde als nul", () => {
	assert.equal(parseCount(null), null);
	assert.equal(parseCount(undefined), null);
	assert.equal(parseCount(""), null);
});

test("onzin levert geen getal op", () => {
	assert.equal(parseCount("veel"), null);
});
