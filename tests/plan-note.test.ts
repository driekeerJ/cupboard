/**
 * Het weekplan wordt in een notitie geschreven waar ook iemands eigen tekst in
 * staat. Deze tests gaan over wat daar níét mee mag gebeuren.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const PATH = "Meal plans/2026-W35.md";

function plan(note: string) {
	return makeHarness({ [PATH]: note });
}

const BLOK = [
	"```meal-plan",
	"weekStart: 2026-08-24",
	"days:",
	"  - date: 2026-08-26",
	"    meals:",
	"      - meal: Dinner",
	"        recipes:",
	"          - recipe: '[[Nasi]]'",
	"            eaters: []",
	"            guests: 0",
	"```",
].join("\n");

test("een dagnotitie met $& plakt het oude blok er niet in", async () => {
	// M14. `content.replace(pattern, block)` legt $-reeksen in `block` uit als
	// terugverwijzing, en de dagnotitie is vrije tekst die je zelf typt.
	const h = plan(`# Week 35\n\n${BLOK}\n`);
	const week = await h.plugin.plans.load(WEEK);
	week.days[0].note = "kosten $& en $1";
	await h.plugin.plans.save(WEEK, week);

	const after = h.vault.read(PATH);
	assert.match(after, /note: kosten \$& en \$1/);
	assert.equal(after.split("```meal-plan").length - 1, 1, "één blok, geen ingeplakt oud blok");
});

test("een blok zonder sluitende fence wordt niet aangevuld met een tweede", async () => {
	// H6. Er kwam dan een tweede blok onderaan; de opslag daarna matchte van de
	// oude opening tot de nieuwe sluiting en at alles ertussen op — inclusief
	// wat de gebruiker daar zelf had geschreven.
	const kapot = ["# Week 35", "", "```meal-plan", "weekStart: 2026-08-24", "", "## Mijn notities", "", "- niet kwijtraken"].join("\n");
	const h = plan(kapot);

	const week = await h.plugin.plans.load(WEEK);
	await h.plugin.plans.save(WEEK, week);

	const after = h.vault.read(PATH);
	assert.equal(after, kapot, "onaangeroerd gelaten");
	assert.match(after, /- niet kwijtraken/);
});

test("eigen tekst rond het blok blijft staan", async () => {
	const h = plan(`# Week 35\n\n## Boven\n\n${BLOK}\n\n## Onder\n\n- blijft\n`);
	const week = await h.plugin.plans.load(WEEK);
	week.days[0].note = "training";
	await h.plugin.plans.save(WEEK, week);

	const after = h.vault.read(PATH);
	assert.match(after, /## Boven/);
	assert.match(after, /## Onder\n\n- blijft/);
	assert.match(after, /note: training/);
});
