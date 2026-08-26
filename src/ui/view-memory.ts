/**
 * Where you were on a screen, kept for as long as Obsidian is open.
 *
 * Pantry's screens share one tab, so tapping through to a product note tears
 * the Stock view down and coming back builds a new one. Without this the list
 * reopened on "All", scrolled to the top — halfway through a counting round
 * that is the worst possible place to be put back.
 *
 * It hangs off the plugin rather than off the leaf's view state on purpose:
 * this is scratch. Losing it when Obsidian restarts is fine, writing it into
 * the workspace file is not.
 */

export type StockFilter = "all" | "check" | "buy";

export interface StockMemory {
	filter: StockFilter;
	query: string;
	/** Storage places the user folded shut. */
	collapsed: Set<string>;
	scroll: number;
}

export interface ShoppingMemory {
	/** "" means every shop. */
	shop: string;
	scroll: number;
}

export class ViewMemory {
	stock: StockMemory = {
		filter: "all",
		query: "",
		collapsed: new Set<string>(),
		scroll: 0,
	};

	shopping: ShoppingMemory = { shop: "", scroll: 0 };
}
