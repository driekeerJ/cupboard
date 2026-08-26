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
	const moved = move(product({ count: 2, used: 0 }), 0.4);
	assert.deepEqual(moved?.patch, { used: 0.4, derived: true });
	assert.equal(moved?.applied, 0.4);
});

test("restjes die samen een hele verpakking vormen halen er één af", () => {
	const moved = move(product({ count: 2, used: 0.7 }), 0.4);
	assert.equal(moved?.patch.count, 1);
	assert.ok(Math.abs((moved?.patch.used ?? 0) - 0.1) < 1e-9, "0,1 blijft over");
});

test("drijvende komma maakt geen extra verpakking", () => {
	// 0,1 + 0,2 is in JavaScript 0,30000000000000004. Zonder epsilon telt dat
	// als méér dan 0,3 en verspringt de telling op de verkeerde plek.
	const moved = move(product({ count: 2, used: 0.1 }), 0.2);
	assert.equal(moved?.patch.count, undefined, "de telling verandert niet");
	assert.ok((moved?.patch.used ?? 0) < 1, "het blijft een restje");
});

test("drie keer een derde zak is een hele zak", () => {
	// M4: `used` werd op drie decimalen bewaard terwijl move() met 1e-9 rekent.
	// Drie derde zakken gaven 0,999 en de telling bleef staan — de zak was op
	// en de voorraad wist het niet.
	let stock = product({ count: 2, used: 0 });
	let crossed = false;
	for (let n = 0; n < 3; n++) {
		const moved = move(stock, 1 / 3);
		assert.ok(moved);
		if (moved.patch.count !== undefined) {
			crossed = true;
			stock = product({ count: moved.patch.count, used: moved.patch.used ?? 0 });
		} else {
			stock = product({ count: stock.count, used: moved.patch.used ?? 0 });
		}
	}
	assert.equal(crossed, true, "na drie derden gaat er een zak af");
	assert.equal(stock.count, 1);
});

test("meer opeten dan er staat klemt op nul en zet de vlag", () => {
	const moved = move(product({ count: 1, used: 0 }), 2);
	assert.equal(moved?.patch.count, 0, "nooit een negatieve voorraad");
	assert.equal(moved?.patch.check, true, "de boekhouding klopte al niet");
	// H1: er stond er één, dus er kon er maar één op.
	assert.equal(moved?.applied, 1, "niet de gevraagde 2");
});

test("van nul afboeken boekt niets af", () => {
	const moved = move(product({ count: 0, used: 0 }), 2);
	assert.equal(moved?.applied, 0);
	assert.equal(moved?.patch.check, true);
});

test("terugboeken zet hele verpakkingen terug", () => {
	const moved = move(product({ count: 0, used: 0 }), -2);
	assert.equal(moved?.patch.count, 2);
	assert.equal(moved?.patch.used, 0);
	assert.equal(moved?.applied, -2, "teruggeven klemt nergens op");
});

test("zonder telling valt er niets te boeken", () => {
	assert.equal(move(product({ count: null }), 1), null);
	assert.equal(move(product({ count: "plus" }), 1), null, "genoeg is genoeg");
});

test("een telling die niet verandert claimt geen nieuwe teldatum", () => {
	const moved = move(product({ count: 3, used: 0 }), 0.2);
	assert.equal(moved?.patch.count, undefined);
});

test("een afgeleide stand is geen telling", () => {
	// M2: zonder deze vlag stempelt elke afgevinkte maaltijd `counted` op
	// vandaag, en beweert de notitie dat je vandaag geteld hebt.
	assert.equal(move(product({ count: 2, used: 0 }), 1)?.patch.derived, true);
});
