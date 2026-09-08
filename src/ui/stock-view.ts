import { ItemView, WorkspaceLeaf } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { toBuy, type Product } from "../products";
import { drawBackLink } from "./nav";
import { StockPanel } from "./stock-panel";

export const STOCK_VIEW_TYPE = "pantry-stock";

/**
 * All stock: elk product, geteld tegen elk minimum en het hele plan.
 *
 * Boodschappen doen gaat per lijst — daar zit de voorraadcheck die ertoe
 * doet. Dit scherm is er voor wie buiten een lijst om wil tellen, de vlag
 * "even kijken" wil zetten, of gewoon wil zien wat er in huis is. Het schrijft
 * geen lijst.
 */
export class StockView extends ItemView {
	private plugin: PantryPlugin;
	private panel: StockPanel;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.panel = new StockPanel({
			plugin,
			memory: plugin.ui.stock,
			candidates: () => plugin.products.all().filter((product) => !product.ignored),
			need: (product: Product) => product.minimum + plugin.needs.get(product),
			buy: (product: Product) => toBuy(product, plugin.needs.get(product)),
			reload: () => plugin.needs.rebuild(new Date()),
		});
	}

	getViewType(): string {
		return STOCK_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "All stock";
	}

	getIcon(): string {
		return "layout-list";
	}

	onOpen(): Promise<void> {
		guarded("could not load your stock", async () => {
			await this.plugin.needs.rebuild(new Date());
			this.draw();
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
		this.panel.forget();
		return Promise.resolve();
	}

	refresh(): void {
		guarded("could not refresh your stock", async () => {
			await this.plugin.needs.rebuild(new Date());
			this.panel.drawList();
		});
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
		titles.createEl("h1", { cls: "pantry-head-title", text: "All stock" });
		const count = titles.createDiv({ cls: "pantry-head-sub" });
		const actions = top.createDiv({ cls: "pantry-head-actions" });

		const body = root.createDiv({ cls: "pantry-body" });
		this.panel.mount(inner, actions, body, count);
	}
}
