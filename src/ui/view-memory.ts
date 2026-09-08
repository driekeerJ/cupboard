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

export type ListStep = "setup" | "stock" | "shop";

/** Waar je was in één boodschappenlijst: de stap, en per stap de plek. */
export interface ListMemory {
	step: ListStep;
	stock: StockMemory;
	shop: ShoppingMemory;
}

function freshStock(): StockMemory {
	return { filter: "all", query: "", collapsed: new Set<string>(), scroll: 0 };
}

export class ViewMemory {
	/** Het All stock-scherm. */
	stock: StockMemory = freshStock();

	/** Per lijst, op pad. Een lijst die weg is neemt haar geheugen mee. */
	private lists: Map<string, ListMemory> = new Map();

	list(path: string): ListMemory {
		let memory = this.lists.get(path);
		if (!memory) {
			memory = { step: "shop", stock: freshStock(), shop: { shop: "", scroll: 0 } };
			this.lists.set(path, memory);
		}
		return memory;
	}

	/** Een lijst die van naam veranderde neemt haar plek mee. */
	moveList(from: string, to: string): void {
		const memory = this.lists.get(from);
		if (!memory) return;
		this.lists.delete(from);
		this.lists.set(to, memory);
	}

	forgetList(path: string): void {
		this.lists.delete(path);
	}
}
