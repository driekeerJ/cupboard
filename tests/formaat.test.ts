/**
 * Een oudere build mag een nieuwere notitie niet herschrijven.
 *
 * Twee apparaten, één vault, en Obsidian Sync brengt de plugin niet vanzelf
 * mee. Zie src/format.ts.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { PANTRY_FORMAT } from "../src/format";
import { setNote } from "../src/plan";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const PLAN = "Meal plans/2026-W35.md";
const NEWER = PANTRY_FORMAT + 1;

test("een weekplan van een nieuwere Pantry wordt gelezen als onbekend en niet geschreven", async () => {
	const h = makeHarness(loadFixture("week-basis"));
	const original = h.vault.read(PLAN);
	h.vault.write(PLAN, original.replace("weekStart: 2026-08-24", `format: ${NEWER}\nweekStart: 2026-08-24`));

	const plan = await h.plugin.plans.load(WEEK);
	assert.match(plan.unreadable ?? "", /newer Pantry/);
	assert.deepEqual(plan.days, []);

	await assert.rejects(
		h.plugin.plans.update(WEEK, (fresh) => setNote(fresh, "2026-08-26", "hoi")),
		/newer Pantry/
	);
	assert.match(h.vault.read(PLAN), new RegExp(`format: ${NEWER}`), "onaangeroerd");
});

test("een eigen weekplan krijgt het formaatnummer mee", async () => {
	const h = makeHarness(loadFixture("week-basis"));
	await h.plugin.plans.update(WEEK, (fresh) => setNote(fresh, "2026-08-26", "hoi"));
	assert.match(h.vault.read(PLAN), new RegExp(`\`\`\`meal-plan\\n#[^\\n]*\\nformat: ${PANTRY_FORMAT}\\n`));
	const plan = await h.plugin.plans.load(WEEK);
	assert.equal(plan.unreadable, undefined);
});

test("een lijst van een nieuwere Pantry staat op slot", async () => {
	const h = makeHarness(loadFixture("week-basis"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	const list = await h.plugin.lists.create({ date: "2026-08-25", arrival: null, shops: ["Lidl"], meals: [] });
	assert.ok(list);
	assert.equal(list.frozen, null);

	const note = h.note(list).replace(`format: ${PANTRY_FORMAT}`, `format: ${NEWER}`);
	h.vault.write(list.path, note);
	await h.plugin.lists.refreshAll();

	const known = h.plugin.lists.byPath(list.path);
	assert.ok(known, "wel te zien");
	assert.match(known.frozen ?? "", /newer Pantry/);
	assert.match(h.plugin.lists.frozenReason() ?? "", /update Pantry on this device/);
	assert.equal(h.note(list), note, "de spiegel-verversing heeft hem niet aangeraakt");

	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	await assert.rejects(h.plugin.lists.markBought(known, ui), /newer Pantry/);
	assert.equal(h.note(list), note);
	assert.equal(h.vault.read("Products/Ui.md").includes("count: +"), false, "en de voorraad is niet geboekt");
});
