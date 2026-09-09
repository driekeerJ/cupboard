import { setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { UNASSIGNED, type Product, type ProductPatch } from "../products";
import { matchesQuery } from "../search";
import { emptyState, keepScroll, segment } from "./kit";
import { drawStockRow, stockStatus } from "./stock-rows";
import type { StockFilter as Filter, StockMemory } from "./view-memory";

/**
 * Waar een telscherm zijn getallen vandaan haalt.
 *
 * Het All stock-scherm rekent met het hele plan en elk minimum; de
 * voorraadcheck van een boodschappenlijst alleen met háár maaltijden en háár
 * winkels. De rijen, de filters, het zoekveld en het groeperen op plek in
 * huis zijn hetzelfde — dat is wat dit paneel is.
 */
export interface StockSource {
	plugin: PantryPlugin;
	memory: StockMemory;
	/** De producten die hier überhaupt in beeld mogen komen. */
	candidates(): Product[];
	/** Het minimum plus wat de maaltijden vragen: tot hier loopt de strip. */
	need(product: Product): number;
	/** Hoeveel je koopt — dezelfde som als de lijst. */
	buy(product: Product): number | null;
	/** Iets anders dan "buy 2" rechts van de naam, als er iets bijzonders is. */
	note?(product: Product): string | null;
	/**
	 * Producten die hier alleen geteld worden en niet gekocht: ze krijgen een
	 * eigen blok onderaan en tellen niet mee als "te kopen". Zo staat wat bij
	 * een andere winkel ligt wél op de telronde — je loopt toch langs die kast
	 * — zonder tussen je boodschappen te gaan staan.
	 */
	aside?: { title: string; holds(product: Product): boolean };
	/** Doorrekenen vóór het hertekenen. */
	reload(): Promise<void>;
}

export class StockPanel {
	private source: StockSource;
	private filtersEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private hideEl: HTMLButtonElement | null = null;

	// Rows that no longer belong in this list but are being held in place, by
	// product path. Nothing takes them away on its own: counting is a rhythm —
	// 1, 2, 3 — and often a correction right after, and a list that reflows
	// under your thumb makes you tap the wrong row. They go when you press
	// "Hide checked", and not a moment earlier.
	private leaving = new Set<string>();

	constructor(source: StockSource) {
		this.source = source;
	}

	private get memory(): StockMemory {
		return this.source.memory;
	}

	/**
	 * Tekent de bediening in `head` en de lijst in `body`. `countEl` is de
	 * regel onder de titel; die is van het scherm, want de titel ook.
	 */
	mount(head: HTMLElement, actions: HTMLElement, body: HTMLElement, countEl: HTMLElement): void {
		this.bodyEl = body;
		this.countEl = countEl;

		this.hideEl = actions.createEl("button", { cls: "pantry-text-button" });
		this.hideEl.onclick = () => {
			this.forget();
			this.drawList();
		};

		const search = head.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search products", enterkeyhint: "search" },
		});
		search.value = this.memory.query;
		search.addEventListener("input", () => {
			this.memory.query = search.value;
			this.drawList();
		});

		this.filtersEl = segment<Filter>(
			head,
			[
				{ value: "all", label: "All" },
				{ value: "check", label: "To check" },
				{ value: "buy", label: "To buy" },
			],
			this.memory.filter,
			(value) => {
				// A different filter is a different list, so it starts at the top
				// and holds nothing over from the previous one.
				this.forget();
				this.memory.filter = value;
				this.memory.scroll = 0;
				this.redrawControls();
				guarded("could not refresh your stock", async () => {
					await this.source.reload();
					this.drawList();
					const scroller = body.closest(".view-content");
					if (scroller) scroller.scrollTop = 0;
				});
			}
		);

		this.drawList();
	}

	/** De filterknoppen opnieuw, zonder het hele scherm om te gooien. */
	private redrawControls(): void {
		const filters = this.filtersEl;
		if (!filters) return;
		const chips = filters.querySelectorAll(".pantry-segment-item");
		const order: Filter[] = ["all", "check", "buy"];
		chips.forEach((chip, at) =>
			chip.toggleClass("is-active", order[at] === this.memory.filter)
		);
	}

	/**
	 * Nothing is wanted of it and the meals do not ask for it either, so
	 * there is nothing to count. A product flagged by hand still shows: the
	 * flag is a deliberate "look at this one" and outranks the rule.
	 */
	private irrelevant(product: Product): boolean {
		return !product.check && this.source.need(product) === 0;
	}

	private aside(product: Product): boolean {
		return this.source.aside?.holds(product) ?? false;
	}

	private belongs(product: Product): boolean {
		if (this.irrelevant(product)) return false;
		// Niet te koop waar je heen gaat: dan hoort hij niet thuis onder een
		// filter dat over de boodschappen zelf gaat.
		if (this.aside(product)) return this.memory.filter === "all";
		if (this.memory.filter === "check") return product.check;
		if (this.memory.filter === "buy") {
			const buy = this.source.buy(product);
			return buy === null || buy > 0;
		}
		return true;
	}

	private visible(): Product[] {
		const query = this.memory.query.trim().toLowerCase();
		return this.source.candidates().filter((product) => {
			if (query.length > 0) {
				// Wie een naam intypt zoekt dát product, niet een selectie.
				return matchesQuery(query, [product.name, ...product.aliases]);
			}
			return this.belongs(product) || this.leaving.has(product.path);
		});
	}

	/**
	 * Writes a change made from a row, and keeps that row on screen when the
	 * change is what removed it from the list, so correcting a count is never a
	 * race against the list itself.
	 */
	private change(product: Product, patch: ProductPatch): void {
		// De redraw hoort binnen de guard: mislukt de schrijfactie, dan mag het
		// scherm geen getal tonen dat niet op schijf staat.
		guarded(`could not update ${product.name}`, async () => {
			await this.source.plugin.products.update(product, patch);
			this.hold(product);
			this.drawList();
		});
	}

	private hold(product: Product): void {
		if (this.belongs(product)) this.leaving.delete(product.path);
		else this.leaving.add(product.path);
	}

	forget(): void {
		this.leaving.clear();
	}

	private drawHideButton(): void {
		const button = this.hideEl;
		if (!button) return;
		const held = this.leaving.size;
		button.toggleClass("is-hidden", held === 0);
		button.setText(`Hide checked (${held})`);
		button.setAttr("aria-label", `Hide ${held} finished rows`);
	}

	drawList(): void {
		const body = this.bodyEl;
		if (!body) return;

		const restore = keepScroll(body);
		body.empty();
		this.drawHideButton();

		const all = this.source.candidates();
		if (all.length === 0) {
			emptyState(body, "Nothing to count", "Nothing on this list asks for a count.");
			this.countEl?.setText("");
			return;
		}

		let buying = 0;
		let checking = 0;
		all.forEach((product) => {
			if (this.aside(product)) return;
			if (product.check) checking++;
			const buy = this.source.buy(product);
			if (buy !== null && buy > 0) buying++;
		});
		const parts = [`${buying} to buy`];
		if (checking > 0) parts.push(`${checking} to check`);
		this.countEl?.setText(parts.join("  ·  "));

		const shown = this.visible();
		if (shown.length === 0) {
			const filter = this.memory.filter;
			emptyState(
				body,
				filter === "check" ? "Nothing to check" : filter === "buy" ? "Nothing to buy" : "No matches",
				filter === "all" ? "Try a different search." : "Everything here is settled."
			);
			return;
		}

		const groups = new Map<string, Product[]>();
		const aside: Product[] = [];
		shown.forEach((product) => {
			if (this.aside(product)) {
				aside.push(product);
				return;
			}
			const key = product.storage || UNASSIGNED;
			const bucket = groups.get(key) ?? [];
			bucket.push(product);
			groups.set(key, bucket);
		});

		[...groups.keys()]
			.sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)))
			.forEach((storage) => {
				const items = (groups.get(storage) ?? []).sort((a, b) =>
					a.name.localeCompare(b.name)
				);
				this.drawGroup(body, storage, items);
			});

		// Onderaan, na alles wat je hier wél haalt.
		const title = this.source.aside?.title;
		if (title && aside.length > 0) {
			this.drawGroup(
				body,
				title,
				aside.sort((a, b) => a.name.localeCompare(b.name))
			);
		}

		restore();
	}

	private drawGroup(parent: HTMLElement, storage: string, items: Product[]): void {
		const group = parent.createDiv({ cls: "pantry-section" });
		const folded = this.memory.collapsed.has(storage);

		const heading = group.createEl("button", { cls: "pantry-section-head" });
		const caret = heading.createSpan({ cls: "pantry-section-caret" });
		setIcon(caret, folded ? "chevron-right" : "chevron-down");
		heading.createSpan({ cls: "pantry-section-name", text: storage });
		heading.createSpan({ cls: "pantry-section-count", text: `${items.length}` });
		heading.onclick = () => {
			if (folded) this.memory.collapsed.delete(storage);
			else this.memory.collapsed.add(storage);
			this.drawList();
		};

		if (folded) return;

		const list = group.createDiv({ cls: "pantry-section-body" });
		items.forEach((product) =>
			drawStockRow(list, product, {
				plugin: this.source.plugin,
				need: (item) => this.source.need(item),
				status: (item) => {
					const note = this.source.note?.(item);
					if (note) return { text: note, kind: "quiet" };
					return stockStatus(this.source.need(item), this.source.buy(item));
				},
				change: (item, patch) => this.change(item, patch),
				leaving: (item) => this.leaving.has(item.path),
				redraw: () => this.drawList(),
			})
		);
	}
}
