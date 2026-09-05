import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { UNASSIGNED, type Count, type Product, type ProductPatch } from "../products";
import { matchesQuery } from "../search";
import { emptyState, keepScroll, segment } from "./kit";
import { drawBackLink } from "./nav";
import { ProductSheet } from "./product-sheet";
import { drawRoundBanner } from "./round-banner";
import type { StockFilter as Filter } from "./view-memory";

export const STOCK_VIEW_TYPE = "pantry-stock";

/** Above this many, a segmented control stops being a control and becomes a wall. */
const STRIP_LIMIT = 8;


/**
 * The counting screen. One row per product, and the only thing the user does is
 * tap how many are there: a segmented control running from "more than enough"
 * down to zero. No keyboard, no number field, one gesture.
 */
export class StockView extends ItemView {
	private plugin: PantryPlugin;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	// Rows that no longer belong in this list but are being held in place, by
	// product path. Nothing takes them away on its own: counting is a rhythm —
	// 1, 2, 3 — and often a correction right after, and a list that reflows
	// under your thumb makes you tap the wrong row. They go when you press
	// "Hide checked", and not a moment earlier.
	private leaving = new Set<string>();

	// The "Hide checked (n)" button, kept so the list can update its count.
	private hideEl: HTMLButtonElement | null = null;

	// Filter, search and folded sections live on the plugin instead of here.
	// Tapping a product name can take you out to its note, which destroys this
	// view; coming back to "All" at the top would lose your place in the round.
	private get query(): string {
		return this.plugin.ui.stock.query;
	}

	private set query(value: string) {
		this.plugin.ui.stock.query = value;
	}

	private get filter(): Filter {
		return this.plugin.ui.stock.filter;
	}

	private set filter(value: Filter) {
		this.plugin.ui.stock.filter = value;
	}

	private get collapsed(): Set<string> {
		return this.plugin.ui.stock.collapsed;
	}

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return STOCK_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Stock";
	}

	getIcon(): string {
		return "layout-list";
	}

	onOpen(): Promise<void> {
		this.draw();
		guarded("could not load your stock", async () => {
			await this.reload();
			this.restoreScroll();
		});
		// Obsidian verwacht een promise; hier valt niets te wachten.
		return Promise.resolve();
	}

	/**
	 * Puts the list back where it was, then starts recording again. Two frames:
	 * one so the rows are laid out and the scroller actually has the height to
	 * scroll to, one more before the listener starts, so a clamped intermediate
	 * value is never written back over the position we are restoring.
	 */
	private restoreScroll(): void {
		const wanted = this.plugin.ui.stock.scroll;
		window.requestAnimationFrame(() => {
			if (wanted > 0) this.contentEl.scrollTop = wanted;
			window.requestAnimationFrame(() => {
				this.registerDomEvent(this.contentEl, "scroll", () => {
					this.plugin.ui.stock.scroll = this.contentEl.scrollTop;
				});
			});
		});
	}

	onClose(): Promise<void> {
		this.forget();
		// Obsidian verwacht een promise; hier valt niets te wachten.
		return Promise.resolve();
	}

	refresh(): void {
		guarded("could not refresh your stock", () => this.reload());
	}

	private async reload(): Promise<void> {
		await this.plugin.needs.rebuild(new Date());
		this.drawList();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-stock");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Stock" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		const actions = top.createDiv({ cls: "pantry-head-actions" });
		this.hideEl = actions.createEl("button", { cls: "pantry-text-button" });
		this.hideEl.onclick = () => {
			this.forget();
			this.drawList();
		};

		drawRoundBanner(inner, this.plugin, this);

		const search = inner.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search products", enterkeyhint: "search" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.drawList();
		});

		segment<Filter>(
			inner,
			[
				{ value: "all", label: "All" },
				{ value: "check", label: "To check" },
				{ value: "buy", label: "To buy" },
			],
			this.filter,
			(value) => {
				// A different filter is a different list, so it starts at the top
				// and holds nothing over from the previous one.
				this.forget();
				this.filter = value;
				this.plugin.ui.stock.scroll = 0;
				this.draw();
				this.contentEl.scrollTop = 0;
				guarded("could not refresh your stock", () => this.reload());
			}
		);

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawList();
	}

	/** What this week's meals ask for on top of the minimum. */
	private extra(product: Product): number {
		return this.plugin.needs.get(product);
	}

	/**
	 * The number the control runs to: the minimum plus this week's cooking.
	 *
	 * Het minimum komt via `needs`, want tijdens een boodschappenronde telt
	 * het alleen voor de winkels die meedoen.
	 */
	private need(product: Product): number {
		return this.plugin.needs.minimumOf(product) + this.extra(product);
	}

	/**
	 * Hoeveel je hiervan moet kopen — dezelfde som als de boodschappenlijst.
	 *
	 * Stond hier met de hand overgeschreven, en zónder de ± aanpassingen uit
	 * het boodschappenscherm. Na een handmatige ophoging in de winkel zei
	 * Groceries "koop 3" en Voorraad "koop 2" over hetzelfde product.
	 */
	private buy(product: Product): number | null {
		return this.plugin.list.amount(product);
	}

	/**
	 * Nothing is wanted of it and this week's meals do not ask for it either, so
	 * there is nothing to count. A product Jeroen flagged himself still shows:
	 * the flag is a deliberate "look at this one" and outranks the rule.
	 */
	private irrelevant(product: Product): boolean {
		return !product.check && this.need(product) === 0;
	}

	/** Whether this product belongs in the list the way it is filtered now. */
	private belongs(product: Product): boolean {
		if (this.irrelevant(product)) return false;
		if (this.filter === "check") return product.check;
		if (this.filter === "buy") {
			const buy = this.buy(product);
			return buy === null || buy > 0;
		}
		return true;
	}

	private visible(): Product[] {
		const query = this.query.trim().toLowerCase();
		return this.plugin.products.all().filter((product) => {
			if (query.length > 0) {
				if (!matchesQuery(query, [product.name, ...product.aliases])) return false;
				// Wie een naam intypt zoekt dát product, niet een selectie.
				// `irrelevant()` verbergt een product met minimum 0 waar deze
				// week geen recept om vraagt — dus je typte "bakpapier" en
				// kreeg "No matches", terwijl het gewoon bestond.
				return true;
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
			await this.plugin.products.update(product, patch);
			this.hold(product);
			this.drawList();
		});
	}

	private hold(product: Product): void {
		if (this.belongs(product)) this.leaving.delete(product.path);
		else this.leaving.add(product.path);
	}

	/** Drops every held row at once. The button in the header, and nothing else. */
	private forget(): void {
		this.leaving.clear();
	}

	/**
	 * Shows the clean-up button only when there is something to clean up, and
	 * says how many rows will go, so pressing it holds no surprises.
	 */
	private drawHideButton(): void {
		const button = this.hideEl;
		if (!button) return;
		const held = this.leaving.size;
		button.toggleClass("is-hidden", held === 0);
		button.setText(`Hide checked (${held})`);
		button.setAttr("aria-label", `Hide ${held} finished rows`);
	}

	private drawList(): void {
		const body = this.bodyEl;
		if (!body) return;

		const restore = keepScroll(body);
		body.empty();
		this.drawHideButton();

		const all = this.plugin.products.all();
		if (all.length === 0) {
			this.empty(body, "No products yet", "Add them in Products first.");
			this.countEl?.setText("");
			return;
		}

		let buying = 0;
		let checking = 0;
		all.forEach((product) => {
			if (product.check) checking++;
			const buy = this.buy(product);
			if (buy !== null && buy > 0) buying++;
		});
		const parts = [`${buying} to buy`];
		if (checking > 0) parts.push(`${checking} to check`);
		this.countEl?.setText(parts.join("  ·  "));

		const shown = this.visible();
		if (shown.length === 0) {
			this.empty(
				body,
				this.filter === "check"
					? "Nothing to check"
					: this.filter === "buy"
						? "Nothing to buy"
						: "No matches",
				this.filter === "all"
					? "Try a different search."
					: "Everything here is settled."
			);
			return;
		}

		const groups = new Map<string, Product[]>();
		shown.forEach((product) => {
			const key = product.storage || UNASSIGNED;
			const bucket = groups.get(key) ?? [];
			bucket.push(product);
			groups.set(key, bucket);
		});

		[...groups.keys()]
			.sort((a, b) =>
				a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)
			)
			.forEach((storage) => {
				const items = (groups.get(storage) ?? []).sort((a, b) =>
					a.name.localeCompare(b.name)
				);
				this.drawGroup(body, storage, items);
			});

		restore();
	}

	private empty(parent: HTMLElement, title: string, hint: string): void {
		emptyState(parent, title, hint);
	}

	private drawGroup(parent: HTMLElement, storage: string, items: Product[]): void {
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
		items.forEach((product) => this.drawRow(list, product));
	}

	private drawRow(parent: HTMLElement, product: Product): void {
		const row = parent.createDiv({ cls: "pantry-stock-row" });
		row.toggleClass("is-flagged", product.check);
		row.toggleClass("is-leaving", this.leaving.has(product.path));

		const top = row.createDiv({ cls: "pantry-stock-line" });
		const name = top.createDiv({ cls: "pantry-stock-name is-tappable" });
		name.createSpan({ text: product.name });
		name.setAttr("role", "button");
		name.setAttr("aria-label", `Edit ${product.name}`);
		// A product moves house more often than you would think; fix it where
		// you notice it, which is here, halfway through the counting round.
		name.onclick = () =>
			new ProductSheet(this.plugin, product, "storage", () => this.drawList()).open();
		if (product.unit) {
			name.createSpan({ cls: "pantry-stock-unit", text: product.unit });
		}

		const buy = this.buy(product);
		const need = this.need(product);
		if (need <= 0) {
			top.createDiv({ cls: "pantry-status is-quiet", text: "no minimum set" });
		} else if (buy === null) {
			top.createDiv({ cls: "pantry-status is-quiet", text: "not counted" });
		} else if (buy > 0) {
			top.createDiv({ cls: "pantry-status is-buy", text: `buy ${buy}` });
		} else {
			top.createDiv({ cls: "pantry-status is-ok", text: "enough" });
		}

		const controls = row.createDiv({ cls: "pantry-stock-controls" });
		if (Math.max(need, 1) <= STRIP_LIMIT) this.drawStrip(controls, product);
		else this.drawStepper(controls, product);

		const check = controls.createEl("button", { cls: "pantry-flag" });
		const icon = check.createSpan({ cls: "pantry-flag-icon" });
		setIcon(icon, product.check ? "bookmark-check" : "bookmark");
		check.createSpan({ cls: "pantry-flag-label", text: "check" });
		check.toggleClass("is-active", product.check);
		check.setAttr("aria-pressed", product.check ? "true" : "false");
		check.setAttr(
			"aria-label",
			product.check ? "On the check list" : "Put on the check list"
		);
		check.onclick = () => this.change(product, { check: !product.check });
	}

	private drawStrip(parent: HTMLElement, product: Product): void {
		const strip = parent.createDiv({ cls: "pantry-strip" });
		const max = Math.max(this.need(product), 1);

		// Highest on the left: "plenty" is the answer given most often, so it
		// sits where the thumb lands first.
		this.stripButton(strip, product, "plus", `${max}+`, "is-plus");
		for (let value = max; value >= 0; value--) {
			this.stripButton(
				strip,
				product,
				value,
				`${value}`,
				value === 0 ? "is-zero" : ""
			);
		}
	}

	private stripButton(
		strip: HTMLElement,
		product: Product,
		value: Count,
		label: string,
		extraClass: string
	): void {
		const button = strip.createEl("button", {
			cls: `pantry-strip-item ${extraClass}`.trim(),
			text: label,
		});
		const active = product.count === value;
		button.toggleClass("is-active", active);
		button.onclick = () => {
			// Tapping the same value again means "never mind", so it clears.
			const next: Count | null = active ? null : value;
			this.change(product, { count: next, check: false });
		};
	}

	private drawStepper(parent: HTMLElement, product: Product): void {
		const wrap = parent.createDiv({ cls: "pantry-stepper" });
		const max = Math.max(this.need(product), 1);

		// De stand zoals de gebruiker hem aan het maken is, los van wat er op
		// schijf staat. − en + lazen eerst allebei `product.count` op kliktijd
		// en wachtten dan een frontmatter-write af; twee snelle tikken lazen
		// dus dezelfde waarde en telden er samen één bij.
		let wanted: Count | null =
			product.count === "plus"
				? "plus"
				: typeof product.count === "number"
					? product.count
					: null;
		let pending = 0;

		const asNumber = (): number =>
			wanted === "plus" ? max : typeof wanted === "number" ? wanted : 0;

		const none = wrap.createEl("button", {
			cls: "pantry-stepper-edge",
			text: "0",
		});
		const minus = wrap.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(minus, "minus");
		const value = wrap.createDiv({ cls: "pantry-stepper-value" });
		const plus = wrap.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(plus, "plus");
		const plenty = wrap.createEl("button", {
			cls: "pantry-stepper-edge",
			text: `${max}+`,
		});

		const paint = (): void => {
			none.toggleClass("is-active", wanted === 0);
			plenty.toggleClass("is-active", wanted === "plus");
			value.setText(
				wanted === "plus" ? `${max}+` : wanted === null ? "–" : `${wanted}`
			);
		};
		paint();

		const set = (next: Count | null): void => {
			wanted = next;
			paint();
			window.clearTimeout(pending);
			// Wachten tot de vingers stilliggen; anders is elke tik een
			// schrijfactie naar de frontmatter.
			pending = window.setTimeout(() => {
				this.change(product, { count: wanted, check: false });
			}, 350);
		};

		none.onclick = () => set(0);
		minus.onclick = () => set(Math.max(0, asNumber() - 1));
		plus.onclick = () => set(Math.min(max, asNumber() + 1));
		plenty.onclick = () => set("plus");
	}
}
