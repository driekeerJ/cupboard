/**
 * Een kooksessie is een notitie, en die notitie is de waarheid. Deze tests
 * bewaken de ronde: schrijven, teruglezen, aanvinken, en het beheerde stuk
 * vervangen zonder de aantekeningen eronder aan te raken.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseCookSession,
	renderSession,
	replaceCookRegion,
	safeFileName,
	sessionPath,
	setServings,
	setTick,
	type SessionInput,
} from "../../src/cook-session";

const INPUT: SessionInput = {
	recipe: "Aardappelsoep",
	date: "2026-08-29",
	servings: 6,
	groups: [
		{ label: "Step 1", lines: ["3 uien, gesnipperd", "2 tenen knoflook"] },
		{ label: "Rest", lines: ["zout en peper naar smaak"] },
	],
	steps: ["Snipper de ui.", "Bak 5 min."],
};

test("de notitie leest terug wat erin geschreven is", () => {
	const note = parseCookSession(renderSession(INPUT));
	assert.equal(note.recipe, "Aardappelsoep");
	assert.equal(note.servings, 6);
	assert.deepEqual(
		note.ingredients.map((line) => [line.group, line.text, line.done]),
		[
			["Step 1", "3 uien, gesnipperd", false],
			["Step 1", "2 tenen knoflook", false],
			["Rest", "zout en peper naar smaak", false],
		]
	);
	assert.deepEqual(
		note.steps.map((line) => [line.index, line.text]),
		[
			[0, "Snipper de ui."],
			[1, "Bak 5 min."],
		]
	);
});

test("een vinkje raakt precies één regel", () => {
	const content = renderSession(INPUT);
	const note = parseCookSession(content);
	const second = note.ingredients[1];
	assert.ok(second);

	const after = parseCookSession(setTick(content, second.line, true));
	assert.deepEqual(
		after.ingredients.map((line) => line.done),
		[false, true, false]
	);
});

test("twee gelijke regels raken niet door elkaar", () => {
	const input: SessionInput = {
		...INPUT,
		groups: [{ label: "Step 1", lines: ["2 el taco kruiden", "2 el taco kruiden"] }],
	};
	const content = renderSession(input);
	const note = parseCookSession(content);
	const first = note.ingredients[0];
	assert.ok(first);

	const after = parseCookSession(setTick(content, first.line, true));
	assert.deepEqual(
		after.ingredients.map((line) => line.done),
		[true, false]
	);
});

test("herschalen laat de aantekeningen eronder staan", () => {
	const content = `${renderSession(INPUT).trimEnd()}\nVolgende keer minder zout.\n`;
	const bigger: SessionInput = {
		...INPUT,
		servings: 12,
		groups: [{ label: "Step 1", lines: ["6 uien, gesnipperd"] }],
	};

	const next = setServings(replaceCookRegion(content, bigger), 12);
	const note = parseCookSession(next);

	assert.equal(note.servings, 12);
	assert.deepEqual(
		note.ingredients.map((line) => line.text),
		["6 uien, gesnipperd"]
	);
	assert.ok(next.includes("Volgende keer minder zout."));
	assert.ok(next.includes("## Notes"));
});

test("handmatig hernoemde kopjes blijven staan", () => {
	const content = renderSession(INPUT).replace("**Rest**", "**Op tafel**");
	const note = parseCookSession(content);
	assert.equal(note.ingredients[2]?.group, "Op tafel");
});

test("de bestandsnaam is datum plus recept", () => {
	assert.equal(
		sessionPath("Cook sessions", "2026-08-29", "Aardappelsoep"),
		"Cook sessions/2026-08-29 Aardappelsoep.md"
	);
	assert.equal(safeFileName("Pasta: met #saus"), "Pasta met saus");
});
