/**
 * De maten die Pantry kent, op één plek.
 *
 * Er stonden er twee: `needs.ts` had de omrekentabellen en `ingredients.ts` een
 * lijst met precies dezelfde twintig woorden om een maat te herkennen. Ze
 * werden met de hand gelijk gehouden — en een maat die je aan de ene lijst
 * toevoegt en aan de andere vergeet, wordt stilletjes als "geen maat" gelezen.
 * Dan telt "200 dl bouillon" als tweehonderd flessen.
 */

/** Everything reduced to one base unit per family, so 400 g and 0.4 kg meet. */
export const MASS: Record<string, number> = {
	mg: 0.001, g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kilo: 1000, kilos: 1000,
	oz: 28.3495, lb: 453.592, lbs: 453.592,
};

export const VOLUME: Record<string, number> = {
	ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000,
	liter: 1000, liters: 1000, litre: 1000, litres: 1000,
};

/** Weight and volume: scale exactly, then round to a number you can measure. */
export const MASS_UNITS = [...Object.keys(MASS), ...Object.keys(VOLUME)];

/** Spoons and cups: quarters, because that is what measuring spoons come in. */
export const SPOON_UNITS = [
	"tsp", "tsps", "teaspoon", "teaspoons",
	"tbsp", "tbsps", "tablespoon", "tablespoons",
	"tl", "el", "cup", "cups", "mug", "mugs", "kopje", "kopjes",
];

/** Measures that mean "roughly this much" and do not survive being scaled. */
export const VAGUE_UNITS = [
	"handful", "handfuls", "handvol", "pinch", "pinches", "snufje",
	"dash", "dashes", "splash", "splashes", "scheutje", "glug", "drizzle",
	"bunch", "bunches", "bosje", "sprig", "sprigs", "takje", "knob", "knobs",
];

/** "Tbsp." en "tbsp" zijn dezelfde maat; alleen de spelling verschilt. */
export function unitKey(unit: string): string {
	return unit.trim().toLowerCase().replace(/\.$/, "");
}

export function sameUnit(a: string, b: string): boolean {
	return a.length > 0 && b.length > 0 && unitKey(a) === unitKey(b);
}

/** De tabel waar deze maat in staat, of null als het er geen is. */
export function family(unit: string): Record<string, number> | null {
	const key = unitKey(unit);
	if (key in MASS) return MASS;
	if (key in VOLUME) return VOLUME;
	return null;
}
