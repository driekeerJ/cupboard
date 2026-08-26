/**
 * `date.ts` wordt door elk scherm gebruikt en rekent bewust in lokale tijd:
 * een weekplan hoort bij de dagen zoals de gebruiker ze beleeft, niet bij UTC.
 * Vandaar de zomertijdgrens hieronder.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, startOfWeek, toISODate, weekId } from "../../src/date";

test("weekstart maandag", () => {
	// Woensdag 26 augustus 2026.
	assert.equal(toISODate(startOfWeek(new Date(2026, 7, 26), 1)), "2026-08-24");
});

test("weekstart zondag", () => {
	assert.equal(toISODate(startOfWeek(new Date(2026, 7, 26), 0)), "2026-08-23");
});

test("weekstart zaterdag", () => {
	assert.equal(toISODate(startOfWeek(new Date(2026, 7, 26), 6)), "2026-08-22");
});

test("op de weekstart zelf verschuift er niets", () => {
	assert.equal(toISODate(startOfWeek(new Date(2026, 7, 24), 1)), "2026-08-24");
});

test("dagen optellen over de zomertijdgrens", () => {
	// In Europa gaat de klok in de nacht van 24 op 25 oktober 2026 een uur
	// terug. Met kale milliseconden zou 25 oktober er twee keer staan.
	assert.equal(toISODate(addDays(new Date(2026, 9, 24), 1)), "2026-10-25");
	assert.equal(toISODate(addDays(new Date(2026, 9, 24), 2)), "2026-10-26");
	assert.equal(toISODate(addDays(new Date(2026, 2, 28), 2)), "2026-03-30");
});

test("dagen optellen over een maand- en jaargrens", () => {
	assert.equal(toISODate(addDays(new Date(2026, 11, 30), 3)), "2027-01-02");
});

test("weeknummer volgt ISO 8601, ongeacht de gekozen weekstart", () => {
	assert.equal(weekId(startOfWeek(new Date(2026, 7, 26), 1)), "2026-W35");
	assert.equal(weekId(startOfWeek(new Date(2026, 7, 26), 0)), "2026-W35");
	// De eerste dagen van januari horen bij de laatste week van het jaar ervoor.
	assert.equal(weekId(startOfWeek(new Date(2027, 0, 1), 1)), "2026-W53");
});
