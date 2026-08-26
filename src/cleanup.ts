import type PantryPlugin from "./main";
import { parseRecipeBody } from "./cook";
import { parseIngredient } from "./ingredients";
import { inProductUnits } from "./needs";
import { normalise, type Product } from "./products";

/**
 * What stands between the recipes and a correct grocery list.
 *
 * A recipe line only produces a number when three things line up: it points at
 * a product, that product says how it is bought, and the two units can be
 * converted into each other. This module finds every line where that fails, and
 * groups the failures the way they are answered — per product, once, rather
 * than per line, over and over.
 */

/** Why a line does or does not add to what has to be bought. */
export type LineStatus =
	/** It converts into the unit the product is counted in. */
	| "counts"
	/** A handful, a pinch: a presence question, never an amount. */
	| "vague"
	/** It should count, but the units cannot be bridged yet. */
	| "zero";

export interface RecipeLine {
	recipe: string;
	path: string;
	/** The line as written in the recipe. */
	text: string;
	/** The name left after the amount and unit were read off. */
	name: string;
	/** The measure the recipe uses, e.g. "g". Empty means whole items. */
	unit: string;
	status: LineStatus;
}

export interface ProductIssue {
	product: Product;
	/** Every line across all recipes that points at this product. */
	lines: RecipeLine[];
	/** The ones that produce nothing today. */
	zero: RecipeLine[];
	/** Whether the product has been told how it is bought. */
	answered: boolean;
}

export interface UnknownIngredient {
	/** The name as the recipe writes it. */
	name: string;
	key: string;
	lines: RecipeLine[];
}

/** Has this product been told how it is bought? */
export function isAnswered(product: Product): boolean {
	return !product.amountMatters || product.unit.length > 0 || product.size !== null;
}

/** The measure most of the unresolved lines use, as a starting point. */
export function commonUnit(lines: RecipeLine[]): string {
	const tally = new Map<string, number>();
	lines.forEach((line) => {
		if (!line.unit) return;
		tally.set(line.unit, (tally.get(line.unit) ?? 0) + 1);
	});
	let best = "";
	let most = 0;
	tally.forEach((count, unit) => {
		if (count > most) {
			most = count;
			best = unit;
		}
	});
	return best;
}

export class CleanupIndex {
	private plugin: PantryPlugin;
	private issues: ProductIssue[] = [];
	private unknown: UnknownIngredient[] = [];

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	/** Products with at least one line that produces nothing. */
	open(): ProductIssue[] {
		return this.issues.filter((issue) => issue.zero.length > 0 && !issue.answered);
	}

	/** Answered, and still not converting — visible, but not in the way. */
	stubborn(): ProductIssue[] {
		return this.issues.filter((issue) => issue.zero.length > 0 && issue.answered);
	}

	missing(): UnknownIngredient[] {
		return this.unknown;
	}

	all(): ProductIssue[] {
		return this.issues;
	}

	/** Reads every recipe once and sorts the lines into the buckets above. */
	async rebuild(): Promise<void> {
		const byProduct = new Map<string, ProductIssue>();
		const byName = new Map<string, UnknownIngredient>();

		for (const recipe of this.plugin.recipes.all()) {
			const file = this.plugin.app.vault.getFileByPath(recipe.path);
			if (!file) continue;
			const content = await this.plugin.app.vault.cachedRead(file);

			for (const raw of parseRecipeBody(content).ingredients) {
				const parsed = parseIngredient(raw);
				const name = (parsed.name || parsed.raw).trim();
				if (name.length === 0) continue;

				const product = this.plugin.products.match(name);
				const line: RecipeLine = {
					recipe: recipe.name,
					path: recipe.path,
					text: raw,
					name,
					unit: parsed.unit ?? "",
					status: "zero",
				};

				if (!product) {
					const key = normalise(name);
					if (key.length === 0) continue;
					const entry = byName.get(key) ?? { name, key, lines: [] };
					entry.lines.push(line);
					byName.set(key, entry);
					continue;
				}

				if (parsed.amount === null || parsed.kind === "vague") {
					line.status = "vague";
				} else if (inProductUnits(parsed, product, 1) > 0) {
					line.status = "counts";
				}

				const issue = byProduct.get(product.path) ?? {
					product,
					lines: [],
					zero: [],
					answered: isAnswered(product),
				};
				issue.lines.push(line);
				if (line.status === "zero") issue.zero.push(line);
				byProduct.set(product.path, issue);
			}
		}

		// Most unresolved lines first: that is where the list is most wrong.
		this.issues = [...byProduct.values()].sort(
			(a, b) =>
				b.zero.length - a.zero.length ||
				a.product.name.localeCompare(b.product.name)
		);
		this.unknown = [...byName.values()].sort((a, b) =>
			a.name.localeCompare(b.name)
		);
	}
}
