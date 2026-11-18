/**
 * De telronde over alle open lijsten, op het scherm.
 *
 * De regel zelf staat in tests/telronde.test.ts. Hier gaat het om wat je
 * ziet en aantikt: de knop op het overzicht, het label per rij, en dat een
 * telling in de ronde bij de goede lijst aankomt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startOfWeek } from "../../src/date";
import { ListsView } from "../../src/ui/lists-view";
import { ROUND_VIEW_TYPE } from "../../src/ui/nav";
import { RoundView } from "../../src/ui/round-view";
import { all, click, text } from "../harness/dom";
import { loadFixture } from "../harness/fixtures";
import { makeScreenHarness } from "../harness/screen";

const WEEK = startOfWeek(new Date(2026, 7, 26), 1);
const AH = "Albert Heijn";
const LIDL_LIST = "Lidl · Wed 26 Aug";
const AH_LIST = "Albert Heijn · Fri 28 Aug";

async function run(trips: ("lidl" | "ah")[] = ["lidl", "ah"]) {
	const h = makeScreenHarness(loadFixture("twee-ritten"), {
		household: [{ id: "jeroen", name: "Jeroen", portionFactor: 1 }],
	});
	await h.rebuild(WEEK);
	if (trips.includes("lidl")) {
		await h.plugin.lists.create({
			date: "2026-08-26", arrival: null, shops: ["Lidl"], staples: ["Lidl"],
			meals: [{ date: "2026-08-27", meal: "Dinner", recipe: "Curry met feta" }],
		});
	}
	if (trips.includes("ah")) {
		await h.plugin.lists.create({
			date: "2026-08-28", arrival: null, shops: [AH], staples: [AH],
			meals: [{ date: "2026-08-29", meal: "Dinner", recipe: "Tacos" }],
		});
	}
	await h.plugin.lists.refreshAll();
	return h;
}

/** Per rij: de naam, het lijstlabel en wat er rechts staat. */
function rows(root: HTMLElement): Record<string, { tag: string; late: boolean; status: string }> {
	const out: Record<string, { tag: string; late: boolean; status: string }> = {};
	for (const row of all(root, ".pantry-stock-row")) {
		const tag = row.querySelector(".pantry-status-tag");
		out[text(row.querySelector(".pantry-stock-name span"))] = {
			tag: text(tag),
			late: tag?.classList.contains("is-late") ?? false,
			status: text(row.querySelector(".pantry-status")),
		};
	}
	return out;
}

test("Check stock staat op het overzicht zodra er twee lijsten open staan", async () => {
	const one = await (await run(["ah"])).open(ListsView);
	const hidden = one.root.querySelector("button.pantry-round-button");
	assert.ok(hidden?.classList.contains("is-hidden"), "met één lijst is haar eigen Check stock hetzelfde");

	const two = await (await run()).open(ListsView);
	const button = two.root.querySelector("button.pantry-round-button");
	assert.equal(button?.classList.contains("is-hidden"), false);
	await click(button);
	assert.deepEqual(two.leaf.opened.map((to) => to.type), [ROUND_VIEW_TYPE]);
});

test("elke rij zegt op welke lijst het product komt", async () => {
	const h = await run();
	const { root } = await h.open(RoundView);

	assert.equal(text(root.querySelector(".pantry-round-lists")), `For ${LIDL_LIST} · ${AH_LIST}`);
	const seen = rows(root);
	assert.deepEqual(Object.keys(seen).sort(), ["Feta", "Kokosmelk", "Olijfolie", "Tortilla", "Ui"]);
	assert.equal(seen.Ui?.tag, LIDL_LIST);
	assert.equal(seen.Ui?.status, "buy 4", "het minimum plus de taco's van de andere lijst");
	assert.equal(seen.Olijfolie?.tag, AH_LIST, "de primaire winkel, niet de vroegste lijst");
	assert.equal(seen.Kokosmelk?.tag, LIDL_LIST, "de AH is te laat voor donderdag");
	assert.equal(seen.Tortilla?.tag, LIDL_LIST, "gevraagd door de AH-lijst, gehaald bij de Lidl");
	assert.deepEqual(seen.Feta, { tag: "no shop in time", late: true, status: "buy 1" });
});

test("één keer tellen werkt beide lijsten bij", async () => {
	const h = await run();
	const { root } = await h.open(RoundView);
	const lidl = h.plugin.lists.all()[0]!;
	assert.match(h.note(lidl), /\[\[Tortilla\]\]/);

	// Er ligt nog een tortilla: tik "1" op de strip van die rij.
	const row = all(root, ".pantry-stock-row").find(
		(el) => text(el.querySelector(".pantry-stock-name span")) === "Tortilla"
	);
	await click(all(row!, "button.pantry-strip-item").find((el) => text(el) === "1"));

	assert.match(h.vault.read("Products/Tortilla.md"), /^count: 1$/m);
	assert.deepEqual(rows(root).Tortilla, { tag: "", late: false, status: "enough" });
	await h.plugin.lists.refreshAll();
	assert.doesNotMatch(h.note(lidl), /\[\[Tortilla\]\]/, "en hij is van de Lidl-lijst af");
});

test("zonder open lijsten zegt het scherm wat er moet gebeuren", async () => {
	const { root } = await (await run([])).open(RoundView);
	assert.equal(text(root.querySelector(".pantry-head-sub")), "no open lists");
	assert.match(text(root.querySelector(".pantry-body")), /Start a list first/);
});
