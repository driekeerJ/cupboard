import { TFile } from "obsidian";
import type PantryPlugin from "./main";
import { parseRecipeBody } from "./cook";
import { parseIngredient, type ParsedIngredient } from "./ingredients";
import { linkTarget, servingsFor } from "./plan";
import type { Product } from "./products";
import type { WeekPlan } from "./types";

/** Everything reduced to one base unit per family, so 400 g and 0.4 kg meet. */
const MASS: Record<string, number> = {
	mg: 0.001, g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kilo: 1000, kilos: 1000,
	oz: 28.3495, lb: 453.592, lbs: 453.592,
};

const VOLUME: Record<string, number> = {
	ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000,
	liter: 1000, liters: 1000, litre: 1000, litres: 1000,
};

function family(unit: string): Record<string, number> | null {
	const key = unit.toLowerCase().replace(/\.$/, "");
	if (key in MASS) return MASS;
	if (key in VOLUME) return VOLUME;
	return null;
}

/** Converts `amount from` into `to`, or null when the units are unrelated. */
function convert(amount: number, from: string, to: string): number | null {
	const table = family(from);
	if (!table || table !== family(to)) return null;
	const a = table[from.toLowerCase().replace(/\.$/, "")];
	const b = table[to.toLowerCase().replace(/\.$/, "")];
	if (!a || !b) return null;
	return (amount * a) / b;
}

/**
 * One recipe line expressed in the unit the user counts that product in.
 *
 * Deliberately returns 0 rather than a guess when it cannot tell: a splash of
 * oil is a presence question, not an amount question, and inventing a number
 * there would poison every figure downstream.
 */
export function inProductUnits(
	parsed: ParsedIngredient,
	product: Product,
	factor: number
): number {
	// Salt and oil are kept, not measured: the user said the amount does not
	// matter, so there is nothing to add here.
	if (!product.amountMatters) return 0;
	if (parsed.amount === null || parsed.kind === "vague") return 0;
	const amount = parsed.amount * factor;

	// "2 uien": no measure at all, so the recipe counts in the same pieces.
	if (!parsed.unit) return amount;

	// "500 g rijst" while he counts packs: needs the package size.
	if (product.size) {
		const converted = convert(amount, parsed.unit, product.size.unit);
		if (converted !== null) return converted / product.size.amount;
		// The recipe already speaks the package unit, e.g. "2 tins".
		if (parsed.unit.toLowerCase() === product.unit.toLowerCase()) return amount;
	}

	if (parsed.unit.toLowerCase() === product.unit.toLowerCase()) return amount;

	// Spoons of something counted in jars, and anything else we cannot express.
	return 0;
}

/**
 * One planned recipe line that asked for this product, kept so the shopper can
 * see where a figure came from. "4 spring onions" is unreadable on its own —
 * four bunches or four stalks? — and the recipe line is the only place that
 * ever said. The line is stored as the recipe wrote it, brackets stripped.
 */
export interface NeedSource {
	/** The recipe note's name. */
	recipe: string;
	/** The ingredient line, verbatim minus wikilink syntax. */
	line: string;
	/** What this line added, in the unit the product is counted in. 0 when
	 *  the amount could not be expressed there — a vague measure, a spoon of
	 *  something counted in jars. Those lines are kept and marked, never hidden:
	 *  an ingredient that counts for nothing is exactly the confusing one. */
	amount: number;
}

/** Strips `[[Link]]` and `[[Link|shown]]` down to what a reader would say. */
function plainText(line: string): string {
	return line.replace(/\[\[([^\]]+)\]\]/g, (_all, inner: string) => {
		const parts = inner.split("|");
		return (parts[1] ?? parts[0]).trim();
	});
}

/**
 * How much each product is needed for on top of its minimum, summed over every
 * recipe planned this week. Keyed by product path, always a whole number of the
 * unit he counts in — rounded up, because half a tin cannot be bought.
 */
export class NeedIndex {
	private plugin: PantryPlugin;
	private amounts: Map<string, number> = new Map();
	private origins: Map<string, NeedSource[]> = new Map();

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	get(product: Product): number {
		return this.amounts.get(product.path) ?? 0;
	}

	/** Every planned recipe line that asked for this product, in plan order. */
	sources(product: Product): NeedSource[] {
		return this.origins.get(product.path) ?? [];
	}

	total(): number {
		return this.amounts.size;
	}

	async rebuild(weekStart: Date): Promise<void> {
		const plan = await this.plugin.plans.load(weekStart);
		this.origins = new Map();
		this.amounts = await this.collect(plan);
	}

	private async collect(plan: WeekPlan): Promise<Map<string, number>> {
		const raw = new Map<string, number>();

		for (const day of plan.days) {
			for (const meal of day.meals) {
				for (const entry of meal.recipes) {
					// Ticked off, either way: an eaten meal already took its
					// ingredients out of the house and a skipped one never will.
					if (entry.status) continue;
					// The plan stores the link as written, brackets and all.
					const file = this.plugin.cook.file(linkTarget(entry.recipe));
					if (!file) continue;
					const factor = this.factor(file, servingsFor(this.plugin, entry));
					await this.addRecipe(raw, file, factor);
				}
			}
		}

		const rounded = new Map<string, number>();
		raw.forEach((amount, path) => {
			const whole = Math.ceil(amount - 1e-9);
			if (whole > 0) rounded.set(path, whole);
		});
		return rounded;
	}

	/** A recipe written for four, cooked for five, scales by 1.25. */
	private factor(file: TFile, servings: number): number {
		const base = this.plugin.cook.baseServings(file);
		if (!base || base <= 0) return 1;
		return servings / base;
	}

	private async addRecipe(
		into: Map<string, number>,
		file: TFile,
		factor: number
	): Promise<void> {
		const content = await this.plugin.app.vault.cachedRead(file);
		const lines = parseRecipeBody(content).ingredients;

		for (const line of lines) {
			const parsed = parseIngredient(line);
			const product = this.plugin.products.match(parsed.name || parsed.raw);
			if (!product) continue;
			const amount = inProductUnits(parsed, product, factor);

			// Recorded before the zero check: a line that contributes nothing
			// still tells the shopper what the recipe actually asks for.
			const seen = this.origins.get(product.path) ?? [];
			seen.push({ recipe: file.basename, line: plainText(line), amount });
			this.origins.set(product.path, seen);

			if (amount <= 0) continue;
			into.set(product.path, (into.get(product.path) ?? 0) + amount);
		}
	}
}
