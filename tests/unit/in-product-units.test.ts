/**
 * `inProductUnits()` vertaalt één receptregel naar de eenheid waarin de
 * gebruiker dat product telt. Vijf takken, en de vijfde — "ik kan het niet
 * uitdrukken" — moet nul opleveren en geen gok, want dat getal komt anders
 * ongemerkt op de boodschappenlijst terecht.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseIngredient } from "../../src/ingredients";
import { inProductUnits } from "../../src/needs";
import type { Product } from "../../src/products";

function product(over: Partial<Product> = {}): Product {
	return {
		path: "Products/X.md",
		name: "X",
		minimum: 0,
		unit: "pak",
		size: { amount: 500, unit: "g" },
		amountMatters: true,
		shop: "",
		storage: "",
		shelf: "",
		aliases: [],
		count: 0,
		used: 0,
		counted: null,
		check: false,
		previous: null,
		previousCounted: null,
		...over,
	} as Product;
}

const of = (line: string, p: Product, factor = 1) =>
	inProductUnits(parseIngredient(line), p, factor);

test("geen maat: het recept telt in dezelfde stuks", () => {
	assert.equal(of("2 uien", product({ unit: "stuk", size: null })), 2);
});

test("massa wordt omgerekend en door de verpakkingsgrootte gedeeld", () => {
	assert.equal(of("250 g rijst", product()), 0.5, "een half pak van 500 g");
	assert.equal(of("1 kg rijst", product()), 2, "kg en g horen bij elkaar");
});

test("volume net zo, in zijn eigen stelsel", () => {
	const p = product({ unit: "pak", size: { amount: 500, unit: "ml" } });
	assert.equal(of("1 l passata", p), 2);
});

test("het recept spreekt zelf de verpakkingseenheid", () => {
	const p = product({ unit: "blik", size: { amount: 400, unit: "g" } });
	assert.equal(of("2 blik tomaten", p), 2, "twee blikken, niet twee gram");
});

test("gelijke eenheid zonder verpakkingsgrootte telt één op één", () => {
	assert.equal(of("3 stuk eieren", product({ unit: "stuk", size: null })), 3);
});

test("onconverteerbaar levert nul op, geen gok", () => {
	const p = product({ unit: "pot", size: { amount: 350, unit: "g" } });
	assert.equal(of("2 el mosterd", p), 0, "lepels uit een pot zijn niet te delen");
});

test("vage maten leveren nul op", () => {
	assert.equal(of("een snufje zout", product()), 0);
	assert.equal(of("1 handvol peterselie", product({ unit: "bos", size: null })), 0);
});

test("de gebruiker heeft gezegd dat de hoeveelheid er niet toe doet", () => {
	assert.equal(of("500 g zout", product({ amountMatters: false })), 0);
});

test("de schaalfactor werkt door voor het omrekenen", () => {
	assert.equal(of("500 g rijst", product(), 0.375), 0.375);
});
