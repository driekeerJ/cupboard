import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import type { Product } from "../products";
import {
	assignmentFor,
	assignmentNote,
	groupForShopping,
	type ShopGroup,
} from "../list";
import type { Extra } from "../extras";
import { emptyState, keepScroll } from "./kit";
import { drawBackLink } from "./nav";
import { ExtraModal } from "./extra-modal";
import { ProductSheet } from "./product-sheet";

export const SHOPPING_VIEW_TYPE = "pantry-shopping";



/**
 * The list you hold in the shop. There is no such thing as a shopping trip
 * here: every tick updates that one product's stock straight away, so a
 * half-finished round needs no state and tomorrow's list is simply what is
 * still missing.
 */
export class ShoppingView extends ItemView {
	private plugin: PantryPlugin;

	// The chosen shop lives on the plugin, not here: tapping a product name
	// opens its sheet and can take you out to the note, which destroys this
	// view, and coming back to the top of "All" mid-shop is useless.
	private get shop(): string {
		return this.plugin.ui.shopping.shop;
	}

	private set shop(value: string) {
		this.plugin.ui.shopping.shop = value;
	}

	/** The row whose amount is open for adjusting; only ever one at a time. */
	private editing: string | null = null;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SHOPPING_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Groceries";
	}

	getIcon(): string {
		return "shopping-cart";
	}

	onOpen(): Promise<void> {
		this.draw();
		guarded("could not load your grocery list", async () => {
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
		const wanted = this.plugin.ui.shopping.scroll;
		window.requestAnimationFrame(() => {
			if (wanted > 0) this.contentEl.scrollTop = wanted;
			window.requestAnimationFrame(() => {
				this.registerDomEvent(this.contentEl, "scroll", () => {
					this.plugin.ui.shopping.scroll = this.contentEl.scrollTop;
				});
			});
		});
	}

	refresh(): void {
		guarded("could not refresh your grocery list", () => this.reload());
	}

	private async reload(): Promise<void> {
		await this.plugin.list.refresh();
		this.draw();
	}

	private amount(product: Product): number | null {
		return this.plugin.list.amount(product);
	}

	private isDone(product: Product): boolean {
		return this.plugin.list.bought.has(product.path);
	}

	/** The same split the note is built from, so the two can never disagree. */
	private buckets(): { buy: Product[]; unsure: Product[] } {
		const { buy, unsure } = this.plugin.list.buckets();
		return { buy: [...buy, ...this.plugin.list.boughtProducts()], unsure };
	}

	/** De losse boodschappen van deze ronde; zie src/extras.ts. */
	private get extras(): Extra[] {
		return this.plugin.list.extras;
	}

	/** De winkels waar deze lijst langs loopt, in dezelfde volgorde als de lijst. */
	private shops(items: Product[]): string[] {
		return groupForShopping(this.plugin, items, this.extras).map(
			(group) => group.shop
		);
	}

	private draw(): void {
		const root = this.contentEl;
		// A refresh redraws the whole screen, header and all; without this the
		// list would jump to the top every time a tick updates the counts.
		const scroll = root.scrollTop;
		root.empty();
		root.addClass("pantry-app", "pantry-shopping");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Groceries" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		// Bedenk je onderweg iets dat geen product is, dan hoort dat hier op
		// te kunnen, en niet via een omweg langs de productenmap.
		const actions = top.createDiv({ cls: "pantry-head-actions" });
		const add = actions.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: "Add item",
		});
		add.setAttr("aria-label", "Add a loose item to the list");
		add.onclick = () => this.addExtra();

		const track = inner.createDiv({ cls: "pantry-progress" });
		this.barEl = track.createDiv({ cls: "pantry-progress-bar" });

		const { buy } = this.buckets();
		const shops = this.shops(buy);
		// Het filter leeft in ViewMemory, dus het overleeft het verdwijnen van
		// de chips. Zet je het laatste Lidl-product op een andere winkel, dan
		// was er geen "All"-knop meer, bleef `this.shop` op "Lidl" staan, en was
		// de lijst leeg en onbereikbaar tot Obsidian herstartte.
		if (this.shop !== "" && !shops.includes(this.shop)) this.shop = "";
		if (shops.length > 1) {
			const filters = inner.createDiv({ cls: "pantry-segment" });
			const all = filters.createEl("button", {
				cls: "pantry-segment-item",
				text: "All",
			});
			all.toggleClass("is-active", this.shop === "");
			all.onclick = () => {
				this.shop = "";
				this.toTop();
			};
			shops.forEach((shop) => {
				const chip = filters.createEl("button", {
					cls: "pantry-segment-item",
					text: shop,
				});
				chip.toggleClass("is-active", this.shop === shop);
				chip.onclick = () => {
					this.shop = shop;
					this.toTop();
				};
			});
		}

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawList();
		if (scroll > 0) root.scrollTop = scroll;
	}

	/** Another shop is another list, so it starts at the top. */
	private toTop(): void {
		this.plugin.ui.shopping.scroll = 0;
		this.draw();
		this.contentEl.scrollTop = 0;
	}

	private drawList(): void {
		const body = this.bodyEl;
		if (!body) return;

		const restore = keepScroll(body);
		body.empty();

		const { buy, unsure } = this.buckets();
		const extras = this.extras;
		const done = buy.filter((product) => this.isDone(product)).length;
		// Een los regeltje telt gewoon mee: in de winkel is het net zo goed
		// iets dat nog in je kar moet, en het verdwijnt zodra je het aantikt.
		const total = buy.length + extras.length;
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

		if (total === 0 && unsure.length === 0) {
			emptyState(
				body,
				"Nothing needed",
				"Count a few products in Stock and they turn up here \u2014 or add something you thought of yourself."
			);
			return;
		}

		const groups = groupForShopping(this.plugin, buy, extras);
		groups
			.filter((group) => this.shop === "" || group.shop === this.shop)
			.forEach((group) => {
				this.drawShop(body, groups.length > 1 ? group.shop : "", group);
			});

		if (unsure.length > 0 && this.shop === "") {
			const section = body.createDiv({ cls: "pantry-section" });
			const heading = section.createDiv({ cls: "pantry-section-head is-static" });
			heading.createSpan({ cls: "pantry-section-name", text: "Check first" });
			heading.createSpan({
				cls: "pantry-section-count",
				text: `${unsure.length}`,
			});
			const list = section.createDiv({ cls: "pantry-section-body" });
			unsure
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => this.drawRow(list, product, true));
		}

		restore();
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

		// Groepering en volgorde komen uit `groupForShopping`, dezelfde functie
		// die de boodschappennotitie schrijft \u2014 anders lopen het scherm en de
		// notitie uit elkaar zonder dat iemand iets veranderd heeft. Wat hier
		// bovenop komt is van dit scherm alleen: wat in het mandje ligt zakt
		// naar onderen.
		group.shelves.forEach(({ shelf, items, extras }) => {
			if (group.shelves.length > 1) {
				list.createDiv({ cls: "pantry-shelf", text: shelf });
			}
			[...items]
				.sort((a, b) => (this.isDone(a) ? 1 : 0) - (this.isDone(b) ? 1 : 0))
				.forEach((product) => this.drawRow(list, product, false));
			// Onder de producten van hetzelfde schap: je loopt er in één keer
			// langs, en dat het geen product is hoef je pas te weten als je het
			// aantikt.
			extras.forEach((extra) => this.drawExtraRow(list, extra));
		});
	}

	/**
	 * Een los regeltje in de lijst.
	 *
	 * Ziet eruit als elke andere regel — dezelfde ronde tik, dezelfde naam,
	 * dezelfde stille hoeveelheid — want in de winkel is het onderscheid niet
	 * interessant. Het verschil zit in wat een tik doet: er is geen voorraad om
	 * bij te boeken en geen telling om naar terug te vallen, dus afvinken is
	 * wissen.
	 */
	private drawExtraRow(parent: HTMLElement, extra: Extra): void {
		const row = parent.createDiv({ cls: "pantry-buy-row is-extra" });

		const tick = row.createEl("button", { cls: "pantry-tick" });
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
		tick.setAttr("aria-pressed", "false");
		tick.setAttr("aria-label", `Got ${extra.name}, take it off the list`);
		tick.onclick = () =>
			guarded(`could not tick ${extra.name} off`, async () => {
				await this.plugin.list.removeExtra(extra.id);
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
		new ExtraModal(this.plugin, null, () =>
			guarded("could not refresh your grocery list", () => this.reload())
		).open();
	}

	private editExtra(extra: Extra): void {
		this.editing = null;
		new ExtraModal(this.plugin, extra, () =>
			guarded("could not refresh your grocery list", () => this.reload())
		).open();
	}

	private drawRow(parent: HTMLElement, product: Product, unsure: boolean): void {
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
		if (unsure) {
			main.createDiv({ cls: "pantry-buy-meta", text: "never counted" });
		} else {
			// Waarom dit product hier ligt en niet in zijn eigen winkel. Staat
			// naast het product, want daar wordt de vraag gesteld.
			const why = assignmentNote(assignmentFor(this.plugin, product));
			if (why) {
				const meta = main.createDiv({ cls: "pantry-buy-meta", text: why });
				meta.addClass("is-moved");
			}
		}

		const amount = this.amount(product);
		const label =
			amount === null
				? "?"
				: `${amount}${product.unit ? ` ${product.unit}` : ""}`;

		if (done || unsure) {
			row.createDiv({ cls: "pantry-quantity is-static", text: label });
			return;
		}

		if (!editing) {
			const button = row.createEl("button", {
				cls: "pantry-quantity",
				text: label,
			});
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
		new ProductSheet(this.plugin, product, "shop", () =>
			guarded("could not refresh your grocery list", () => this.reload())
		).open();
	}

	private nudge(product: Product, step: number): void {
		const current = this.amount(product) ?? 0;
		if (step < 0 && current <= 1) return;
		this.plugin.list.setNudge(
			product.path,
			(this.plugin.list.nudge.get(product.path) ?? 0) + step
		);
		guarded("could not update your grocery list", async () => {
			await this.plugin.list.write();
			this.drawList();
		});
	}

	/**
	 * Ticking is the whole bookkeeping: bought means there is more than enough
	 * again. Unticking restores the count that was there, never "full".
	 */
	private async toggle(product: Product): Promise<void> {
		this.editing = null;
		if (this.isDone(product)) await this.plugin.list.undoBought(product);
		else await this.plugin.list.markBought(product);
		this.drawList();
	}
}
