/**
 * Het koppelen van ingrediënten aan stappen is giswerk op naam. De tests
 * hieronder leggen vast wat het mag raden — samenstellingen, meervouden,
 * merknamen — en waar het zijn mond moet houden.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { groupIngredientsByStep, searchTerms, wordForms } from "../../src/cook-groups";

const STEPS = [
	"Snipper de ui en pers de knoflook.",
	"Bak de ui en de knoflook 3 min.",
	"Voeg de bouillon, de sojadrink en het laurierblaadje toe.",
	"Breng op smaak met zout en peper.",
];

function grouped(ingredients: string[]): Array<[number | null, string[]]> {
	const groups = groupIngredientsByStep(ingredients, STEPS);
	assert.ok(groups);
	return groups.map((group) => [
		group.step,
		group.indexes.map((index) => ingredients[index] ?? ""),
	]);
}

test("meervoud en enkelvoud vinden elkaar", () => {
	assert.deepEqual(wordForms("uien").includes("ui"), true);
	assert.deepEqual(wordForms("bonen").includes("boon"), true);
	assert.deepEqual(wordForms("peren").includes("peer"), true);
	assert.deepEqual(wordForms("appels").includes("appel"), true);
});

test("een ingrediënt hoort bij de eerste stap die hem noemt", () => {
	assert.deepEqual(grouped(["2 [[Uien]], gesnipperd", "1 teen [[Knoflook]]"]), [
		[0, ["2 [[Uien]], gesnipperd", "1 teen [[Knoflook]]"]],
	]);
});

test("merkwoorden tellen niet mee, het product wel", () => {
	assert.deepEqual(
		grouped(["720 ml [[AH Terra Plantaardige sojadrink ongezoet]]"]),
		[[2, ["720 ml [[AH Terra Plantaardige sojadrink ongezoet]]"]]]
	);
});

test("samenstellingen tellen als hetzelfde ingrediënt", () => {
	// bouillonblokjes -> bouillon, laurierblad -> laurierblaadje
	assert.deepEqual(
		grouped(["1 [[Maggi bouillonblokjes groente]]", "2 [[Laurierblad]]"]),
		[[2, ["1 [[Maggi bouillonblokjes groente]]", "2 [[Laurierblad]]"]]]
	);
});

test("twee producten op één regel: de eerste treffer telt", () => {
	assert.deepEqual(grouped(["[[Zout]] en [[Zwarte peper]] naar smaak"]), [
		[3, ["[[Zout]] en [[Zwarte peper]] naar smaak"]],
	]);
});

test("wat nergens genoemd wordt, komt in de restgroep", () => {
	assert.deepEqual(grouped(["300 g [[Tempeh]]", "2 [[Uien]]"]), [
		[0, ["2 [[Uien]]"]],
		[null, ["300 g [[Tempeh]]"]],
	]);
});

test("een sterke treffer verderop wint van een zwakke vooraan", () => {
	const steps = ["Doe de sla in een kom.", "Roer de slagroom door de saus."];
	const groups = groupIngredientsByStep(["200 ml [[Slagroom]]"], steps);
	assert.deepEqual(groups, [{ step: 1, indexes: [0] }]);
});

test("zonder stappen valt er niets te groeperen", () => {
	assert.equal(groupIngredientsByStep(["2 [[Uien]]"], []), null);
});

test("matcht er niets, dan is een platte lijst eerlijker", () => {
	assert.equal(groupIngredientsByStep(["300 g [[Tempeh]]"], STEPS), null);
});

test("zonder wikilink wordt de naam uit de regel gelezen", () => {
	const terms = searchTerms("2 uien, gesnipperd");
	assert.deepEqual([...terms.strong, ...terms.weak].includes("ui"), true);
});
