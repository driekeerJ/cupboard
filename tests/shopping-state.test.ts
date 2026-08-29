/**
 * De lopende boodschappenronde staat in een JSON in de vault, niet in het
 * geheugen en niet in data.json. Reden: je begint op je laptop en staat met je
 * telefoon in de winkel, en Obsidian Sync neemt alleen de vault mee.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../src/date";
import { loadFixture } from "./harness/fixtures";
import { makeHarness } from "./harness/plugin";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);

async function run(files?: Record<string, string>) {
	const harness = makeHarness({ ...loadFixture("week-basis"), ...files });
	await harness.rebuild(WEEK);
	return harness;
}

test("wat in het mandje ligt wordt weggeschreven", async () => {
	const h = await run();
	const ui = h.plugin.products.byPath("Products/Ui.md")!;
	await h.plugin.list.markBought(ui);

	const state = JSON.parse(h.vault.read("Pantry/shopping.json")) as {
		version: number;
		bought: Record<string, { count: unknown; check: boolean }>;
	};
	assert.equal(state.version, 1);
	assert.deepEqual(state.bought["Products/Ui.md"], { count: 0, check: false });
});

test("en teruggelezen, met de telling van vóór de tik", async () => {
	const h = await run();
	await h.plugin.list.markBought(h.plugin.products.byPath("Products/Ui.md")!);

	// Een verse start op hetzelfde bestand: de telefoon, of Obsidian opnieuw.
	const later = makeHarness(h.vault.snapshot());
	await later.rebuild(WEEK);
	await later.plugin.list.loadState();

	assert.deepEqual(later.plugin.list.bought.get("Products/Ui.md"), {
		count: 0,
		check: false,
	});

	// En undo kan er weer bij.
	await later.plugin.list.undoBought(later.plugin.products.byPath("Products/Ui.md")!);
	assert.equal(later.plugin.products.byPath("Products/Ui.md")!.count, 0);
});

test("de ± aanpassingen gaan mee", async () => {
	const h = await run();
	h.plugin.list.setNudge("Products/Rijst.md", 2);
	await h.plugin.list.flushState();

	const later = makeHarness(h.vault.snapshot());
	await later.rebuild(WEEK);
	await later.plugin.list.loadState();

	assert.equal(later.plugin.list.nudge.get("Products/Rijst.md"), 2);
});

test("zonder ronde wordt er geen bestand aangemaakt", async () => {
	const h = await run();
	await h.plugin.list.write();
	assert.equal(h.vault.files.has("Pantry/shopping.json"), false);
});

test("kapotte JSON gooit de ronde niet weg", async () => {
	const h = await run({ "Pantry/shopping.json": "{ dit is geen json" });
	await h.plugin.list.markBought(h.plugin.products.byPath("Products/Ui.md")!);
	await h.plugin.list.loadState();

	assert.equal(h.plugin.list.bought.size, 1, "wat we hadden blijft staan");
});

test("onzin in het bestand wordt overgeslagen, de rest niet", async () => {
	const h = await run({
		"Pantry/shopping.json": JSON.stringify({
			version: 1,
			bought: { "Products/Ui.md": { count: "+", check: true } },
			nudge: { "Products/Rijst.md": "veel", "Products/Passata.md": 3 },
		}),
	});
	await h.plugin.list.loadState();

	assert.deepEqual(h.plugin.list.bought.get("Products/Ui.md"), {
		count: "plus",
		check: true,
	});
	assert.equal(h.plugin.list.nudge.has("Products/Rijst.md"), false);
	assert.equal(h.plugin.list.nudge.get("Products/Passata.md"), 3);
});
