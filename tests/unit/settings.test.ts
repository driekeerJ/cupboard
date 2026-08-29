/**
 * `data.json` is een bestand op schijf dat ouder kan zijn dan de code die het
 * leest. Deze tests leggen vast dat er nooit iets half doorkomt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normaliseSettings } from "../../src/settings";

test("niets opgeslagen is de standaard", () => {
	assert.deepEqual(normaliseSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(normaliseSettings({}), DEFAULT_SETTINGS);
	assert.deepEqual(normaliseSettings("onzin"), DEFAULT_SETTINGS);
});

test("een huisgenoot zonder portiefactor telt voor één", () => {
	// R10: dit ging ongecontroleerd naar binnen en werd `undefined || 0` in
	// servingsFor — een stille nul midden in de boodschappenberekening.
	const { household } = normaliseSettings({
		household: [{ id: "me", name: "Jeroen" }],
	});
	assert.equal(household[0]?.portionFactor, 1);
});

test("een onmogelijke portiefactor wordt niet overgenomen", () => {
	const factor = (value: unknown) =>
		normaliseSettings({ household: [{ id: "x", name: "X", portionFactor: value }] })
			.household[0]?.portionFactor;

	assert.equal(factor(0), 1, "nul porties is geen antwoord");
	assert.equal(factor(-2), 1);
	assert.equal(factor("veel"), 1);
	assert.equal(factor(0.5), 0.5, "maar een half kind mag wel");
});

test("naamloze huisgenoten en maaltijden verdwijnen", () => {
	const settings = normaliseSettings({
		household: [{ name: "  " }, { name: "Jacorine", portionFactor: 1 }],
		meals: [{ name: "Dinner" }, {}],
	});
	assert.deepEqual(
		settings.household.map((person) => person.name),
		["Jacorine"]
	);
	assert.deepEqual(settings.meals.map((meal) => meal.name), ["Dinner"]);
});

test("een leeg huishouden valt terug op de standaard", () => {
	// Zonder mensen en zonder maaltijden is er niets te plannen.
	assert.deepEqual(normaliseSettings({ household: [] }).household, DEFAULT_SETTINGS.household);
	assert.deepEqual(normaliseSettings({ meals: [] }).meals, DEFAULT_SETTINGS.meals);
});

test("een leeg mappad valt terug op de standaard", () => {
	assert.equal(normaliseSettings({ recipeFolder: "   " }).recipeFolder, "Recipes");
	assert.equal(normaliseSettings({ recipeFolder: "Eten" }).recipeFolder, "Eten");
});

test("de weekstart moet een dag van de week zijn", () => {
	assert.equal(normaliseSettings({ weekStartDay: 6 }).weekStartDay, 6);
	assert.equal(normaliseSettings({ weekStartDay: 7 }).weekStartDay, 1);
	assert.equal(normaliseSettings({ weekStartDay: "maandag" }).weekStartDay, 1);
});

test("kapotte timers gaan eruit, lopende blijven", () => {
	const { cookTimers } = normaliseSettings({
		cookTimers: {
			"Recipes/A.md": { "1:0": { startedAt: 100, seconds: 60 }, "2:0": { seconds: 0 } },
			"Recipes/B.md": { "1:0": { startedAt: "gisteren", seconds: 60 } },
		},
	});
	assert.deepEqual(cookTimers, { "Recipes/A.md": { "1:0": { startedAt: 100, seconds: 60 } } });
});
