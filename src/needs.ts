import { TFile } from "obsidian";
import type PantryPlugin from "./main";
import { parseRecipeBody } from "./cook";
import {
	parseIngredient,
	withoutLinks,
	type ParsedIngredient,
} from "./ingredients";
import { linkTarget, servingsFor } from "./plan";
import type { Product } from "./products";
import type { PlannedRecipe, WeekPlan } from "./types";

/** Everything reduced to one base unit per family, so 400 g and 0.4 kg meet. */
const MASS: Record<string, number> = {
	mg: 0.001, g: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kilo: 1000, kilos: 1000,
	oz: 28.3495, lb: 453.592, lbs: 453.592,
};

const VOLUME: Record<string, number> = {
	ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000,
	liter: 1000, liters: 1000, litre: 1000, litres: 1000,
};

/** "Tbsp." en "tbsp" zijn dezelfde maat; alleen de spelling verschilt. */
function unitKey(unit: string): string {
	return unit.trim().toLowerCase().replace(/\.$/, "");
}

function sameUnit(a: string, b: string): boolean {
	return a.length > 0 && b.length > 0 && unitKey(a) === unitKey(b);
}

function family(unit: string): Record<string, number> | null {
	const key = unitKey(unit);
	if (key in MASS) return MASS;
	if (key in VOLUME) return VOLUME;
	return null;
}

/** Converts `amount from` into `to`, or null when the units are unrelated. */
function convert(amount: number, from: string, to: string): number | null {
	const table = family(from);
	if (!table || table !== family(to)) return null;
	const a = table[unitKey(from)];
	const b = table[unitKey(to)];
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

	if (product.size) {
		// "500 g rijst" while he counts packs: needs the package size.
		if (parsed.unit) {
			const converted = convert(amount, parsed.unit, product.size.unit);
			if (converted !== null) return converted / product.size.amount;
		} else if (!family(product.size.unit)) {
			// De verpakking is in stuks opgegeven — `size: 12 stuks`, of kaal
			// `12`. Een regel zonder maat telt in diezelfde stuks, dus zes
			// eieren uit een doos van twaalf is een halve doos. Deze tak stond
			// eerst ná "geen maat" en werd daardoor nooit bereikt: de lijst
			// vroeg om zes dozen en de voorraad werd er zes lichter van.
			return amount / product.size.amount;
		}
	}

	// The recipe already speaks the counting unit, e.g. "2 tins".
	if (parsed.unit && sameUnit(parsed.unit, product.unit)) return amount;

	// "2 uien": no measure and no package to divide by, so the recipe counts
	// in the same pieces the user does.
	if (!parsed.unit) return amount;

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

/** One ingredient line that resolved to a product, with what it asks for. */
export interface RecipeAmount {
	product: Product;
	/** The ingredient line, verbatim minus wikilink syntax. */
	line: string;
	/** In the unit the product is counted in; 0 when it cannot be expressed. */
	amount: number;
}

/**
 * Elke receptregel die een product raakt, omgerekend naar de eenheid waarin
 * dat product geteld wordt.
 *
 * Dit is de enige plek waar die som staat. Hij voedt zowel de boodschappenlijst
 * (`NeedIndex`) als de voorraadaftrek (`consumptionOf`); die twee hadden er
 * ieder een eigen kopie van, en een reparatie aan één kant liet de lijst en de
 * voorraad uit de pas lopen zonder dat iets dat meldde.
 */
export async function amountsForRecipe(
	plugin: PantryPlugin,
	file: TFile,
	factor: number
): Promise<RecipeAmount[]> {
	const content = await plugin.app.vault.cachedRead(file);
	const found: RecipeAmount[] = [];

	for (const line of parseRecipeBody(content).ingredients) {
		const parsed = parseIngredient(line);
		const product = plugin.products.match(parsed.name || parsed.raw);
		if (!product) continue;
		found.push({
			product,
			line: withoutLinks(line),
			amount: inProductUnits(parsed, product, factor),
		});
	}

	return found;
}

/**
 * Hoe sterk dit recept geschaald moet worden: gekookt voor zoveel personen,
 * gedeeld door waar het recept zelf voor geschreven is. Zegt het recept niets,
 * dan is er niets te schalen.
 */
export function factorFor(
	plugin: PantryPlugin,
	file: TFile,
	entry: PlannedRecipe
): number {
	const base = plugin.cook.baseServings(file);
	if (!base || base <= 0) return 1;
	return servingsFor(plugin, entry) / base;
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
					await this.addRecipe(raw, file, factorFor(this.plugin, file, entry));
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

	private async addRecipe(
		into: Map<string, number>,
		file: TFile,
		factor: number
	): Promise<void> {
		for (const { product, line, amount } of await amountsForRecipe(
			this.plugin,
			file,
			factor
		)) {
			// Recorded before the zero check: a line that contributes nothing
			// still tells the shopper what the recipe actually asks for.
			const seen = this.origins.get(product.path) ?? [];
			seen.push({ recipe: file.basename, line, amount });
			this.origins.set(product.path, seen);

			if (amount <= 0) continue;
			into.set(product.path, (into.get(product.path) ?? 0) + amount);
		}
	}
}
