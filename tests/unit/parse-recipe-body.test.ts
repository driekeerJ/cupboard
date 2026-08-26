/**
 * `parseRecipeBody()` haalt de twee lijsten uit een receptnotitie. Losse test,
 * want kopniveaus zijn via een scenario alleen indirect te zien: een gemiste
 * ingrediëntenregel wordt verderop stilletjes nul.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecipeBody } from "../../src/cook";

const RECIPE = `---
servings: 4
---

# Rijst met ui

## Ingrediënten

- 500 g rijst
- 2 uien

## Bereiding

1. Snipper de ui.
2. Kook de rijst.
`;

test("frontmatter telt niet mee", () => {
	assert.deepEqual(parseRecipeBody(RECIPE).ingredients, ["500 g rijst", "2 uien"]);
});

test("genummerde stappen worden stappen", () => {
	assert.deepEqual(parseRecipeBody(RECIPE).steps, [
		"Snipper de ui.",
		"Kook de rijst.",
	]);
});

test("Engelse en Nederlandse koppen werken allebei", () => {
	const body = "## Ingredients\n- a\n\n## Method\n- b\n";
	assert.deepEqual(parseRecipeBody(body).ingredients, ["a"]);
	assert.deepEqual(parseRecipeBody(body).steps, ["b"]);
});

test("een kop met dubbele punt of nadruk telt ook", () => {
	assert.deepEqual(parseRecipeBody("## **Ingrediënten:**\n- a\n").ingredients, ["a"]);
});

test("een kop die niets van beide is sluit de lijst af", () => {
	const body = "## Ingrediënten\n- a\n\n## Notities\n- niet meenemen\n";
	assert.deepEqual(parseRecipeBody(body).ingredients, ["a"]);
});

test("tekst buiten een kop wordt genegeerd", () => {
	assert.deepEqual(parseRecipeBody("- losse regel\n\n## Ingrediënten\n- a\n").ingredients, ["a"]);
});

test("een subkop breekt de ingrediëntenlijst niet af", () => {
	const body = [
		"## Ingrediënten",
		"",
		"### Voor de saus",
		"- 500 ml passata",
		"",
		"### Voor erbij",
		"- 2 uien",
		"",
		"## Bereiding",
		"- Kook.",
	].join("\n");

	const parsed = parseRecipeBody(body);
	assert.deepEqual(
		parsed.ingredients,
		["500 ml passata", "2 uien"],
		"alles onder de kop hoort erbij tot een kop van hetzelfde niveau"
	);
	assert.deepEqual(parsed.steps, ["Kook."]);
});

test("een bereidingskop bínnen de sectie schakelt gewoon om", () => {
	// Anders zou "### Bereiding" onder "## Ingrediënten" als onderverdeling
	// gelden en zouden de stappen als ingrediënten worden opgepikt.
	const body = [
		"## Ingrediënten",
		"- 2 uien",
		"",
		"### Bereiding",
		"- Snipper.",
	].join("\n");

	const parsed = parseRecipeBody(body);
	assert.deepEqual(parsed.ingredients, ["2 uien"]);
	assert.deepEqual(parsed.steps, ["Snipper."]);
});
