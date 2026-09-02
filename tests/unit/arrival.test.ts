/**
 * Wanneer de boodschappen van een winkel in huis zijn, en waar een product
 * dus gekocht moet worden. Alle sommen hier draaien om één vraag: is deze
 * winkel op tijd voor het moment waarop je het nodig hebt?
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	arrivalsByShop,
	arrivesInTime,
	assignShop,
	compareMoments,
	earliest,
	stopMoment,
	type DatedStop,
} from "../../src/arrival";
import type { MealType } from "../../src/types";

const MEALS: MealType[] = [
	{ id: "breakfast", name: "Breakfast" },
	{ id: "lunch", name: "Lunch" },
	{ id: "dinner", name: "Dinner" },
];

const stop = (extra: Partial<DatedStop> & { date: string; shop: string }): DatedStop =>
	extra;

test("voor een maaltijd is dat punt in de dag zelf", () => {
	assert.deepEqual(
		stopMoment(
			stop({ date: "2026-09-04", shop: "AH", meal: "Dinner", when: "before" }),
			MEALS
		),
		{ date: "2026-09-04", meal: 2 }
	);
});

test("na de laatste maaltijd rolt door naar de volgende ochtend", () => {
	// Een bezorging ná het avondeten is er voor het ontbijt, niet voor dat
	// avondeten. Dit is precies het geval waar het hele mechanisme om begon.
	assert.deepEqual(
		stopMoment(
			stop({ date: "2026-09-04", shop: "AH", meal: "Dinner", when: "after" }),
			MEALS
		),
		{ date: "2026-09-05", meal: 0 }
	);
});

test("na een maaltijd midden op de dag is de volgende maaltijd", () => {
	assert.deepEqual(
		stopMoment(
			stop({ date: "2026-09-04", shop: "AH", meal: "Lunch", when: "after" }),
			MEALS
		),
		{ date: "2026-09-04", meal: 2 }
	);
});

test("een onbekende maaltijdnaam telt als het begin van de dag", () => {
	// De maaltijd kan hernoemd zijn, of het blok is met de hand getypt. Te
	// vroeg is hier de veilige kant: je hebt het dan al in huis.
	assert.deepEqual(
		stopMoment(stop({ date: "2026-09-04", shop: "AH", meal: "Brunch" }), MEALS),
		{ date: "2026-09-04", meal: 0 }
	);
});

test("de vroegste van twee momenten van dezelfde winkel telt", () => {
	const arrivals = arrivalsByShop(
		[
			stop({ date: "2026-09-06", shop: "Lidl" }),
			stop({ date: "2026-09-02", shop: "Lidl", meal: "Lunch", when: "after" }),
		],
		MEALS
	);
	assert.deepEqual(arrivals.get("lidl"), { date: "2026-09-02", meal: 2 });
});

test("een winkel zonder moment in het plan is altijd op tijd", () => {
	assert.equal(arrivesInTime(null, { date: "2026-09-02", meal: 0 }), true);
});

test("een product zonder maaltijd heeft geen deadline", () => {
	// Gewone voorraadaanvulling: die mag rustig vrijdag komen.
	assert.equal(arrivesInTime({ date: "2026-09-04", meal: 2 }, null), true);
});

test("op tijd is inclusief het moment zelf", () => {
	const arrival = { date: "2026-09-04", meal: 2 };
	assert.equal(arrivesInTime(arrival, { date: "2026-09-04", meal: 2 }), true);
	assert.equal(arrivesInTime(arrival, { date: "2026-09-04", meal: 1 }), false);
	assert.equal(arrivesInTime(arrival, { date: "2026-09-05", meal: 0 }), true);
});

test("compareMoments kijkt eerst naar de dag, dan naar de maaltijd", () => {
	assert.ok(
		compareMoments({ date: "2026-09-03", meal: 0 }, { date: "2026-09-03", meal: 2 }) < 0
	);
	assert.ok(
		compareMoments({ date: "2026-09-04", meal: 0 }, { date: "2026-09-03", meal: 2 }) > 0
	);
	assert.deepEqual(earliest(null, { date: "2026-09-03", meal: 2 }), {
		date: "2026-09-03",
		meal: 2,
	});
});

/** Woensdag Lidl, vrijdag AH ná het avondeten: het geval waar dit voor is. */
const WEEK = arrivalsByShop(
	[
		stop({ date: "2026-09-02", shop: "Lidl", meal: "Lunch", when: "before" }),
		stop({ date: "2026-09-04", shop: "AH", meal: "Dinner", when: "after" }),
	],
	MEALS
);

test("alleen bij de AH te krijgen en nodig vóór de bezorging: te laat", () => {
	// Geen stille verhuizing naar een winkel waar dit niet ligt. Dit is het
	// signaal waarop de planner het maaltijdblokje geel maakt.
	assert.deepEqual(assignShop(["AH"], { date: "2026-09-03", meal: 2 }, WEEK), {
		shop: "AH",
		late: true,
	});
});

test("ook bij de Lidl te krijgen: dan verhuist het wél", () => {
	assert.deepEqual(
		assignShop(["AH", "Lidl"], { date: "2026-09-03", meal: 2 }, WEEK),
		{ shop: "Lidl", late: false, movedFrom: "AH" }
	);
});

test("de bezorging valt ná het avondeten van die dag, dus die maaltijd niet", () => {
	assert.equal(
		assignShop(["AH", "Lidl"], { date: "2026-09-04", meal: 2 }, WEEK).shop,
		"Lidl"
	);
});

test("de eerste winkel wint zodra hij op tijd is", () => {
	// Zaterdagochtend haalt de AH-bezorging het wél, en dan telt de voorkeur
	// uit de productnotitie — niet welke winkel toevallig het eerst langskomt.
	assert.deepEqual(
		assignShop(["AH", "Lidl"], { date: "2026-09-05", meal: 0 }, WEEK),
		{ shop: "AH", late: false }
	);
});

test("een AH-product voor zaterdagochtend blijft bij de AH", () => {
	assert.deepEqual(assignShop(["AH"], { date: "2026-09-05", meal: 0 }, WEEK), {
		shop: "AH",
		late: false,
	});
});

test("een Lidl-product blijft bij de Lidl", () => {
	assert.deepEqual(assignShop(["Lidl"], { date: "2026-09-03", meal: 2 }, WEEK), {
		shop: "Lidl",
		late: false,
	});
});

test("nodig vóór élke winkel: te laat, en het blijft bij de eerste staan", () => {
	// Woensdagochtend is er nog niets binnen, ook de Lidl niet.
	assert.deepEqual(
		assignShop(["AH", "Lidl"], { date: "2026-09-02", meal: 0 }, WEEK),
		{ shop: "AH", late: true }
	);
});

test("een product zonder winkel wordt nergens heen geduwd", () => {
	assert.deepEqual(assignShop([], { date: "2026-09-02", meal: 0 }, WEEK), {
		shop: "",
		late: false,
	});
});

test("zonder boodschappenmomenten verandert er niets", () => {
	const empty = arrivalsByShop([], MEALS);
	assert.deepEqual(assignShop(["AH"], { date: "2026-09-02", meal: 0 }, empty), {
		shop: "AH",
		late: false,
	});
});
