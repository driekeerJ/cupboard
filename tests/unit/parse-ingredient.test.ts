/**
 * Receptregels zijn vrije tekst. Deze parser leest er een getal en een maat
 * van af — en laat álles wat hij niet herkent in de naam staan, zodat
 * "3 teentjes knoflook" precies zo terugleest als het geschreven is.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseIngredient } from "../../src/ingredients";

test("breukglyphs", () => {
	assert.equal(parseIngredient("½ ui").amount, 0.5);
	assert.equal(parseIngredient("¼ tl kaneel").amount, 0.25);
});

test("gemengde breuken, met en zonder spatie", () => {
	assert.equal(parseIngredient("1½ ui").amount, 1.5);
	assert.equal(parseIngredient("1 ½ ui").amount, 1.5);
});

test("breuken met een schuine streep", () => {
	assert.equal(parseIngredient("1/2 citroen").amount, 0.5);
	assert.equal(parseIngredient("3 / 4 l melk").amount, 0.75);
});

test("decimale komma", () => {
	assert.equal(parseIngredient("1,5 kg aardappels").amount, 1.5);
	assert.equal(parseIngredient("1.5 kg aardappels").amount, 1.5);
});

test("de maat wordt van de naam gescheiden", () => {
	const parsed = parseIngredient("500 g [[Rijst]]");
	assert.equal(parsed.amount, 500);
	assert.equal(parsed.unit, "g");
	assert.equal(parsed.kind, "mass");
	assert.equal(parsed.name, "[[Rijst]]");
});

test("een onbekend woord is deel van de naam, geen maat", () => {
	const parsed = parseIngredient("3 teentjes knoflook");
	assert.equal(parsed.amount, 3);
	assert.equal(parsed.unit, null, "'teentjes' is geen maat die de app kent");
	assert.equal(parsed.kind, "piece");
	assert.equal(parsed.name, "teentjes knoflook", "en blijft dus staan");
});

test("vage maten worden als vaag gemarkeerd", () => {
	assert.equal(parseIngredient("1 handvol peterselie").kind, "vague");
	assert.equal(parseIngredient("2 snufje zout").kind, "vague");
});

test("een regel zonder getal is vaag, niet nul", () => {
	const parsed = parseIngredient("peper en zout");
	assert.equal(parsed.amount, null, "null, want de app mag hier niets invullen");
	assert.equal(parsed.kind, "vague");
	assert.equal(parsed.name, "peper en zout");
});

test("een punt achter de maat hoort erbij", () => {
	assert.equal(parseIngredient("2 tbsp. olie").unit, "tbsp.");
	assert.equal(parseIngredient("2 tbsp. olie").kind, "spoon");
});
