import type PantryPlugin from "./main";
import { amountsForRecipe, factorFor } from "./needs";
import { linkTarget } from "./plan";
import type { Product, ProductPatch } from "./products";
import type { PlannedRecipe } from "./types";

/**
 * Floating point: 0.1 + 0.2 must not count as more than 0.3.
 *
 * Deze marge moet ruimer zijn dan de precisie waarmee `used` bewaard wordt,
 * anders blijft er per boeking een restje hangen en gaat er nooit een hele
 * verpakking af — zie de opmerking bij `round()` in products.ts.
 */
const EPSILON = 1e-9;

export interface StockChange {
	/** What was really booked, per product path, for a faithful undo. */
	used: Record<string, number>;
	/** Products whose count was unknown, so they were flagged to check instead. */
	unsure: string[];
	/**
	 * Producten waarvan de notitie niet geschreven kon worden — verwijderd,
	 * hernoemd, op slot.
	 *
	 * Verzameld in plaats van de lus te laten klappen. Brak hij halverwege af,
	 * dan stonden de eerste producten wél afgeboekt terwijl het plan nog "niet
	 * gegeten" zei, en boekte de volgende tik ze nog een keer af.
	 */
	failed: string[];
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

	// Dezelfde som als de boodschappenlijst gebruikt, en met opzet letterlijk
	// dezelfde functie: wat je opeet moet zijn wat je gekocht hebt.
	for (const { product, amount } of await amountsForRecipe(
		plugin,
		file,
		factorFor(plugin, file, entry)
	)) {
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
	const change: StockChange = { used: {}, unsure: [], failed: [] };

	for (const [key, amount] of amounts) {
		if (!(amount > 0)) continue;
		// De sleutel is een pad bij het afboeken en een wikilink zodra hij uit
		// een weekplan komt; allebei moeten hier landen.
		const product = plugin.products.byPath(key) ?? plugin.products.match(key);
		if (!product) {
			// Hernoemd of verwijderd sinds de tik. Dat mag niet stil gebeuren:
			// zonder melding gaat de voorraad er nooit meer bij.
			change.unsure.push(linkTarget(key));
			continue;
		}
		const path = product.path;
		// Salt and oil are kept, not measured; there is nothing to book.
		if (!product.amountMatters) continue;

		const moved = move(product, amount * direction);
		if (!moved) {
			// The count is unknown, so no honest number can be produced. Ask
			// rather than invent: the check flag is exactly that question.
			if (!product.check) {
				try {
					await plugin.products.update(product, { check: true });
				} catch (error) {
					console.error(`Pantry: could not flag ${product.name}`, error);
					change.failed.push(product.name);
					continue;
				}
			}
			change.unsure.push(product.name);
			continue;
		}

		try {
			await plugin.products.update(product, moved.patch);
		} catch (error) {
			console.error(`Pantry: could not update ${product.name}`, error);
			change.failed.push(product.name);
			continue;
		}

		// Wat er wérkelijk af ging, niet wat het recept vroeg. Er stond er één
		// en de maaltijd vroeg er twee: dan ging er één af, en hoort undo er
		// ook één terug te zetten. Alleen wat geschreven is telt mee, zodat
		// undo niets terugboekt wat nooit is afgegaan.
		if (direction === 1 && moved.applied > 0) {
			change.used[path] = moved.applied;
		}
	}

	return change;
}

export interface Move {
	patch: ProductPatch;
	/**
	 * Wat er werkelijk van de plank ging — minder dan gevraagd zodra de telling
	 * op nul klemt. Undo boekt dít terug; boekte hij de gevraagde hoeveelheid
	 * terug, dan stonden er na aan- en weer uitvinken meer verpakkingen in de
	 * kast dan ervoor.
	 */
	applied: number;
}

/**
 * The arithmetic for one product. `delta` is positive when eating and negative
 * when giving back. Returns null when the count is not a number, i.e. when the
 * product was never counted or stands at "more than enough".
 *
 * Exported for `tests/unit/move.test.ts`: clamping, negative carry and the
 * epsilon boundary are branches no scenario can steer into on purpose.
 */
export function move(product: Product, delta: number): Move | null {
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
	// Wat er niet stond, kon ook niet op.
	const short = Math.max(0, whole - product.count);

	const patch: ProductPatch = {
		used: Math.max(0, carried),
		// Dit is een afgeleide stand, geen telling: `counted` moet blijven
		// betekenen wanneer de gebruiker zelf voor het laatst gekeken heeft.
		derived: true,
	};
	// Only claim a new count when it really changed, so the "counted on" date
	// keeps meaning "this is when you last looked".
	if (next !== product.count) patch.count = next;
	// Subtracting more than was there means the books were already wrong.
	if (short > 0) patch.check = true;

	return { patch, applied: delta - short };
}
