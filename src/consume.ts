import type PantryPlugin from "./main";
import { parseRecipeBody } from "./cook";
import { parseIngredient } from "./ingredients";
import { inProductUnits } from "./needs";
import { linkTarget, servingsFor } from "./plan";
import type { Product, ProductPatch } from "./products";
import type { PlannedRecipe } from "./types";

/** Floating point: 0.1 + 0.2 must not count as more than 0.3. */
const EPSILON = 1e-9;

export interface StockChange {
	/** What was really booked, per product path, for a faithful undo. */
	used: Record<string, number>;
	/** Products whose count was unknown, so they were flagged to check instead. */
	unsure: string[];
}

/**
 * What one planned meal takes out of the house, per product path, in the unit
 * that product is counted in — unrounded, because a meal really does eat a
 * third of a bag of rice.
 *
 * Anything the plugin cannot express in that unit contributes nothing rather
 * than a guess: that is the same rule the grocery list already follows.
 */
export async function consumptionOf(
	plugin: PantryPlugin,
	entry: PlannedRecipe
): Promise<Map<string, number>> {
	const amounts = new Map<string, number>();

	// The plan stores the link as written, brackets and all.
	const file = plugin.cook.file(linkTarget(entry.recipe));
	if (!file) return amounts;

	const base = plugin.cook.baseServings(file);
	const factor = !base || base <= 0 ? 1 : servingsFor(plugin, entry) / base;

	const content = await plugin.app.vault.cachedRead(file);
	for (const line of parseRecipeBody(content).ingredients) {
		const parsed = parseIngredient(line);
		const product = plugin.products.match(parsed.name || parsed.raw);
		if (!product) continue;
		const amount = inProductUnits(parsed, product, factor);
		if (amount <= 0) continue;
		amounts.set(product.path, (amounts.get(product.path) ?? 0) + amount);
	}

	return amounts;
}

/** Takes a meal's ingredients off the stock counts. */
export async function takeFromStock(
	plugin: PantryPlugin,
	amounts: Map<string, number>
): Promise<StockChange> {
	return apply(plugin, amounts, 1);
}

/** Puts back exactly what a tick took off, when that tick is undone. */
export async function returnToStock(
	plugin: PantryPlugin,
	used: Record<string, number>
): Promise<StockChange> {
	return apply(plugin, new Map(Object.entries(used)), -1);
}

async function apply(
	plugin: PantryPlugin,
	amounts: Map<string, number>,
	direction: 1 | -1
): Promise<StockChange> {
	const change: StockChange = { used: {}, unsure: [] };

	for (const [path, amount] of amounts) {
		if (!(amount > 0)) continue;
		const product = plugin.products.byPath(path);
		if (!product) continue;
		// Salt and oil are kept, not measured; there is nothing to book.
		if (!product.amountMatters) continue;

		const patch = move(product, amount * direction);
		if (!patch) {
			// The count is unknown, so no honest number can be produced. Ask
			// rather than invent: the check flag is exactly that question.
			if (!product.check) await plugin.products.update(product, { check: true });
			change.unsure.push(product.name);
			continue;
		}

		await plugin.products.update(product, patch);
		if (direction === 1) change.used[path] = amount;
	}

	return change;
}

/**
 * The arithmetic for one product. `delta` is positive when eating and negative
 * when giving back. Returns null when the count is not a number, i.e. when the
 * product was never counted or stands at "more than enough".
 *
 * Exported for `tests/unit/move.test.ts`: clamping, negative carry and the
 * epsilon boundary are branches no scenario can steer into on purpose.
 */
export function move(product: Product, delta: number): ProductPatch | null {
	if (typeof product.count !== "number") return null;

	let carried = product.used + delta;
	let whole = 0;

	if (carried >= 1 - EPSILON) {
		// Enough leftovers piled up to take a whole unit off the shelf.
		whole = Math.floor(carried + EPSILON);
		carried -= whole;
	} else if (carried < -EPSILON) {
		// Giving back more than was carried: whole units go back on the shelf.
		const back = Math.ceil(-carried - EPSILON);
		whole = -back;
		carried += back;
	}

	const next = Math.max(0, product.count - whole);
	const patch: ProductPatch = { used: Math.max(0, carried) };
	// Only claim a new count when it really changed, so the "counted on" date
	// keeps meaning "this is when you last looked".
	if (next !== product.count) patch.count = next;
	// Subtracting more than was there means the books were already wrong.
	if (product.count - whole < 0) patch.check = true;
	return patch;
}
