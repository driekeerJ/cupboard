/**
 * De focusmodus van de kookmodus: één dia tegelijk.
 *
 * Met deeg aan je handen wil je niet scrollen door achttien regels om te zien
 * waar je was. Een dia is precies wat je nú doet: één groep ingrediënten om
 * klaar te zetten, of één stap van de bereiding. Eerst alle ingrediënten (de
 * mise en place), daarna de stappen — dezelfde volgorde als de lijst eronder,
 * zodat wisselen tussen lijst en focus je nergens laat zoeken.
 *
 * Dit bestand rekent alleen. De vinkjes zelf blijven de regels uit de notitie
 * (`CookLine`); een dia wijst ze aan en bezit ze niet. Zo is er maar één plek
 * waar "gedaan" staat, en die plek is het bestand.
 */

import type { CookLine, CookNote } from "./cook-session";

export type FocusSlideKind = "ingredients" | "step";

export interface FocusSlide {
	kind: FocusSlideKind;
	/**
	 * Het kopje uit de notitie ("Step 2", "Rest") of het stapnummer. `null`
	 * als de ingrediënten niet gegroepeerd zijn — dan is er geen kopje te
	 * tonen en verzinnen we er ook geen.
	 */
	label: string | null;
	lines: CookLine[];
}

/**
 * De dia's in de volgorde waarin je ze doorloopt.
 *
 * Opeenvolgende ingrediënten met hetzelfde kopje vormen één dia, net als in de
 * lijstweergave. Elke stap is een eigen dia: een stap is al het kleinste dat
 * je in één keer doet.
 */
export function focusSlides(note: CookNote): FocusSlide[] {
	const slides: FocusSlide[] = [];

	let current: FocusSlide | null = null;
	for (const line of note.ingredients) {
		if (!current || current.label !== line.group) {
			current = { kind: "ingredients", label: line.group, lines: [] };
			slides.push(current);
		}
		current.lines.push(line);
	}

	for (const line of note.steps) {
		slides.push({ kind: "step", label: `Step ${line.index + 1}`, lines: [line] });
	}

	return slides;
}

export function isSlideDone(slide: FocusSlide | undefined): boolean {
	return slide !== undefined && slide.lines.length > 0 && slide.lines.every((line) => line.done);
}

/** Waar je terugkomt als je de focusmodus opent: de eerste dia met werk. */
export function firstOpenSlide(slides: FocusSlide[]): number {
	const open = slides.findIndex((slide) => !isSlideDone(slide));
	if (open >= 0) return open;
	return Math.max(0, slides.length - 1);
}

/**
 * Waar je heen gaat als de dia op `from` af is.
 *
 * Eerst vooruit naar de eerstvolgende dia die nog open staat: wat je al eerder
 * afvinkte hoef je niet nog eens te zien. Is er vooruit niets meer, dan terug
 * naar de eerste open dia die je overgeslagen hebt — die is anders vergeten.
 * `null` betekent: alles is af, blijf staan.
 */
export function nextOpenSlide(slides: FocusSlide[], from: number): number | null {
	for (let index = from + 1; index < slides.length; index += 1) {
		if (!isSlideDone(slides[index])) return index;
	}
	for (let index = 0; index < from; index += 1) {
		if (!isSlideDone(slides[index])) return index;
	}
	return null;
}
