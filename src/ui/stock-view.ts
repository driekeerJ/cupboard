import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { startOfWeek } from "../date";
import type PantryPlugin from "../main";
import { UNASSIGNED, type Count, type Product, type ProductPatch } from "../products";
import { drawBackLink } from "./nav";
import { ProductSheet } from "./product-sheet";
import type { StockFilter as Filter } from "./view-memory";

export const STOCK_VIEW_TYPE = "pantry-stock";

/** Above this many, a segmented control stops being a control and becomes a wall. */
const STRIP_LIMIT = 8;

/**
 * How long a row stays put after a tap has taken it out of the current list.
 * Counting is a rhythm — 1, 2, 3 — and sometimes a correction right after; a
 * row that vanishes on the first tap takes the rest of that rhythm with it.
 */
const LINGER_MS = 5000;

/**
 * The counting screen. One row per product, and the only thing the user does is
 * tap how many are there: a segmented control running from "more than enough"
 * down to zero. No keyboard, no number field, one gesture.
 */
export class StockView extends ItemView {
	private plugin: PantryPlugin;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	// Rows that no longer belong in this list but are being held in place for a
	// moment, by product path, each with the timer that will let it go.
	private leaving = new Map<string, number>();

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

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path.startsWith(`${this.plugin.products.folder()}/`)) {
					this.plugin.products.build();
					this.drawList();
				}
			})
		);
		this.draw();
		void this.reload().then(() => this.restoreScroll());
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

	async onClose(): Promise<void> {
		this.forget();
	}

	refresh(): void {
		void this.reload();
	}

	private async reload(): Promise<void> {
		await this.plugin.needs.rebuild(
			startOfWeek(new Date(), this.plugin.settings.weekStartDay)
		);
		this.drawList();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-stock");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const titles = inner.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Stock" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		const search = inner.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search products", enterkeyhint: "search" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.drawList();
		});

		const filters = inner.createDiv({ cls: "pantry-segment" });
		const options: Array<[Filter, string]> = [
			["all", "All"],
			["check", "To check"],
			["buy", "To buy"],
		];
		options.forEach(([value, label]) => {
			const chip = filters.createEl("button", {
				cls: "pantry-segment-item",
				text: label,
			});
			chip.toggleClass("is-active", this.filter === value);
			chip.onclick = () => {
				// A different filter is a different list, so it starts at the top
				// and holds nothing over from the previous one.
				this.forget();
				this.filter = value;
				this.plugin.ui.stock.scroll = 0;
				this.draw();
				this.contentEl.scrollTop = 0;
				void this.reload();
			};
		});

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawList();
	}

	/** What this week's meals ask for on top of the minimum. */
	private extra(product: Product): number {
		return this.plugin.needs.get(product);
	}

	/** The number the control runs to: the minimum plus this week's cooking. */
	private need(product: Product): number {
		return product.minimum + this.extra(product);
	}

	private buy(product: Product): number | null {
		if (product.count === null) return null;
		if (product.count === "plus") return 0;
		return Math.max(0, this.need(product) - product.count);
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
				const haystack = [product.name, ...product.aliases]
					.join(" ")
					.toLowerCase();
				if (!haystack.includes(query)) return false;
			}
			return this.belongs(product) || this.leaving.has(product.path);
		});
	}

	/**
	 * Writes a change made from a row, and keeps that row on screen for a beat
	 * when the change is what removed it from the list. Every further tap on the
	 * same row starts the wait over, so correcting a count is never a race.
	 */
	private change(product: Product, patch: ProductPatch): void {
		void this.plugin.products.update(product, patch).then(() => {
			this.hold(product);
			this.drawList();
		});
	}

	private hold(product: Product): void {
		const running = this.leaving.get(product.path);
		if (running !== undefined) window.clearTimeout(running);
		if (this.belongs(product)) {
			this.leaving.delete(product.path);
			return;
		}
		this.leaving.set(
			product.path,
			window.setTimeout(() => {
				this.leaving.delete(product.path);
				this.drawList();
			}, LINGER_MS)
		);
	}

	/** Drops every held row at once, without waiting out its timer. */
	private forget(): void {
		this.leaving.forEach((timer) => window.clearTimeout(timer));
		this.leaving.clear();
	}

	private drawList(): void {
		const body = this.bodyEl;
		if (!body) return;

		const scroller = body.parentElement;
		const scroll = scroller?.scrollTop ?? 0;
		body.empty();

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

		if (scroller) scroller.scrollTop = scroll;
	}

	private empty(parent: HTMLElement, title: string, hint: string): void {
		const wrap = parent.createDiv({ cls: "pantry-empty" });
		wrap.createDiv({ cls: "pantry-empty-title", text: title });
		wrap.createDiv({ cls: "pantry-empty-hint", text: hint });
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
		const current =
			product.count === "plus"
				? max
				: typeof product.count === "number"
					? product.count
					: null;

		const set = (next: Count | null): void => {
			this.change(product, { count: next, check: false });
		};

		const none = wrap.createEl("button", {
			cls: "pantry-stepper-edge",
			text: "0",
		});
		none.toggleClass("is-active", product.count === 0);
		none.onclick = () => set(0);

		const minus = wrap.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(minus, "minus");
		minus.onclick = () => set(Math.max(0, (current ?? 0) - 1));

		wrap.createDiv({
			cls: "pantry-stepper-value",
			text:
				product.count === "plus"
					? `${max}+`
					: current === null
						? "–"
						: `${current}`,
		});

		const plus = wrap.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(plus, "plus");
		plus.onclick = () => set(Math.min(max, (current ?? 0) + 1));

		const plenty = wrap.createEl("button", {
			cls: "pantry-stepper-edge",
			text: `${max}+`,
		});
		plenty.toggleClass("is-active", product.count === "plus");
		plenty.onclick = () => set("plus");
	}
}
