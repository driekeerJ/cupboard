/**
 * Receptregels zijn vrije tekst. Deze parser leest er een getal en een maat
 * van af — en laat álles wat hij niet herkent in de naam staan, zodat
 * "3 teentjes knoflook" precies zo terugleest als het geschreven is.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseIngredient, scaleIngredient } from "../../src/ingredients";

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

test("de volle unicode-breukset wordt gelezen", () => {
	// R6. Er waren er zes van de vijftien; de rest viel stil door naar de
	// decimale tak of naar "geen getal".
	assert.equal(parseIngredient("⅜ tl zout").amount, 0.375);
	assert.equal(parseIngredient("⅚ l bouillon").amount, 5 / 6);
	assert.equal(parseIngredient("⅕ ui").amount, 0.2);
});

test("gemengde breuk met spatie: 1 1/2", () => {
	// R6. De breuk-regex eiste een schuine streep direct na het eerste getal,
	// dus "1 1/2 lb" viel door naar de decimale tak en werd 1 — een stille
	// onderschatting van een derde.
	assert.equal(parseIngredient("1 1/2 lb rijst").amount, 1.5);
	assert.equal(parseIngredient("2 3/4 kg aardappels").amount, 2.75);
	assert.equal(parseIngredient("1 1/2 lb rijst").unit, "lb");
});

test("de fractieslash U+2044 telt ook als deelstreep", () => {
	assert.equal(parseIngredient("1\u20442 citroen").amount, 0.5);
});

test("een bereik is de bovengrens", () => {
	// Met twee uien in huis sta je in de keuken met een recept dat er drie wil.
	const parsed = parseIngredient("2-3 uien");
	assert.equal(parsed.amount, 3);
	assert.equal(parsed.name, "uien", "en het streepje blijft niet in de naam hangen");
});

test("een streepje zonder tweede getal is geen bereik", () => {
	assert.equal(parseIngredient("2 liter-pak melk").amount, 2);
});

test("een bereidingsnoot tussen haakjes hoort niet bij de naam", () => {
	// R5. "2 uien (gesnipperd)" moet het product Ui vinden zonder alias.
	const parsed = parseIngredient("2 [[Ui]] (gesnipperd)");
	assert.equal(parsed.name, "[[Ui]]");
	assert.equal(parsed.note, " (gesnipperd)");
});

test("een komma-staart die over de bewerking gaat wordt afgeknipt", () => {
	const parsed = parseIngredient("2 grote uien, fijngehakt");
	assert.equal(parsed.name, "grote uien");
	assert.equal(parsed.note, ", fijngehakt");
});

test("maar een komma-staart die een ingrediënt is blijft staan", () => {
	// "zout, peper" is geen bewerking maar een tweede ingrediënt.
	const parsed = parseIngredient("zout, peper");
	assert.equal(parsed.name, "zout, peper");
	assert.equal(parsed.note, null);
});

test("schalen zet de bereidingsnoot terug", () => {
	// De noot is van de naam gescheiden om het product te vinden; bij het
	// herschrijven voor de kookweergave hoort hij er weer aan.
	assert.equal(scaleIngredient("2 uien (gesnipperd)", 2).text, "4 uien (gesnipperd)");
	assert.equal(
		scaleIngredient("500 g rijst, uitgelekt", 0.5).text,
		"250 g rijst, uitgelekt"
	);
});

test("een kleine hoeveelheid wordt nooit nul", () => {
	// M7. "1 g saffraan" maal 0,2 gaf "0 g saffraan" — een hoeveelheid die de
	// kok vertelt dat hij het kan weglaten.
	assert.equal(scaleIngredient("1 g saffraan", 0.2).text, "0.2 g saffraan");
	assert.notEqual(scaleIngredient("0.1 kg boter", 0.2).text, "0 kg boter");
});

test("in de keuken staan geen wikilinks", () => {
	// Gevonden door Jeroen: kookmodus toonde "1 1/2 kg [[ZZ Test Meel]]".
	// Zijn recepten hebben allemaal wikilinks in de ingrediënten, dus dit stond
	// bij elke regel van elk recept.
	assert.equal(scaleIngredient("1 1/2 kg [[Meel]]", 1).text, "1 1/2 kg Meel");
	assert.equal(scaleIngredient("500 g [[Rijst]]", 0.5).text, "250 g Rijst");
	assert.equal(
		scaleIngredient("2 [[Ui|uien]] (gesnipperd)", 2).text,
		"4 uien (gesnipperd)",
		"de getoonde naam wint van het linkdoel"
	);
	assert.equal(
		scaleIngredient("500 g [[Rijst]]", 0.5).original,
		"500 g Rijst",
		"ook de regel die laat zien wat er stond"
	);
});

test("een regel zonder link blijft zoals hij is", () => {
	assert.equal(scaleIngredient("peper en zout", 2).text, "peper en zout");
});
