import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { UNASSIGNED, missingFields, type Product } from "../products";
import { matchesQuery } from "../search";
import { emptyState, keepScroll, segment as drawSegment } from "./kit";
import { drawBackLink } from "./nav";
import { NewProductModal } from "./new-product-modal";
import { ProductSheet } from "./product-sheet";

export const PRODUCTS_VIEW_TYPE = "pantry-products";

type Filter = "all" | "missing";

/**
 * The base list: what you always want in stock. Everything here changes rarely,
 * which is why it lives apart from the weekly counting screen.
 *
 * Two things happen here. You look a product up, and you finish the ones that
 * were never finished — a product that does not say its unit, package size,
 * shop, shelf or place in the house is invisible to the planner and the list,
 * so the screen leads with how many of those there are and hands you a run
 * through them rather than making you hunt.
 */
export class ProductsView extends ItemView {
	private plugin: PantryPlugin;
	private query = "";
	private filter: Filter = "all";
	private shop = "";
	private collapsed: Set<string> = new Set();
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private segmentEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PRODUCTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Products";
	}

	getIcon(): string {
		return "package";
	}

	onOpen(): Promise<void> {
		this.draw();
		// Obsidian verwacht een promise; hier valt niets te wachten.
		return Promise.resolve();
	}

	refresh(): void {
		this.drawList();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-products");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Products" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		const actions = top.createDiv({ cls: "pantry-head-actions" });
		const fromRecipes = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "From recipes",
		});
		fromRecipes.onclick = () =>
			guarded("could not add products from your recipes", () =>
				this.plugin.productsFromRecipes()
			);

		const add = actions.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: "New product",
		});
		add.onclick = () => this.createProduct();

		const search = inner.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search products", enterkeyhint: "search" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.drawList();
		});

		const filters = inner.createDiv({ cls: "pantry-products-filters" });
		this.segmentEl = filters.createDiv({ cls: "pantry-segment" });

		const shops = this.plugin.products.values("shop");
		const shopSelect = filters.createEl("select", {
			cls: "dropdown pantry-products-shop",
			attr: { "aria-label": "Filter by shop" },
		});
		const any = shopSelect.createEl("option", { text: "All shops" });
		any.value = "";
		shops.forEach((shop) => {
			const option = shopSelect.createEl("option", { text: shop });
			option.value = shop;
			if (shop === this.shop) option.selected = true;
		});
		shopSelect.addEventListener("change", () => {
			this.shop = shopSelect.value;
			this.drawList();
		});

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawList();
	}

	/** Everything the search and shop filter let through, complete or not. */
	private matching(): Product[] {
		const query = this.query.trim().toLowerCase();
		return this.plugin.products.all().filter((product) => {
			if (
				this.shop &&
				!product.shops.some(
					(shop) => shop.toLowerCase() === this.shop.toLowerCase()
				)
			) {
				return false;
			}
			return matchesQuery(query, [product.name, ...product.aliases]);
		});
	}

	private drawSegment(incomplete: number, total: number): void {
		const segment = this.segmentEl;
		if (!segment) return;
		segment.empty();

		drawSegment<Filter>(
			segment,
			[
				{ value: "all", label: `All ${total}` },
				{
					value: "missing",
					label: incomplete > 0 ? `Missing info ${incomplete}` : "Missing info",
					alarm: incomplete > 0,
				},
			],
			this.filter,
			(value) => {
				this.filter = value;
				this.drawList();
			}
		);
	}

	private drawList(): void {
		const body = this.bodyEl;
		if (!body) return;
		const restore = keepScroll(body);
		body.empty();

		const all = this.plugin.products.all();
		const matching = this.matching();
		const incomplete = matching.filter((product) => missingFields(product).length > 0);
		const shown = this.filter === "missing" ? incomplete : matching;

		this.drawSegment(incomplete.length, matching.length);
		this.countEl?.setText(
			matching.length === all.length
				? `${all.length} products`
				: `${matching.length} of ${all.length} products`
		);

		if (all.length === 0) {
			this.empty(
				body,
				"No products yet",
				`Use "From recipes" to create them from what your recipes already mention, or add one by hand.`
			);
			return;
		}

		if (shown.length === 0) {
			this.empty(
				body,
				this.filter === "missing" ? "Nothing missing" : "No matches",
				this.filter === "missing"
					? "Every product here says its unit, size, shop, shelf and place in the house."
					: "Try a different search."
			);
			restore();
			return;
		}

		if (this.filter === "missing" && shown.length > 1) {
			const run = body.createEl("button", {
				cls: "pantry-run-button",
				text: `Fill in all ${shown.length}`,
			});
			run.onclick = () => this.openSheet(shown, 0);
		}

		// Grouped by where it lives in the house: that is the order you walk in
		// when you go round counting.
		const groups = new Map<string, Product[]>();
		shown.forEach((product) => {
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
				this.drawGroup(body, storage, items, shown);
			});

		restore();
	}

	private empty(parent: HTMLElement, title: string, hint: string): void {
		emptyState(parent, title, hint);
	}

	private drawGroup(
		parent: HTMLElement,
		storage: string,
		items: Product[],
		run: Product[]
	): void {
		const group = parent.createDiv({ cls: "pantry-section" });
		const folded = this.collapsed.has(storage);

		const heading = group.createEl("button", { cls: "pantry-section-head" });
		const caret = heading.createSpan({ cls: "pantry-section-caret" });
		setIcon(caret, folded ? "chevron-right" : "chevron-down");
		heading.createSpan({ cls: "pantry-section-name", text: storage });
		heading.createSpan({ cls: "pantry-section-count", text: `${items.length}` });
		heading.onclick = () => {
			if (folded) this.collapsed.delete(storage);
			else this.collapsed.add(storage);
			this.drawList();
		};

		if (folded) return;

		const list = group.createDiv({ cls: "pantry-section-body" });
		items.forEach((product) => this.drawRow(list, product, run));
	}

	private drawRow(parent: HTMLElement, product: Product, run: Product[]): void {
		const gaps = missingFields(product);

		const row = parent.createEl("button", { cls: "pantry-product-row" });
		row.toggleClass("is-incomplete", gaps.length > 0);
		row.setAttr("aria-label", `Edit ${product.name}`);

		const main = row.createDiv({ cls: "pantry-product-main" });
		main.createDiv({ cls: "pantry-product-name", text: product.name });

		// What it says, or — louder — what it does not. A row never shows both:
		// the gap is the only thing you can act on from here.
		if (gaps.length > 0) {
			main.createDiv({
				cls: "pantry-product-gaps",
				text: gaps.join(" · "),
			});
		} else {
			const facts: string[] = [];
			facts.push(`min ${product.minimum}${product.unit ? ` ${product.unit}` : ""}`);
			if (product.size) facts.push(`${product.size.amount} ${product.size.unit}`.trim());
			if (product.shops.length > 0) facts.push(product.shops.join(" / "));
			if (product.shelf) facts.push(product.shelf);
			main.createDiv({ cls: "pantry-product-facts", text: facts.join(" · ") });
		}

		const chevron = row.createSpan({ cls: "pantry-product-chevron" });
		setIcon(chevron, "chevron-right");

		row.onclick = () => {
			const index = run.findIndex((item) => item.path === product.path);
			this.openSheet(run, Math.max(0, index));
		};
	}

	private openSheet(queue: Product[], index: number): void {
		const product = queue[index];
		if (!product) return;
		new ProductSheet(
			this.plugin,
			product,
			"missing",
			() => this.drawList(),
			{ queue, index, allowDelete: true }
		).open();
	}

	/**
	 * Eerst maakte deze knop een notitie "New product" aan en zei erbij dat je
	 * hem moest hernoemen. De naam \u2014 het enige dat alleen jij kunt aanleveren
	 * \u2014 was daarmee het enige dat het formulier niet vroeg. Nu vraagt het
	 * formulier alles in \u00e9\u00e9n keer, en wordt er pas geschreven als je op Add
	 * drukt.
	 */
	private createProduct(): void {
		new NewProductModal(this.plugin, () => this.drawList()).open();
	}
}
