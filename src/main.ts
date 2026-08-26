import {
	MarkdownRenderChild,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	debounce,
	normalizePath,
} from "obsidian";
import { DEFAULT_SETTINGS, PantrySettingTab } from "./settings";
import { SetupWizard } from "./ui/setup-wizard";
import { PLANNER_VIEW_TYPE, PlannerView } from "./view/planner-view";
import { COOK_VIEW_TYPE, CookView } from "./ui/cook-view";
import { CookStore, parseRecipeBody } from "./cook";
import { ProductIndex } from "./products";
import { NeedIndex } from "./needs";
import { GroceryList } from "./list";
import { ShopIndex } from "./shops";
import { SHELVES_VIEW_TYPE, ShelvesView } from "./ui/shelves-view";
import { PRODUCTS_VIEW_TYPE, ProductsView } from "./ui/products-view";
import { STOCK_VIEW_TYPE, StockView } from "./ui/stock-view";
import { SHOPPING_VIEW_TYPE, ShoppingView } from "./ui/shopping-view";
import { CLEANUP_VIEW_TYPE, CleanupView } from "./ui/cleanup-view";
import { CleanupIndex } from "./cleanup";
import { HOME_VIEW_TYPE, HomeView } from "./ui/home-view";
import { PlanStore } from "./plan";
import { ViewMemory } from "./ui/view-memory";
import { fromISODate, startOfWeek, toISODate } from "./date";
import { guarded } from "./guard";
import { PlannerGrid } from "./ui/planner";
import { RecipeIndex } from "./recipes";
import type { PantrySettings } from "./types";

/** Every screen that belongs to the plugin, so they can share one tab. */
const PANTRY_VIEW_TYPES = [
	HOME_VIEW_TYPE,
	PLANNER_VIEW_TYPE,
	STOCK_VIEW_TYPE,
	SHOPPING_VIEW_TYPE,
	SHELVES_VIEW_TYPE,
	CLEANUP_VIEW_TYPE,
	PRODUCTS_VIEW_TYPE,
];

export default class PantryPlugin extends Plugin {
	settings: PantrySettings = DEFAULT_SETTINGS;
	recipes: RecipeIndex = new RecipeIndex(this);
	plans: PlanStore = new PlanStore(this);
	cook: CookStore = new CookStore(this);
	products: ProductIndex = new ProductIndex(this);
	/** What this week's planned meals ask for, per product. */
	needs: NeedIndex = new NeedIndex(this);
	/** The grocery list, mirrored into a note in the vault. */
	list: GroceryList = new GroceryList(this);
	/** One note per shop, holding its shelves in walking order. */
	shops: ShopIndex = new ShopIndex(this);
	/** Where recipes and products still fail to meet. */
	cleanup: CleanupIndex = new CleanupIndex(this);
	/** Filter and scroll position per screen, so a detour does not lose your place. */
	ui: ViewMemory = new ViewMemory();
	/** Live planners inside notes, kept across code block rebuilds. */
	private embedded: Map<string, PlannerGrid> = new Map();

	/** Vault events can fire in bursts, so redraws are collapsed into one. */
	private scheduleRefresh = debounce(() => {
		// Skip the echo of our own write; the grid already shows that change.
		if (this.plans.recentlyWrote()) return;
		this.refreshViews();
		guarded("could not refresh your grocery list", () => this.list.refresh());
	}, 250, true);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(() => {
			this.products.build();
			guarded("could not read your shops", async () => {
				await this.shops.build();
				await this.list.refresh();
			});
		});

		this.registerView(
			PLANNER_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PlannerView(leaf, this)
		);

		this.registerView(
			COOK_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new CookView(leaf, this)
		);

		this.registerView(
			PRODUCTS_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ProductsView(leaf, this)
		);

		this.registerView(
			STOCK_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new StockView(leaf, this)
		);

		this.registerView(
			SHELVES_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ShelvesView(leaf, this)
		);

		this.registerView(
			SHOPPING_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ShoppingView(leaf, this)
		);

		this.registerView(
			CLEANUP_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new CleanupView(leaf, this)
		);

		this.registerView(
			HOME_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new HomeView(leaf, this)
		);

		// One door into the plugin; the screens behind it navigate to each other.
		this.addRibbonIcon("chef-hat", "Open Pantry", () => {
			guarded("could not open Pantry", () => this.activateHome());
		});

		// The only screen the palette offers. Everything else is reached from
		// the home screen, so there is one way in and one map of the plugin —
		// a half-remembered command name can no longer drop you into a screen
		// with no idea how you got there.
		this.addCommand({
			id: "open-pantry",
			name: "Open Pantry",
			callback: () => guarded("could not open Pantry", () => this.activateHome()),
		});

		this.addCommand({
			id: "run-setup",
			name: "Run setup",
			callback: () => this.runSetup(),
		});

		this.addCommand({
			id: "products-from-recipes",
			name: "Create products from recipes",
			callback: () =>
				guarded("could not add products from your recipes", () =>
					this.productsFromRecipes()
				),
		});

		this.addCommand({
			id: "cook-this-recipe",
			name: "Cook this recipe",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isRecipe(file)) return false;
				if (!checking) {
					guarded("could not open cook mode", () => this.openCook(file.path));
				}
				return true;
			},
		});

		// Same entry point from the file explorer and the note menu.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) || !this.isRecipe(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Cook this recipe")
						.setIcon("chef-hat")
						.onClick(() =>
							guarded("could not open cook mode", () => this.openCook(file.path))
						)
				);
			})
		);

		// The plan lives in a ```meal-plan block, which renders as the planner
		// itself so the note and the dedicated tab are the same thing.
		this.registerMarkdownCodeBlockProcessor("meal-plan", (source, el, ctx) => {
			const parsed = PlanStore.parse(source, new Date());
			const anchor =
				fromISODate(parsed.weekStart) ??
				startOfWeek(new Date(), this.settings.weekStartDay);

			const child = new MarkdownRenderChild(el);
			ctx.addChild(child);

			const key = `${ctx.sourcePath}::${toISODate(anchor)}`;
			const live = this.embedded.get(key);

			// Saving edits the note, which makes Live Preview tear this block
			// down and build it again. When the new source is exactly what the
			// planner just wrote, the old DOM is still correct — moving it over
			// avoids the flicker and the scroll shift a rebuild would cause.
			if (live && live.matches(source)) {
				live.attachTo(el);
				// Only let go if this host still owns it — the replacement block
				// may already have claimed the planner by the time we unload.
				child.register(() => {
					if (live.element().parentElement === el) live.detach();
				});
				return;
			}

			live?.destroy();

			const grid = new PlannerGrid(this, el.createDiv(), anchor, {
				embedded: true,
				// The block source is the plan, so the first paint needs no read.
				initialPlan: this.plans.normalise(parsed),
			});
			this.embedded.set(key, grid);
			child.register(() => {
				if (grid.element().parentElement === el) grid.detach();
			});
			guarded("could not draw the planner", () => grid.render());
		});

		this.addSettingTab(new PantrySettingTab(this.app, this));

		this.registerEvent(
			this.app.metadataCache.on("changed", (file: TFile) => {
				if (this.shops.isShopNote(file.path)) {
					guarded("could not read your shops", async () => {
						await this.shops.build();
						await this.list.refresh();
					});
					this.refreshViews();
					return;
				}
				if (this.list.isListNote(file.path)) {
					// Someone ticked a box in the note itself; skip our own echo.
					if (!this.list.recentlyWrote()) {
						guarded("could not read your grocery note", () =>
							this.list.syncFromNote()
						);
					}
					return;
				}
				this.scheduleRefresh();
			})
		);
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));

		// First run: walk the user through the handful of settings that matter.
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.setupComplete) this.runSetup();
		});
	}

	/**
	 * Opens a Pantry screen, reusing the tab a Pantry screen is already in. The
	 * five screens replace each other, so the plugin behaves like one app
	 * rather than a drawer full of tabs.
	 */
	private async activate(type: string): Promise<void> {
		const open = this.app.workspace.getLeavesOfType(type);
		if (open[0]) {
			await this.app.workspace.revealLeaf(open[0]);
			return;
		}

		const sibling = PANTRY_VIEW_TYPES.flatMap((other) =>
			this.app.workspace.getLeavesOfType(other)
		)[0];
		const leaf = sibling ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async activateHome(): Promise<void> {
		await this.activate(HOME_VIEW_TYPE);
	}

	async activateProducts(): Promise<void> {
		await this.activate(PRODUCTS_VIEW_TYPE);
	}

	async activateStock(): Promise<void> {
		await this.activate(STOCK_VIEW_TYPE);
	}

	async activateShelves(): Promise<void> {
		await this.shops.build();
		await this.activate(SHELVES_VIEW_TYPE);
	}

	/** Shelf order comes from the shop note; unknown shelves fall to the back. */
	compareShelves(shop: string, a: string, b: string): number {
		if (a === b) return 0;
		if (a === "Other") return 1;
		if (b === "Other") return -1;
		const left = this.shops.order(shop, a);
		const right = this.shops.order(shop, b);
		if (left !== right) return left - right;
		return a.localeCompare(b);
	}

	async activateCleanup(): Promise<void> {
		await this.activate(CLEANUP_VIEW_TYPE);
	}

	async activateShopping(): Promise<void> {
		await this.activate(SHOPPING_VIEW_TYPE);
	}

	/**
	 * Fills the base list from what the recipes already mention. Typing sixty
	 * product notes by hand is the fastest way to never start.
	 */
	async productsFromRecipes(): Promise<void> {
		this.products.build();

		const bodies: string[][] = [];
		for (const recipe of this.recipes.all()) {
			const file = this.app.vault.getFileByPath(recipe.path);
			if (!file) continue;
			const content = await this.app.vault.cachedRead(file);
			bodies.push(parseRecipeBody(content).ingredients);
		}

		const missing = this.products.unknownFromRecipes(bodies);
		if (missing.length === 0) {
			new Notice("Every ingredient in your recipes already has a product.");
			return;
		}

		for (const name of missing) {
			await this.products.create(name);
		}

		this.products.build();
		this.refreshViews();
		new Notice(
			`Added ${missing.length} product${missing.length === 1 ? "" : "s"}. Set their minimums in Products.`
		);
	}

	/** A note counts as a recipe when it lives in the configured recipe folder. */
	isRecipe(file: TFile): boolean {
		if (file.extension !== "md") return false;
		const folder = normalizePath(this.settings.recipeFolder || "Recipes");
		return file.path.startsWith(`${folder}/`);
	}

	/**
	 * Opens the cook view for a recipe. Servings come from the plan when the
	 * caller knows them, and otherwise default to the household.
	 */
	async openCook(nameOrPath: string, servings?: number): Promise<void> {
		const file = this.cook.file(nameOrPath);
		if (!file) {
			new Notice("That recipe could not be found.");
			return;
		}

		const stored = this.cook.session(file.path).servings;
		const wanted = servings ?? stored ?? this.cook.householdServings();

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: COOK_VIEW_TYPE,
			active: true,
			state: { path: file.path, servings: wanted },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	onunload(): void {
		this.embedded.forEach((grid) => grid.destroy());
		this.embedded.clear();
	}

	async activatePlanner(): Promise<void> {
		await this.activate(PLANNER_VIEW_TYPE);
	}

	runSetup(): void {
		new SetupWizard(this).open();
	}

	/**
	 * Redraws the screens that show stock figures. The planner is left out on
	 * purpose: it is usually the screen you are standing on when a meal tick
	 * changes stock, and rebuilding it would throw your scroll position away.
	 */
	refreshStockViews(): void {
		this.app.workspace.getLeavesOfType(STOCK_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof StockView) view.refresh();
		});

		this.app.workspace.getLeavesOfType(SHOPPING_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof ShoppingView) view.refresh();
		});

		this.app.workspace.getLeavesOfType(PRODUCTS_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof ProductsView) view.refresh();
		});

		this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof HomeView) view.refresh();
		});
	}

	/** Called after settings change so open planners pick the change up at once. */
	refreshViews(): void {
		this.app.workspace
			.getLeavesOfType(PLANNER_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof PlannerView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(PRODUCTS_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof ProductsView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(STOCK_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof StockView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(SHOPPING_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof ShoppingView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(SHELVES_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof ShelvesView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(CLEANUP_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof CleanupView) view.refresh();
			});

		this.app.workspace
			.getLeavesOfType(HOME_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof HomeView) view.refresh();
			});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
