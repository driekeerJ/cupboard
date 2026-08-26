/**
 * Ingredient lines are free text, so scaling means reading a number and a unit
 * off the front of the line and putting a sensible one back. "Sensible" is the
 * point: 1.75 onions helps nobody, so each kind of measure is rounded the way a
 * cook would round it.
 */

const FRACTION_GLYPHS: Record<string, number> = {
	"¼": 0.25,
	"½": 0.5,
	"¾": 0.75,
	"⅓": 1 / 3,
	"⅔": 2 / 3,
	"⅛": 0.125,
};

/** Weight and volume: scale exactly, then round to a number you can measure. */
const MASS_UNITS = [
	"g", "gr", "gram", "grams", "kg", "kilo", "kilos", "mg",
	"ml", "cl", "dl", "l", "lt", "liter", "liters", "litre", "litres",
	"oz", "lb", "lbs",
];

/** Spoons and cups: quarters, because that is what measuring spoons come in. */
const SPOON_UNITS = [
	"tsp", "tsps", "teaspoon", "teaspoons",
	"tbsp", "tbsps", "tablespoon", "tablespoons",
	"tl", "el", "cup", "cups", "mug", "mugs", "kopje", "kopjes",
];

/** Measures that mean "roughly this much" and do not survive being scaled. */
const VAGUE_UNITS = [
	"handful", "handfuls", "handvol", "pinch", "pinches", "snufje",
	"dash", "dashes", "splash", "splashes", "scheutje", "glug", "drizzle",
	"bunch", "bunches", "bosje", "sprig", "sprigs", "takje", "knob", "knobs",
];

export type UnitKind = "mass" | "spoon" | "piece" | "vague";

export interface ParsedIngredient {
	raw: string;
	amount: number | null;
	unit: string | null;
	kind: UnitKind;
	/** Everything after the amount and unit. */
	name: string;
}

function readAmount(text: string): { value: number; length: number } | null {
	const trimmed = text.trimStart();
	const offset = text.length - trimmed.length;

	// "1 ½", "1½"
	const mixed = /^(\d+)\s*([¼½¾⅓⅔⅛])/.exec(trimmed);
	if (mixed) {
		return {
			value: Number(mixed[1]) + FRACTION_GLYPHS[mixed[2]],
			length: offset + mixed[0].length,
		};
	}

	const glyph = /^([¼½¾⅓⅔⅛])/.exec(trimmed);
	if (glyph) {
		return { value: FRACTION_GLYPHS[glyph[1]], length: offset + glyph[0].length };
	}

	// "1/2", "3 / 4"
	const fraction = /^(\d+)\s*\/\s*(\d+)/.exec(trimmed);
	if (fraction) {
		const denominator = Number(fraction[2]);
		if (denominator === 0) return null;
		return {
			value: Number(fraction[1]) / denominator,
			length: offset + fraction[0].length,
		};
	}

	const plain = /^(\d+(?:[.,]\d+)?)/.exec(trimmed);
	if (plain) {
		return {
			value: Number(plain[1].replace(",", ".")),
			length: offset + plain[0].length,
		};
	}

	return null;
}

function classify(unit: string | null): UnitKind {
	if (!unit) return "piece";
	const key = unit.toLowerCase().replace(/\.$/, "");
	if (MASS_UNITS.includes(key)) return "mass";
	if (SPOON_UNITS.includes(key)) return "spoon";
	if (VAGUE_UNITS.includes(key)) return "vague";
	// An unknown word is part of the name, e.g. "3 cloves garlic".
	return "piece";
}

export function parseIngredient(line: string): ParsedIngredient {
	const raw = line.trim();
	const amount = readAmount(raw);
	if (!amount) {
		return { raw, amount: null, unit: null, kind: "vague", name: raw };
	}

	const rest = raw.slice(amount.length).trimStart();
	const word = /^([a-zA-Z]+\.?)(?=\s|$)/.exec(rest);
	const candidate = word ? word[1] : null;
	const kind = classify(candidate);

	// Only a recognised measure is eaten; anything else stays in the name so
	// "3 cloves garlic" reads back exactly as it was written.
	const known = candidate !== null && kind !== "piece";
	return {
		raw,
		amount: amount.value,
		unit: known ? candidate : null,
		kind: known ? kind : "piece",
		name: known ? rest.slice(word![0].length).trimStart() : rest,
	};
}

/** Units written large, where a step of half a unit would be absurd. */
const LARGE_UNITS = ["kg", "kilo", "kilos", "l", "lt", "liter", "liters", "litre", "litres", "lb", "lbs"];

function roundMass(value: number, unit: string | null): number {
	if (unit && LARGE_UNITS.includes(unit.toLowerCase().replace(/\.$/, ""))) {
		// 1.3125 kg should read as 1.3 kg, never as 1.5 kg.
		const step = value < 2 ? 0.05 : 0.1;
		return Math.round(value / step) * step;
	}
	if (value < 10) return Math.round(value * 2) / 2;
	if (value < 50) return Math.round(value);
	if (value < 250) return Math.round(value / 5) * 5;
	if (value < 1000) return Math.round(value / 10) * 10;
	return Math.round(value / 25) * 25;
}

function roundQuarters(value: number): number {
	return Math.max(0.25, Math.round(value * 4) / 4);
}

function roundHalves(value: number): number {
	return Math.max(1, Math.round(value * 2) / 2);
}

export function scaleAmount(
	amount: number,
	kind: UnitKind,
	factor: number,
	unit: string | null = null
): number {
	const scaled = amount * factor;
	if (kind === "mass") return roundMass(scaled, unit);
	if (kind === "spoon") return roundQuarters(scaled);
	if (kind === "piece") return roundHalves(scaled);
	return amount;
}

const GLYPH_FOR: Record<string, string> = {
	"0.25": "¼",
	"0.5": "½",
	"0.75": "¾",
};

/** Fractions read better for spoons and whole items; grams stay decimal. */
export function formatAmount(value: number, kind: UnitKind): string {
	if (Number.isInteger(value)) return `${value}`;

	if (kind === "spoon" || kind === "piece") {
		const whole = Math.floor(value);
		const glyph = GLYPH_FOR[(value - whole).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")];
		if (glyph) return whole === 0 ? glyph : `${whole}${glyph}`;
	}

	return `${Math.round(value * 1000) / 1000}`.replace(/\.0+$/, "");
}

export interface ScaledIngredient {
	/** The line as it should be shown while cooking. */
	text: string;
	/** The line as written in the recipe, when scaling changed it. */
	original: string | null;
}

export function scaleIngredient(line: string, factor: number): ScaledIngredient {
	const parsed = parseIngredient(line);

	if (factor === 1 || parsed.amount === null || parsed.kind === "vague") {
		return { text: parsed.raw, original: null };
	}

	const scaled = scaleAmount(parsed.amount, parsed.kind, factor, parsed.unit);
	const amount = formatAmount(scaled, parsed.kind);
	const unit = parsed.unit ? `${parsed.unit} ` : "";
	const text = `${amount} ${unit}${parsed.name}`.trim();

	// Rewriting "1/2" as "½" is not a change worth reporting; only a different
	// quantity is.
	const same = Math.abs(scaled - parsed.amount) < 1e-9;
	return { text, original: same ? null : parsed.raw };
}
