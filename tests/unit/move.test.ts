/**
 * `move()` is de rekensom achter één product bij het afboeken van een maaltijd.
 *
 * Losse test, want drie takken zijn via een scenario niet gericht te raken:
 * afklemmen op nul, terugboeken met een negatieve carry, en de epsilongrens
 * waar drijvende komma's anders een halve verpakking uit het niets maken.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { move } from "../../src/consume";
import type { Product } from "../../src/products";

function product(over: Partial<Product> = {}): Product {
	return {
		path: "Products/Rijst.md",
		name: "Rijst",
		minimum: 1,
		unit: "pak",
		size: { amount: 500, unit: "g" },
		amountMatters: true,
		shop: "Lidl",
		storage: "Voorraadkast",
		shelf: "Droogwaren",
		aliases: [],
		count: 2,
		used: 0,
		counted: "2026-08-24",
		check: false,
		previous: null,
		previousCounted: null,
		...over,
	} as Product;
}

test("een deel van een verpakking blijft als restje staan", () => {
	const patch = move(product({ count: 2, used: 0 }), 0.4);
	assert.deepEqual(patch, { used: 0.4 });
});

test("restjes die samen een hele verpakking vormen halen er één af", () => {
	const patch = move(product({ count: 2, used: 0.7 }), 0.4);
	assert.equal(patch?.count, 1);
	assert.ok(Math.abs((patch?.used ?? 0) - 0.1) < 1e-9, "0,1 blijft over");
});

test("drijvende komma maakt geen extra verpakking", () => {
	// 0,1 + 0,2 is in JavaScript 0,30000000000000004. Zonder epsilon telt dat
	// als méér dan 0,3 en verspringt de telling op de verkeerde plek.
	const patch = move(product({ count: 2, used: 0.1 }), 0.2);
	assert.equal(patch?.count, undefined, "de telling verandert niet");
	assert.ok((patch?.used ?? 0) < 1, "het blijft een restje");
});

test("meer opeten dan er staat klemt op nul en zet de vlag", () => {
	const patch = move(product({ count: 1, used: 0 }), 2);
	assert.equal(patch?.count, 0, "nooit een negatieve voorraad");
	assert.equal(patch?.check, true, "de boekhouding klopte al niet");
});

test("terugboeken zet hele verpakkingen terug", () => {
	const patch = move(product({ count: 0, used: 0 }), -2);
	assert.equal(patch?.count, 2);
	assert.equal(patch?.used, 0);
});

test("zonder telling valt er niets te boeken", () => {
	assert.equal(move(product({ count: null }), 1), null);
	assert.equal(move(product({ count: "plus" }), 1), null, "genoeg is genoeg");
});

test("een telling die niet verandert claimt geen nieuwe teldatum", () => {
	const patch = move(product({ count: 3, used: 0 }), 0.2);
	assert.equal(patch?.count, undefined);
});
