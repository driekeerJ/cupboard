/**
 * Het gezin als notities (F1) en timers die niet blijven liggen (F2).
 *
 * Beide gingen over hetzelfde: dingen die in `data.json` stonden en daar niet
 * thuishoren — het ene omdat het gezinsadministratie is, het andere omdat het
 * alleen maar groeide.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { CookStore } from "../src/cook";
import { HouseholdIndex } from "../src/people";
import { makeHarness } from "./harness/plugin";

const FILES = {
	"Household/Jeroen.md": "---\nportionFactor: 1\n---\n\n# Jeroen\n",
	"Household/Kind.md": "---\nportiefactor: 0.5\n---\n\n# Kind\n",
	"Household/Gast.md": "# Gast\n",
};

test("zonder map blijft de lijst uit de instellingen leidend", () => {
	const h = makeHarness(FILES);
	h.plugin.people.build();

	assert.equal(h.plugin.people.usingNotes(), false);
	assert.deepEqual(
		h.plugin.people.all().map((m) => m.name),
		["Me"]
	);
});

test("met een map bepalen de notities wie er meeëet", () => {
	const h = makeHarness(FILES, { householdFolder: "Household" });
	h.plugin.people.build();

	assert.equal(h.plugin.people.usingNotes(), true);
	assert.deepEqual(
		h.plugin.people.all().map((m) => `${m.name} ${m.portionFactor}`),
		["Gast 1", "Jeroen 1", "Kind 0.5"]
	);
	// Een halve portie telt ook als een halve portie.
	assert.equal(h.plugin.cook.householdServings(), 2.5);
});

test("moveToNotes schrijft één notitie per persoon en overschrijft niets", async () => {
	const h = makeHarness(FILES, {
		householdFolder: "Household",
		household: [
			{ id: "a", name: "Jeroen", portionFactor: 1 },
			{ id: "b", name: "Nieuw", portionFactor: 0.5 },
		],
	});
	h.plugin.people.build();

	const before = h.vault.read("Household/Jeroen.md");
	const written = await h.plugin.people.moveToNotes();

	assert.equal(written, 1);
	assert.equal(h.vault.read("Household/Jeroen.md"), before);
	assert.match(h.vault.read("Household/Nieuw.md"), /portionFactor: 0\.5/);
});

test("timers van een verdwenen sessie worden opgeruimd", () => {
	const h = makeHarness({ "Cook sessions/Soep.md": "# Soep\n" });
	const cook = new CookStore(h.plugin);
	const now = Date.now();

	h.plugin.settings.cookTimers = {
		"Cook sessions/Soep.md": { pan: { startedAt: now, seconds: 600 } },
		"Cook sessions/Weg.md": { pan: { startedAt: now, seconds: 600 } },
	};

	assert.equal(cook.pruneTimers(), true);
	assert.deepEqual(Object.keys(h.plugin.settings.cookTimers), [
		"Cook sessions/Soep.md",
	]);
});

test("een timer die gisteren afliep telt niet meer als lopend", () => {
	const h = makeHarness({ "Cook sessions/Soep.md": "# Soep\n" });
	const cook = new CookStore(h.plugin);
	const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

	h.plugin.settings.cookTimers = {
		"Cook sessions/Soep.md": {
			oud: { startedAt: twoDaysAgo, seconds: 600 },
			nu: { startedAt: Date.now(), seconds: 600 },
		},
	};

	assert.equal(cook.pruneTimers(), true);
	assert.deepEqual(
		Object.keys(h.plugin.settings.cookTimers["Cook sessions/Soep.md"] ?? {}),
		["nu"]
	);
});

test("hernoemen laat de timers meeverhuizen", async () => {
	const h = makeHarness({ "Cook sessions/Soep.md": "# Soep\n" });
	const cook = new CookStore(h.plugin);
	h.plugin.settings.cookTimers = {
		"Cook sessions/Soep.md": { pan: { startedAt: Date.now(), seconds: 600 } },
	};

	await cook.renameSession("Cook sessions/Soep.md", "Cook sessions/Bouillon.md");

	assert.deepEqual(Object.keys(h.plugin.settings.cookTimers), [
		"Cook sessions/Bouillon.md",
	]);
});

test("een index zonder map leest niets, ook niet de hele vault", () => {
	const h = makeHarness(FILES, { householdFolder: "Bestaat niet" });
	const people = new HouseholdIndex(h.plugin);
	people.build();

	assert.equal(people.usingNotes(), false);
});
