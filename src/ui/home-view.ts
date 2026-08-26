import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type PantryPlugin from "../main";
import { missingFields } from "../products";
import { formatRange, isoWeek, startOfWeek, toISODate } from "../date";
import { HOME_VIEW_TYPE, openHere } from "./nav";
import { PLANNER_VIEW_TYPE } from "../view/planner-view";
import { STOCK_VIEW_TYPE } from "./stock-view";
import { SHOPPING_VIEW_TYPE } from "./shopping-view";
import { SHELVES_VIEW_TYPE } from "./shelves-view";
import { CLEANUP_VIEW_TYPE } from "./cleanup-view";
import { PRODUCTS_VIEW_TYPE } from "./products-view";

export { HOME_VIEW_TYPE };

interface Tile {
	type: string;
	title: string;
	icon: string;
	/** What the screen is for, in one line. */
	hint: string;
	/** What it is asking of you right now, if anything. */
	state: () => { text: string; count: number };
}

/**
 * The front door.
 *
 * Every screen behind one icon, each tile saying what it is waiting for, so the
 * question "where was I" is answered before it is asked. Tapping a tile
 * replaces this screen in the same tab, and every screen carries a way back.
 *
 * There is nothing else: the command palette offers the front door and no
 * other screen, so this list is the only map of the plugin there is. That is
 * why a screen may never be reachable from here by a footer link alone.
 */
export class HomeView extends ItemView {
	private plugin: PantryPlugin;
	private bodyEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;
	private planned = 0;
	/** Meals up to and including today that have no eaten/skipped answer yet. */
	private toTick = 0;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Pantry";
	}

	getIcon(): string {
		return "chef-hat";
	}

	async onOpen(): Promise<void> {
		this.draw();
		await this.reload();
	}

	refresh(): void {
		void this.reload();
	}

	/** Everything a tile can say has to be read before the tiles are drawn. */
	private async reload(): Promise<void> {
		this.plugin.products.build();
		await this.plugin.shops.build();
		await this.plugin.list.refresh();
		await this.plugin.cleanup.rebuild();

		const week = startOfWeek(new Date(), this.plugin.settings.weekStartDay);
		const plan = await this.plugin.plans.load(week);
		this.planned = plan.days.reduce(
			(total, day) =>
				total +
				day.meals.reduce((count, meal) => count + meal.recipes.length, 0),
			0
		);

		// Nothing is ever booked behind your back, so meals that have come and
		// gone without an answer are the one thing the front door has to say.
		const today = toISODate(new Date());
		this.toTick = plan.days
			.filter((day) => day.date <= today)
			.reduce(
				(total, day) =>
					total +
					day.meals.reduce(
						(count, meal) =>
							count + meal.recipes.filter((entry) => !entry.status).length,
						0
					),
				0
			);

		this.drawBody();
	}

	private tiles(): Tile[] {
		const products = this.plugin.products.all();

		return [
			{
				type: PLANNER_VIEW_TYPE,
				title: "Meal planner",
				icon: "utensils-crossed",
				hint: "What you are eating this week",
				state: () => {
					if (this.toTick > 0) {
						return {
							text: `${this.toTick} meal${this.toTick === 1 ? "" : "s"} to tick off`,
							count: this.toTick,
						};
					}
					return {
						text:
							this.planned === 0
								? "nothing planned yet"
								: `${this.planned} meal${this.planned === 1 ? "" : "s"} planned`,
						count: this.planned === 0 ? 1 : 0,
					};
				},
			},
			{
				type: STOCK_VIEW_TYPE,
				title: "Stock",
				icon: "layout-list",
				hint: "How much of everything is in the house",
				state: () => {
					const open = products.filter(
						(product) => product.count === null || product.check
					).length;
					return {
						text: open === 0 ? "all counted" : `${open} to count`,
						count: open,
					};
				},
			},
			{
				type: SHOPPING_VIEW_TYPE,
				title: "Groceries",
				icon: "shopping-cart",
				hint: "What to buy, in walking order",
				state: () => {
					const { buy, unsure } = this.plugin.list.buckets();
					const total = buy.length + unsure.length;
					return {
						text: total === 0 ? "nothing to buy" : `${total} on the list`,
						count: total,
					};
				},
			},
			{
				type: PRODUCTS_VIEW_TYPE,
				title: "Products",
				icon: "package",
				hint: "The base list: everything you keep in the house",
				state: () => {
					// The one number worth interrupting for: a product that does
					// not say its unit, size, shop, shelf or place is invisible to
					// the planner and the list, however carefully it was counted.
					const gaps = products.filter(
						(product) => missingFields(product).length > 0
					).length;
					return {
						text:
							gaps === 0
								? `${products.length} product${products.length === 1 ? "" : "s"}`
								: `${gaps} missing info`,
						count: gaps,
					};
				},
			},
			{
				type: SHELVES_VIEW_TYPE,
				title: "Shelves",
				icon: "map",
				hint: "Where things lie in your shops",
				state: () => {
					const sorted = products.filter((product) => product.shelf).length;
					const left = products.length - sorted;
					return {
						text:
							left === 0
								? "all sorted"
								: `${left} product${left === 1 ? "" : "s"} unsorted`,
						count: left,
					};
				},
			},
			{
				type: CLEANUP_VIEW_TYPE,
				title: "Cleanup",
				icon: "wand-2",
				hint: "Make the recipes and the list agree",
				state: () => {
					const open =
						this.plugin.cleanup.open().length +
						this.plugin.cleanup.missing().length;
					return {
						text: open === 0 ? "nothing to sort out" : `${open} to sort out`,
						count: open,
					};
				},
			},
		];
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-home");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		const titles = inner.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Pantry" });
		this.subEl = titles.createDiv({ cls: "pantry-head-sub" });

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const week = startOfWeek(new Date(), this.plugin.settings.weekStartDay);
		this.subEl?.setText(`Week ${isoWeek(week).week} · ${formatRange(week)}`);

		const grid = body.createDiv({ cls: "pantry-tiles" });
		this.tiles().forEach((tile) => {
			const state = tile.state();
			const button = grid.createEl("button", { cls: "pantry-tile" });
			button.toggleClass("is-waiting", state.count > 0);

			const icon = button.createDiv({ cls: "pantry-tile-icon" });
			setIcon(icon, tile.icon);

			const text = button.createDiv({ cls: "pantry-tile-text" });
			text.createDiv({ cls: "pantry-tile-title", text: tile.title });
			text.createDiv({ cls: "pantry-tile-hint", text: tile.hint });
			text.createDiv({ cls: "pantry-tile-state", text: state.text });

			const chevron = button.createDiv({ cls: "pantry-tile-chevron" });
			setIcon(chevron, "chevron-right");

			button.onclick = () => void openHere(this, tile.type);
		});
	}
}
