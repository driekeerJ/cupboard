import { setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import type { Product } from "../products";
import type { Extra } from "../extras";
import type { ShopGroup } from "../grouping";
import { listLabel, type ShoppingList } from "../shopping-list";
import { emptyState, keepScroll } from "./kit";
import { ExtraModal } from "./extra-modal";
import { ProductSheet } from "./product-sheet";

/**
 * De derde stap: de lijst die je in de winkel vasthoudt.
 *
 * Elke tik werkt de voorraad van dat ene product meteen bij, en het mandje
 * staat in de notitie van de lijst — dus je telefoon en je laptop zien
 * hetzelfde, en een herstart halverwege de winkel kost niets.
 */
export class ShopStep {
	private plugin: PantryPlugin;
	private list: ShoppingList;
	/** The row whose amount is open for adjusting; only ever one at a time. */
	private editing: string | null = null;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;

	constructor(plugin: PantryPlugin, list: ShoppingList) {
		this.plugin = plugin;
		this.list = list;
	}

	// The chosen shop lives in the view memory, not here: tapping a product
	// name opens its sheet and can take you out to the note, which destroys
	// this view, and coming back to the top of "All" mid-shop is useless.
	private get shop(): string {
		return this.plugin.ui.list(this.list.path).shop.shop;
	}

	private set shop(value: string) {
		this.plugin.ui.list(this.list.path).shop.shop = value;
	}

	private amount(product: Product): number | null {
		return this.plugin.lists.amount(this.list, product);
	}

	private isDone(product: Product): boolean {
		return this.list.basket.has(product.path);
	}

	private async reload(): Promise<void> {
		await this.plugin.lists.refresh(this.list);
		this.drawList();
	}

	mount(head: HTMLElement, actions: HTMLElement, body: HTMLElement, countEl: HTMLElement): void {
		this.bodyEl = body;
		this.countEl = countEl;

		// Bedenk je onderweg iets dat geen product is, dan hoort dat hier op
		// te kunnen, en niet via een omweg langs de productenmap.
		const add = actions.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: "Add item",
		});
		add.setAttr("aria-label", "Add a loose item to the list");
		add.onclick = () => this.addExtra();

		const track = head.createDiv({ cls: "pantry-progress" });
		this.barEl = track.createDiv({ cls: "pantry-progress-bar" });

		const { buy } = this.plugin.lists.buckets(this.list);
		const shops = this.plugin.lists
			.groups(this.list, [...buy, ...this.plugin.lists.boughtProducts(this.list)])
			.map((group) => group.shop);
		// Het filter leeft in ViewMemory, dus het overleeft het verdwijnen van
		// de chips. Valt de laatste winkel weg, dan zou de lijst leeg en
		// onbereikbaar zijn tot Obsidian herstartte.
		if (this.shop !== "" && !shops.includes(this.shop)) this.shop = "";
		if (shops.length > 1) {
			const filters = head.createDiv({ cls: "pantry-segment" });
			const all = filters.createEl("button", { cls: "pantry-segment-item", text: "All" });
			all.toggleClass("is-active", this.shop === "");
			all.onclick = () => this.pickShop("", filters);
			shops.forEach((shop) => {
				const chip = filters.createEl("button", { cls: "pantry-segment-item", text: shop });
				chip.toggleClass("is-active", this.shop === shop);
				chip.onclick = () => this.pickShop(shop, filters);
			});
		}

		this.drawList();
	}

	/** Another shop is another list, so it starts at the top. */
	private pickShop(shop: string, filters: HTMLElement): void {
		this.shop = shop;
		filters.querySelectorAll(".pantry-segment-item").forEach((chip) => {
			chip.toggleClass("is-active", chip.textContent === (shop || "All"));
		});
		this.plugin.ui.list(this.list.path).shop.scroll = 0;
		this.drawList();
		const scroller = this.bodyEl?.closest(".view-content");
		if (scroller) scroller.scrollTop = 0;
	}

	drawList(): void {
		const body = this.bodyEl;
		if (!body) return;

		const restore = keepScroll(body);
		body.empty();

		const lists = this.plugin.lists;
		const { buy, unsure, elsewhere, notHere } = lists.buckets(this.list);
		const bought = lists.boughtProducts(this.list);
		const items = [...buy, ...bought];
		const extras = this.list.extras;
		const done = bought.length;
		// Een los regeltje telt gewoon mee: in de winkel is het net zo goed
		// iets dat nog in je kar moet, en het verdwijnt zodra je het aantikt.
		const total = items.length + extras.length;
		const open = total - done;

		const parts = [`${open} to buy`];
		if (done > 0) parts.push(`${done} in the basket`);
		if (unsure.length > 0) parts.push(`${unsure.length} to check`);
		this.countEl?.setText(parts.join("  ·  "));

		if (this.barEl) {
			const ratio = total === 0 ? 0 : done / total;
			this.barEl.style.width = `${Math.round(ratio * 100)}%`;
			this.barEl.parentElement?.toggleClass("is-hidden", total === 0);
		}

		if (total === 0 && unsure.length === 0 && elsewhere.length === 0 && notHere.length === 0) {
			emptyState(
				body,
				"Nothing needed",
				"Count a few products in Check stock and they turn up here — or add something you thought of yourself."
			);
			return;
		}

		const groups = lists.groups(this.list, items);
		groups
			.filter((group) => this.shop === "" || group.shop === this.shop)
			.forEach((group) => this.drawShop(body, groups.length > 1 ? group.shop : "", group));

		if (this.shop !== "") {
			restore();
			return;
		}

		if (unsure.length > 0) {
			const section = this.section(body, "Check first", unsure.length);
			[...unsure]
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => this.drawRow(section, product, "never counted"));
		}

		// Staat al op een eerdere lijst: hier alleen ter herinnering, zodat je
		// hem niet twee keer koopt — en het ziet als die andere lijst niet
		// doorgaat.
		if (elsewhere.length > 0) {
			const section = this.section(body, "On another list", elsewhere.length);
			[...elsewhere]
				.sort((a, b) => a.product.name.localeCompare(b.product.name))
				.forEach(({ product, list }) =>
					this.drawQuietRow(section, product, listLabel(list))
				);
		}

		// Een maaltijd vraagt erom, maar het ligt niet waar je heen gaat. Geen
		// regel op de lijst, wel een waarschuwing — jij kiest wat je ermee doet.
		if (notHere.length > 0) {
			const where = this.list.shops.join(" · ");
			const section = this.section(body, where ? `Not at ${where}` : "Not here", notHere.length);
			[...notHere]
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) =>
					this.drawQuietRow(
						section,
						product,
						product.shops.length > 0 ? `at ${product.shops.join(", ")}` : "no shop set"
					)
				);
		}

		restore();
	}

	private section(parent: HTMLElement, title: string, count: number): HTMLElement {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: title });
		heading.createSpan({ cls: "pantry-section-count", text: `${count}` });
		return section.createDiv({ cls: "pantry-section-body" });
	}

	private drawShop(parent: HTMLElement, shop: string, group: ShopGroup): void {
		const section = parent.createDiv({ cls: "pantry-section" });

		if (shop) {
			const heading = section.createDiv({ cls: "pantry-section-head is-static" });
			heading.createSpan({ cls: "pantry-section-name", text: shop });
			heading.createSpan({
				cls: "pantry-section-count",
				text: `${group.items.length + group.extras.length}`,
			});
		}

		const list = section.createDiv({ cls: "pantry-section-body" });

		// Groepering en volgorde komen uit `groups()`, dezelfde functie die de
		// notitie schrijft — anders lopen het scherm en de notitie uit elkaar.
		// Wat hier bovenop komt is van dit scherm alleen: wat in het mandje
		// ligt zakt naar onderen.
		group.shelves.forEach(({ shelf, items, extras }) => {
			if (group.shelves.length > 1) list.createDiv({ cls: "pantry-shelf", text: shelf });
			[...items]
				.sort((a, b) => (this.isDone(a) ? 1 : 0) - (this.isDone(b) ? 1 : 0))
				.forEach((product) => this.drawRow(list, product, null));
			extras.forEach((extra) => this.drawExtraRow(list, extra));
		});
	}

	private drawExtraRow(parent: HTMLElement, extra: Extra): void {
		const row = parent.createDiv({ cls: "pantry-buy-row is-extra" });

		const tick = row.createEl("button", { cls: "pantry-tick" });
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
		tick.setAttr("aria-pressed", "false");
		tick.setAttr("aria-label", `Got ${extra.name}, take it off the list`);
		tick.onclick = () =>
			guarded(`could not tick ${extra.name} off`, async () => {
				await this.plugin.lists.removeExtra(this.list, extra.id);
				this.drawList();
			});

		const main = row.createDiv({ cls: "pantry-buy-main is-tappable" });
		main.createDiv({ cls: "pantry-buy-name", text: extra.name });
		main.setAttr("role", "button");
		main.setAttr("aria-label", `Edit ${extra.name}`);
		main.onclick = () => this.editExtra(extra);
		main.createDiv({ cls: "pantry-buy-meta", text: "loose item" });

		row.createDiv({ cls: "pantry-quantity is-static", text: `${extra.amount}` });
	}

	private addExtra(): void {
		this.editing = null;
		new ExtraModal(this.plugin, this.list, null, () =>
			guarded("could not refresh your shopping list", () => this.reload())
		).open();
	}

	private editExtra(extra: Extra): void {
		this.editing = null;
		new ExtraModal(this.plugin, this.list, extra, () =>
			guarded("could not refresh your shopping list", () => this.reload())
		).open();
	}

	/** Een regel zonder tik: iets om te weten, niet om te kopen. */
	private drawQuietRow(parent: HTMLElement, product: Product, meta: string): void {
		const row = parent.createDiv({ cls: "pantry-buy-row is-quiet" });
		const main = row.createDiv({ cls: "pantry-buy-main is-tappable" });
		main.createDiv({ cls: "pantry-buy-name", text: product.name });
		main.setAttr("role", "button");
		main.setAttr("aria-label", `Edit ${product.name}`);
		main.onclick = () => this.edit(product);
		main.createDiv({ cls: "pantry-buy-meta is-moved", text: meta });
		row.createDiv({
			cls: "pantry-quantity is-static",
			text: this.plugin.lists.amountText(this.list, product),
		});
	}

	private drawRow(parent: HTMLElement, product: Product, meta: string | null): void {
		const row = parent.createDiv({ cls: "pantry-buy-row" });
		const done = this.isDone(product);
		const editing = this.editing === product.path;
		row.toggleClass("is-done", done);
		row.toggleClass("is-editing", editing);

		const tick = row.createEl("button", { cls: "pantry-tick" });
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
		tick.setAttr("aria-pressed", done ? "true" : "false");
		tick.setAttr("aria-label", done ? "Not bought after all" : "In the basket");
		tick.onclick = () =>
			guarded(`could not tick ${product.name} off`, () => this.toggle(product));

		const main = row.createDiv({ cls: "pantry-buy-main is-tappable" });
		main.createDiv({ cls: "pantry-buy-name", text: product.name });
		main.setAttr("role", "button");
		main.setAttr("aria-label", `Edit ${product.name}`);
		main.onclick = () => this.edit(product);
		if (meta) main.createDiv({ cls: "pantry-buy-meta", text: meta });

		const label = this.plugin.lists.amountText(this.list, product);
		if (done || meta) {
			row.createDiv({ cls: "pantry-quantity is-static", text: label });
			return;
		}

		if (!editing) {
			const button = row.createEl("button", { cls: "pantry-quantity", text: label });
			button.setAttr("aria-label", `Adjust how many: ${label}`);
			button.onclick = () => {
				this.editing = product.path;
				this.drawList();
			};
			return;
		}

		const stepper = row.createDiv({ cls: "pantry-quantity-edit" });
		const minus = stepper.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(minus, "minus");
		minus.onclick = () => this.nudge(product, -1);

		stepper.createDiv({ cls: "pantry-quantity-value", text: label });

		const plus = stepper.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(plus, "plus");
		plus.onclick = () => this.nudge(product, 1);

		const close = stepper.createEl("button", { cls: "pantry-stepper-done" });
		setIcon(close, "check");
		close.setAttr("aria-label", "Done adjusting");
		close.onclick = () => {
			this.editing = null;
			this.drawList();
		};
	}

	/**
	 * Standing in the shop and seeing a product under the wrong shelf is the
	 * moment you can actually fix it, so the name is a button.
	 */
	private edit(product: Product): void {
		this.editing = null;
		new ProductSheet(
			this.plugin,
			product,
			"shop",
			() => guarded("could not refresh your shopping list", () => this.reload()),
			null,
			this.plugin.lists.needsOf(this.list)
		).open();
	}

	private nudge(product: Product, step: number): void {
		const current = this.amount(product) ?? 0;
		if (step < 0 && current <= 1) return;
		guarded("could not update your shopping list", async () => {
			await this.plugin.lists.setNudge(
				this.list,
				product,
				(this.list.nudge.get(product.path) ?? 0) + step
			);
			this.drawList();
		});
	}

	/**
	 * Ticking is the whole bookkeeping: bought means there is more than enough
	 * again. Unticking restores the count that was there, never "full".
	 */
	private async toggle(product: Product): Promise<void> {
		this.editing = null;
		if (this.isDone(product)) await this.plugin.lists.undoBought(this.list, product);
		else await this.plugin.lists.markBought(this.list, product);
		this.drawList();
	}
}
