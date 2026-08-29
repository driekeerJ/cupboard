import { parseNumber } from "./number";
import { MASS_UNITS, SPOON_UNITS, VAGUE_UNITS } from "./units";
/**
 * Ingredient lines are free text, so scaling means reading a number and a unit
 * off the front of the line and putting a sensible one back. "Sensible" is the
 * point: 1.75 onions helps nobody, so each kind of measure is rounded the way a
 * cook would round it.
 */

const FRACTION_GLYPHS: Record<string, number> = {
	"¼": 0.25, "½": 0.5, "¾": 0.75,
	"⅓": 1 / 3, "⅔": 2 / 3,
	"⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
	"⅙": 1 / 6, "⅚": 5 / 6,
	"⅐": 1 / 7, "⅑": 1 / 9, "⅒": 0.1,
	"⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

/** Elke glyph hierboven, als teken-klasse voor de regexen. */
const GLYPH_CLASS = `[${Object.keys(FRACTION_GLYPHS).join("")}]`;

/** Zowel de gewone schuine streep als de fractieslash U+2044. */
const SLASH = "[/\u2044]";

/**
 * Woorden die een staart achter de komma tot bereidingsnoot maken.
 *
 * Bewust een lijst en niet "elke staart van één of twee woorden": bij
 * "zout, peper" is de staart een tweede ingrediënt, en die mag niet
 * verdwijnen. Een staart wordt alleen afgeknipt als er een woord in staat dat
 * over de bewerking gaat, niet over wat het is.
 */
const PREPARATION_WORDS = [
	"gesnipperd", "gesneden", "gehakt", "fijngehakt", "grofgehakt", "geraspt",
	"geperst", "geplet", "gepeld", "geschild", "ontpit", "uitgelekt",
	"gewassen", "geroosterd", "gekookt", "gedroogd", "ontdooid", "blokjes",
	"reepjes", "plakjes", "ringen", "partjes", "stukjes", "schijfjes",
	"chopped", "diced", "sliced", "minced", "grated", "peeled", "crushed",
	"drained", "rinsed", "cubed", "halved", "quartered",
];

import { withoutLinks } from "./links";

export { withoutLinks };

export type UnitKind = "mass" | "spoon" | "piece" | "vague";

export interface ParsedIngredient {
	raw: string;
	amount: number | null;
	unit: string | null;
	kind: UnitKind;
	/** Everything after the amount and unit, minus the preparation note. */
	name: string;
	/**
	 * The trailing "(chopped)" or ", finely diced", with its separator, or null.
	 *
	 * Split off so `2 uien (gesnipperd)` matches the product *Ui* without
	 * needing an alias — but kept, because cook mode rebuilds the line when it
	 * scales and dropping the note would lose how to cut the onion.
	 */
	note: string | null;
}

const MIXED_GLYPH = new RegExp(`^(\\d+)\\s*(${GLYPH_CLASS})`);
const GLYPH = new RegExp(`^(${GLYPH_CLASS})`);
/** "1 1/2": een heel getal, spatie, en dan pas de breuk. */
const MIXED_FRACTION = new RegExp(`^(\\d+)\\s+(\\d+)\\s*${SLASH}\\s*(\\d+)`);
const FRACTION = new RegExp(`^(\\d+)\\s*${SLASH}\\s*(\\d+)`);
const RANGE = /^(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)(?=\s|$)/;
const PLAIN = /^(\d+(?:[.,]\d+)?)/;

const decimal = (value: string) => parseNumber(value) ?? Number.NaN;

function readAmount(text: string): { value: number; length: number } | null {
	const trimmed = text.trimStart();
	const offset = text.length - trimmed.length;
	const at = (match: RegExpExecArray, value: number) => ({
		value,
		length: offset + match[0].length,
	});

	// "1 ½", "1½"
	const mixedGlyph = MIXED_GLYPH.exec(trimmed);
	if (mixedGlyph) {
		return at(
			mixedGlyph,
			Number(mixedGlyph[1]) + (FRACTION_GLYPHS[mixedGlyph[2] ?? ""] ?? 0)
		);
	}

	const glyph = GLYPH.exec(trimmed);
	if (glyph) return at(glyph, FRACTION_GLYPHS[glyph[1] ?? ""] ?? 0);

	// "1 1/2" — moet vóór de kale breuk én vóór het kale getal, anders leest
	// de decimale tak alleen de 1 en wordt het recept met een derde
	// onderschat zonder dat er iets misgaat wat je kunt zien.
	const mixed = MIXED_FRACTION.exec(trimmed);
	if (mixed) {
		const denominator = Number(mixed[3]);
		if (denominator !== 0) {
			return at(mixed, Number(mixed[1]) + Number(mixed[2]) / denominator);
		}
	}

	// "1/2", "3 / 4"
	const fraction = FRACTION.exec(trimmed);
	if (fraction) {
		const denominator = Number(fraction[2]);
		if (denominator === 0) return null;
		return at(fraction, Number(fraction[1]) / denominator);
	}

	// "2-3 uien". Op een boodschappenlijst is een bereik de bovengrens: met
	// twee uien in huis sta je in de keuken met een recept dat er drie wil.
	const range = RANGE.exec(trimmed);
	if (range) {
		return at(range, Math.max(decimal(range[1] ?? ""), decimal(range[2] ?? "")));
	}

	const plain = PLAIN.exec(trimmed);
	if (plain) return at(plain, decimal(plain[1] ?? ""));

	return null;
}

/**
 * Knipt de bereidingsnoot van de naam. Geeft de noot terug mét zijn scheiding,
 * zodat de regel er weer precies zo uit te zetten is.
 */
function splitNote(name: string): { name: string; note: string | null } {
	const parenthetical = /\s*\([^)]*\)\s*$/.exec(name);
	if (parenthetical) {
		return {
			name: name.slice(0, parenthetical.index).trimEnd(),
			note: parenthetical[0].trimEnd(),
		};
	}

	const comma = name.lastIndexOf(",");
	if (comma > 0) {
		const tail = name.slice(comma + 1).toLowerCase();
		const words = tail.split(/[\s/]+/).filter(Boolean);
		if (
			words.length > 0 &&
			words.length <= 3 &&
			words.some((word) =>
				PREPARATION_WORDS.includes(word.replace(/[.;:]+$/, ""))
			)
		) {
			return { name: name.slice(0, comma).trimEnd(), note: name.slice(comma) };
		}
	}

	return { name, note: null };
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
		const bare = splitNote(raw);
		return {
			raw,
			amount: null,
			unit: null,
			kind: "vague",
			name: bare.name,
			note: bare.note,
		};
	}

	const rest = raw.slice(amount.length).trimStart();
	const word = /^([a-zA-Z]+\.?)(?=\s|$)/.exec(rest);
	const candidate = word?.[1] ?? null;
	const kind = classify(candidate);

	// Only a recognised measure is eaten; anything else stays in the name so
	// "3 cloves garlic" reads back exactly as it was written.
	const known = candidate !== null && kind !== "piece";
	const { name, note } = splitNote(
		known ? rest.slice((word?.[0] ?? "").length).trimStart() : rest
	);

	return {
		raw,
		amount: amount.value,
		unit: known ? candidate : null,
		kind: known ? kind : "piece",
		name,
		note,
	};
}

/** Units written large, where a step of half a unit would be absurd. */
const LARGE_UNITS = ["kg", "kilo", "kilos", "l", "lt", "liter", "liters", "litre", "litres", "lb", "lbs"];

/**
 * Wat er is mag nooit als nul op het scherm komen. "1 g saffraan" maal 0,2 gaf
 * "0 g saffraan" — een hoeveelheid die de kok stilzwijgend vertelt dat hij het
 * kan weglaten. Onder de afrondstap blijft de hoeveelheid daarom staan, net
 * zoals `roundQuarters` en `roundHalves` allebei al een bewuste vloer hebben.
 */
function neverZero(rounded: number, value: number): number {
	if (rounded > 0 || value <= 0) return rounded;
	return Math.round(value * 100) / 100 || value;
}

function roundMass(value: number, unit: string | null): number {
	if (unit && LARGE_UNITS.includes(unit.toLowerCase().replace(/\.$/, ""))) {
		// 1.3125 kg should read as 1.3 kg, never as 1.5 kg.
		const step = value < 2 ? 0.05 : 0.1;
		return neverZero(Math.round(value / step) * step, value);
	}
	if (value < 10) return neverZero(Math.round(value * 2) / 2, value);
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

/**
 * Alleen voor lepels en stuks — zie `formatAmount`. Een massa in keukenbreuken
 * schrijven is fout: "0,7 kg" als "⅔ kg" is 667 g, bijna vijf procent minder.
 */
const GLYPH_FOR: Record<string, string> = {
	"0.13": "⅛",
	"0.2": "⅕",
	"0.25": "¼",
	"0.33": "⅓",
	"0.38": "⅜",
	"0.5": "½",
	"0.63": "⅝",
	"0.67": "⅔",
	"0.75": "¾",
	"0.8": "⅘",
	"0.88": "⅞",
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

	// De wikilink-syntax gaat er hier af en nergens eerder: in de keuken lees je
	// "500 g rijst", niet "500 g [[Rijst]]".
	if (factor === 1 || parsed.amount === null || parsed.kind === "vague") {
		return { text: withoutLinks(parsed.raw), original: null };
	}

	const scaled = scaleAmount(parsed.amount, parsed.kind, factor, parsed.unit);
	const amount = formatAmount(scaled, parsed.kind);
	const unit = parsed.unit ? `${parsed.unit} ` : "";
	// De bereidingsnoot is van de naam gescheiden om het product te kunnen
	// vinden; bij het herschrijven hoort hij er weer aan.
	const text = `${amount} ${unit}${withoutLinks(parsed.name)}`.trim() + (parsed.note ?? "");

	// Rewriting "1/2" as "½" is not a change worth reporting; only a different
	// quantity is.
	const same = Math.abs(scaled - parsed.amount) < 1e-9;
	return { text, original: same ? null : withoutLinks(parsed.raw) };
}
