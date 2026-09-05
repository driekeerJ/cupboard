import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type PantryPlugin from "../main";
import { missingFields } from "../products";
import { formatRange, isoWeek, toISODate } from "../date";
import { guarded } from "../guard";
import { HOME_VIEW_TYPE, openHere } from "./nav";
import { PLANNER_VIEW_TYPE } from "../view/planner-view";
import { STOCK_VIEW_TYPE } from "./stock-view";
import { SHOPPING_VIEW_TYPE } from "./shopping-view";
import { SHELVES_VIEW_TYPE } from "./shelves-view";
import { CLEANUP_VIEW_TYPE } from "./cleanup-view";
import { PRODUCTS_VIEW_TYPE } from "./products-view";
import { ROUND_VIEW_TYPE } from "./round-view";

export { HOME_VIEW_TYPE };

interface Tile {
	type: string;
	title: string;
	icon: string;
	/** What the screen is for, in one line. */
	hint: string;
	/** What it is asking of you right now, if anything. */
	state: () => { text: string; count: number };
	/**
	 * De notitie waar dit getal vandaan komt, als er één notitie is.
	 *
	 * Home was het enige scherm zonder weg naar de markdown: "3 maaltijden af
	 * te vinken" en "12 te tellen" komen allemaal uit notities en geen enkele
	 * was aan te klikken. Alleen bestánde notities krijgen een knop — een map
	 * openen kan alleen via Obsidians interne bestandsverkenner, en daar blijft
	 * de plugin vanaf.
	 */
	note?: () => string | null;
}

/**
 * The front door.
 *
 * Every screen behind one icon, each tile saying what it is waiting for, so the
 * question "where was I" is answered before it is asked. Tapping a tile
 * replaces this screen in the same tab, and every screen carries a way back.
 *
 * Deze lijst is de kaart van de plugin: elk scherm hoort hier te staan, ook nu
 * het commandopalet ze allemaal kan openen. Een scherm dat alleen via een
 * voetnootlink bereikbaar is, bestaat voor de meeste mensen niet.
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
		guarded("could not refresh the home screen", () => this.reload());
	}

	/**
	 * Everything a tile can say has to be read before the tiles are drawn.
	 *
	 * Lezen, nooit schrijven. Dit stond op `list.refresh()`, en dat is
	 * `needs.rebuild()` plús een schrijfactie naar `Groceries.md` — bij élke
	 * gedebouncede kluiswijziging, want dit scherm hangt aan `refreshViews()`.
	 * Bij een koude metadata-cache leverde dat bovendien een lege lijst op, en
	 * dan schreef het startscherm je boodschappennotitie leeg.
	 */
	private async reload(): Promise<void> {
		this.plugin.products.build();
		await this.plugin.shops.build();

		const week = this.plugin.currentWeek();
		await this.plugin.needs.rebuild(new Date());
		await this.plugin.cleanup.rebuild();

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
				note: () =>
					this.plugin.plans.notePath(
						this.plugin.currentWeek()
					),
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
					// Losse boodschappen staan op dezelfde lijst, dus ze horen
					// ook in het getal op de tegel.
					const total =
						buy.length + unsure.length + this.plugin.list.extras.length;
					return {
						text: total === 0 ? "nothing to buy" : `${total} on the list`,
						count: total,
					};
				},
				note: () => this.plugin.list.path(),
			},
			{
				type: ROUND_VIEW_TYPE,
				title: "Shopping round",
				icon: "list-checks",
				hint: "Shop for a recipe or one shop only",
				state: () => {
					// Een lopende ronde vraagt aandacht: zolang hij staat, volgt
					// niets het weekplan, en dat hoort op de voordeur te staan.
					const active = this.plugin.list.hasRound();
					return {
						text: active
							? this.plugin.list.roundLabel()
							: "following the meal plan",
						count: active ? 1 : 0,
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

		const week = this.plugin.currentWeek();
		this.subEl?.setText(`Week ${isoWeek(week).week} · ${formatRange(week)}`);

		const grid = body.createDiv({ cls: "pantry-tiles" });
		this.tiles().forEach((tile) => {
			const state = tile.state();
			// De tegel is een <button>, dus de notitieknop kan er niet in staan;
			// hij is een broer, met de rij eromheen als houder.
			const row = grid.createDiv({ cls: "pantry-tile-row" });
			const button = row.createEl("button", { cls: "pantry-tile" });
			button.toggleClass("is-waiting", state.count > 0);

			const icon = button.createDiv({ cls: "pantry-tile-icon" });
			setIcon(icon, tile.icon);

			const text = button.createDiv({ cls: "pantry-tile-text" });
			text.createDiv({ cls: "pantry-tile-title", text: tile.title });
			text.createDiv({ cls: "pantry-tile-hint", text: tile.hint });
			text.createDiv({ cls: "pantry-tile-state", text: state.text });

			const chevron = button.createDiv({ cls: "pantry-tile-chevron" });
			setIcon(chevron, "chevron-right");

			button.onclick = () =>
				guarded("could not open that screen", () => openHere(this, tile.type));

			this.drawNoteLink(row, tile);
		});
	}

	/** De weg naar de notitie waar het getal op de tegel vandaan komt. */
	private drawNoteLink(row: HTMLElement, tile: Tile): void {
		const path = tile.note?.() ?? null;
		if (!path) return;
		const file = this.plugin.app.vault.getFileByPath(path);
		// Geen knop naar iets wat er nog niet is: het weekplan bestaat pas
		// zodra er een maaltijd in staat.
		if (!file) return;

		const open = row.createEl("button", {
			cls: "pantry-icon-button pantry-tile-note",
			attr: { "aria-label": `Open ${file.basename}` },
		});
		setIcon(open, "file-text");
		open.onclick = (event: MouseEvent) => {
			event.stopPropagation();
			guarded(`could not open ${file.basename}`, () =>
				this.plugin.app.workspace.getLeaf(false).openFile(file)
			);
		};
	}
}
