/**
 * De focusmodus toont één dia tegelijk en schuift door als een dia af is.
 * Deze tests bewaken de indeling en waar je na een vinkje terechtkomt.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	firstOpenSlide,
	focusSlides,
	isSlideDone,
	nextOpenSlide,
} from "../../src/cook-focus";
import { parseCookSession, renderSession } from "../../src/cook-session";

const NOTE = parseCookSession(
	renderSession({
		recipe: "Zuurkoolstamppot",
		date: "2026-11-08",
		servings: 4,
		groups: [
			{ label: "Step 2", lines: ["2 kg aardappels", "zout en peper"] },
			{ label: "Step 3", lines: ["1 ui"] },
			{ label: "Rest", lines: ["150 ml sojadrink"] },
		],
		steps: ["Verwarm de oven voor op 200 °C.", "Kook de aardappels 20 minuten.", "Fruit de ui."],
	})
);

test("eerst de ingrediënten per groep, dan elke stap als eigen dia", () => {
	const slides = focusSlides(NOTE);
	assert.deepEqual(
		slides.map((slide) => [slide.kind, slide.label, slide.lines.length]),
		[
			["ingredients", "Step 2", 2],
			["ingredients", "Step 3", 1],
			["ingredients", "Rest", 1],
			["step", "Step 1", 1],
			["step", "Step 2", 1],
			["step", "Step 3", 1],
		]
	);
});

test("ongegroepeerde ingrediënten vormen één dia zonder verzonnen kopje", () => {
	const note = parseCookSession(
		"## Ingredients\n\n- [ ] 1 ui\n- [ ] 2 wortels\n\n## Method\n\n1. [ ] Snijd.\n"
	);
	const slides = focusSlides(note);
	assert.equal(slides.length, 2);
	assert.equal(slides[0]?.label, null);
	assert.equal(slides[0]?.lines.length, 2);
});

test("een dia is pas af als elke regel erop is afgevinkt", () => {
	const slides = focusSlides(structuredClone(NOTE));
	const first = slides[0];
	assert.ok(first);
	assert.equal(isSlideDone(first), false);
	first.lines[0]!.done = true;
	assert.equal(isSlideDone(first), false);
	first.lines[1]!.done = true;
	assert.equal(isSlideDone(first), true);
});

test("doorschuiven slaat dia's over die al af zijn", () => {
	const slides = focusSlides(structuredClone(NOTE));
	slides[0]!.lines.forEach((line) => (line.done = true));
	slides[1]!.lines.forEach((line) => (line.done = true));
	assert.equal(nextOpenSlide(slides, 0), 2);
});

test("vooruit niets meer open: terug naar de overgeslagen dia", () => {
	const slides = focusSlides(structuredClone(NOTE));
	slides.forEach((slide, index) => {
		if (index !== 1) slide.lines.forEach((line) => (line.done = true));
	});
	assert.equal(nextOpenSlide(slides, 5), 1);
});

test("alles af: blijf staan", () => {
	const slides = focusSlides(structuredClone(NOTE));
	slides.forEach((slide) => slide.lines.forEach((line) => (line.done = true)));
	assert.equal(nextOpenSlide(slides, 5), null);
	assert.equal(firstOpenSlide(slides), 5);
});

test("openen begint bij de eerste dia met werk", () => {
	const slides = focusSlides(structuredClone(NOTE));
	assert.equal(firstOpenSlide(slides), 0);
	slides[0]!.lines.forEach((line) => (line.done = true));
	assert.equal(firstOpenSlide(slides), 1);
	assert.equal(firstOpenSlide([]), 0);
});
