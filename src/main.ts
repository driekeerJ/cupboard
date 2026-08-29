import {
	MarkdownRenderChild,
	Menu,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	debounce,
	normalizePath,
} from "obsidian";
import { DEFAULT_SETTINGS, PantrySettingTab, normaliseSettings } from "./settings";
import { SetupWizard } from "./ui/setup-wizard";
import { PLANNER_VIEW_TYPE, PlannerView } from "./view/planner-view";
import { COOK_VIEW_TYPE, CookView } from "./ui/cook-view";
import { CookStore, parseRecipeBody } from "./cook";
import { ProductIndex } from "./products";
import { NeedIndex } from "./needs";
import { GroceryList } from "./list";
import { HouseholdIndex } from "./people";
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
import { EatersPopover } from "./ui/eaters-popover";
import { PlannerGrid } from "./ui/planner";
import { RecipeIndex } from "./recipes";
import type { PantrySettings } from "./types";

/**
 * Elk scherm van de plugin, op één plek.
 *
 * Deze tabel voedt vier dingen die eerder los van elkaar werden bijgehouden:
 * welke tabbladen bij Pantry horen, welke `registerView` er is, welk commando
 * het palet aanbiedt, en welke schermen na een wijziging opnieuw getekend
 * worden. Die laatste twee waren allebei met de hand bijgehouden lijsten en
 * allebei al uit de pas: `refreshStockViews` miste Cleanup, en zes schermen
 * hadden geen commando.
 *
 * Een scherm toevoegen is nu één regel hier, plus zijn tegel in `home-view.ts`
 * en de `.view-content`-selector boven in `styles.css`.
 */
const SCREENS: { type: string; command: string; name: string }[] = [
	{ type: HOME_VIEW_TYPE, command: "open-home", name: "Open home" },
	{ type: PLANNER_VIEW_TYPE, command: "open-planner", name: "Open meal planner" },
	{ type: STOCK_VIEW_TYPE, command: "open-stock", name: "Open stock" },
	{ type: SHOPPING_VIEW_TYPE, command: "open-groceries", name: "Open groceries" },
	{ type: SHELVES_VIEW_TYPE, command: "open-shelves", name: "Open shop shelves" },
	{ type: CLEANUP_VIEW_TYPE, command: "open-cleanup", name: "Open cleanup" },
	{ type: PRODUCTS_VIEW_TYPE, command: "open-products", name: "Open products" },
];

const PANTRY_VIEW_TYPES = SCREENS.map((screen) => screen.type);

/** Een scherm dat zichzelf opnieuw kan tekenen. */
interface Refreshable {
	refresh(): void;
}

function isRefreshable(view: unknown): view is Refreshable {
	return typeof (view as Refreshable | undefined)?.refresh === "function";
}

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
	/** Wie er meeëet: notities zodra je een map instelt, anders `data.json`. */
	people: HouseholdIndex = new HouseholdIndex(this);
	/** Where recipes and products still fail to meet. */
	cleanup: CleanupIndex = new CleanupIndex(this);
	/** Filter and scroll position per screen, so a detour does not lose your place. */
	ui: ViewMemory = new ViewMemory();
	/** Live planners inside notes, kept across code block rebuilds. */
	private embedded: Map<string, PlannerGrid> = new Map();

	/**
	 * Het enige pad waarlangs een wijziging in de vault het scherm bereikt.
	 *
	 * Eerder deed elk scherm dit ook zelf, met een eigen `changed`-listener die
	 * `products.build()` aanriep — vier keer bijna letterlijk hetzelfde blok.
	 * Op één productwijziging liepen er vijf paden tegelijk, en juist het pad
	 * dat er níét was deed de schade: een **verwijderde** notitie geeft geen
	 * `changed`, dus die rij bleef staan met een dood `TFile` eronder, en de
	 * tik erop schreef in het niets.
	 *
	 * Daarom staat `products.build()` hier: dit pad vangt ook verwijderen en
	 * hernoemen. Vault events komen in vlagen, dus alles wordt tot één ronde
	 * samengetrokken.
	 */
	private scheduleRefresh = debounce(() => {
		const planner = this.plannerDirty;
		this.plannerDirty = false;

		this.products.build();
		this.people.build();
		// De planner alleen als er iets veranderd is wat hij toont. `render()`
		// laadt de hele week opnieuw en gooit je scrollpositie weg, en dit pad
		// loopt bij élke metadata-wijziging, create, delete of rename — precies
		// wat het commentaar bij refreshStockViews zegt te willen vermijden.
		this.refreshViews(...(planner ? [] : [PLANNER_VIEW_TYPE]));
		guarded("could not refresh your grocery list", () => this.list.refresh());
	}, 250, true);

	/** Of er sinds de vorige ronde iets veranderde dat de planner toont. */
	private plannerDirty = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(() => {
			this.products.build();
			this.people.build();
			guarded("could not read your shops", async () => {
				await this.shops.build();
				// De lopende boodschappenronde vóór de lijst: anders schrijft
				// refresh() een lijst zonder mandje, en ben je kwijt wat er al
				// in het karretje ligt.
				await this.list.loadState();
				await this.list.refresh();
			});
			// Kooksessies zijn bedoeld om te verlopen: één keer koken, één
			// notitie. Zonder opruimen groeit die map ongemerkt door.
			guarded("could not tidy up old cooking sessions", () =>
				this.cook.sweep()
			);
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

		// Elk scherm heeft een commando.
		//
		// Eerst bood het palet alleen de voordeur, zodat een half onthouden
		// commandonaam je niet ergens kon droppen zonder dat je wist hoe je er
		// kwam. Die zorg is intussen opgelost — elk scherm heeft een titel, een
		// icoon en een terugknop — maar de prijs bleef staan: zes schermen
		// konden geen sneltoets krijgen, stonden niet op de mobiele werkbalk,
		// en waren onbereikbaar voor Commander, QuickAdd en Templater. Het
		// palet dat alles bereikt is in Obsidian geen stijlvoorkeur maar het
		// contract waar elk ander automatiseringsoppervlak op leunt.
		for (const screen of SCREENS) {
			this.addCommand({
				id: screen.command,
				name: screen.name,
				callback: () =>
					guarded(`could not open ${screen.name}`, () => this.activate(screen.type)),
			});
		}

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

		this.addCommand({
			id: "continue-cooking",
			name: "Continue this cooking session",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isCookSession(file)) return false;
				if (!checking) {
					guarded("could not open cook mode", () => this.resumeCook(file.path));
				}
				return true;
			},
		});

		// Same entry point from the file explorer and the note menu.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && this.isCookSession(file)) {
					menu.addItem((item) =>
						item
							.setTitle("Continue cooking")
							.setIcon("chef-hat")
							.onClick(() =>
								guarded("could not open cook mode", () =>
									this.resumeCook(file.path)
								)
							)
					);
					return;
				}
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

		// Het statebestand is JSON, geen notitie, dus het komt niet langs de
		// metadata-cache. Zo pikt de telefoon op wat de laptop in de winkel deed.
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (!(file instanceof TFile) || !this.list.isStateFile(file.path)) return;
				guarded("could not read your shopping round", async () => {
					const content = await this.app.vault.cachedRead(file);
					if (this.list.wroteStateExactly(content)) return;
					await this.list.loadState();
					this.refreshStockViews();
				});
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file: TFile, data: string) => {
				if (this.shops.isShopNote(file.path)) {
					// Hertekenen ná de herbouw, niet ernaast: anders lezen de
					// schermen de winkels zoals ze vóór de wijziging waren.
					guarded("could not read your shops", async () => {
						await this.shops.build();
						await this.list.refresh();
						this.refreshViews();
					});
					return;
				}
				if (this.list.isListNote(file.path)) {
					// Someone ticked a box in the note itself; skip our own echo.
					if (!this.list.wroteExactly(data)) {
						guarded("could not read your grocery note", () =>
							this.list.syncFromNote()
						);
					}
					return;
				}
				// De echo van onze eigen planwijziging overslaan — het raster
				// toont die al. Op inhoud en niet op tijd: een tijdvenster gooit
				// een wijziging weg die sync er net binnen doorheen duwt, en
				// dekt tegelijk de vertraagde flush van de editor niet.
				if (this.plans.isPlanNote(file.path) && this.plans.wroteExactly(data)) {
					return;
				}
				if (this.plans.isPlanNote(file.path) || this.isRecipe(file)) {
					this.plannerDirty = true;
				}
				this.scheduleRefresh();
			})
		);
		// Aanmaken, verwijderen en hernoemen geven geen `changed`, dus dit is het
		// enige pad waarlangs die de schermen bereiken. Een recept of weeknotitie
		// die verdwijnt of van naam verandert gaat de planner wél aan.
		const touched = (file: TAbstractFile): void => {
			if (file instanceof TFile && (this.plans.isPlanNote(file.path) || this.isRecipe(file))) {
				this.plannerDirty = true;
			}
			this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on("create", touched));
		this.registerEvent(this.app.vault.on("delete", touched));
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				// Obsidian werkt links in code blocks niet bij, en het weekplan
				// verwijst naar recepten binnen een ```meal-plan-fence. Zonder
				// dit vond `cook.file()` het recept daarna niet meer en stopte
				// de maaltijd stilletjes met meetellen voor de lijst.
				if (file instanceof TFile && this.shops.isShopNote(file.path)) {
					const was = oldPath.slice(oldPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
					guarded("could not update your products", async () => {
						await this.shops.build();
						const changed = await this.products.renameShop(was, file.basename);
						if (changed > 0) {
							new Notice(
								`Pantry moved ${changed} product${changed === 1 ? "" : "s"} to ${file.basename}.`
							);
						}
					});
				}
				// Een huisgenoot staat op naam in de weekplannen, en die naam is
				// de bestandsnaam. Zonder dit viel iemand na een hernoeming uit
				// alle geplande maaltijden — stilletjes, want een onbekende
				// eter telt gewoon niet mee.
				if (file instanceof TFile && this.people.isMemberNote(file.path)) {
					const was = oldPath.slice(oldPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
					guarded("could not update your meal plans", async () => {
						this.people.build();
						const notes = await this.plans.renameEverywhere(
							"eater",
							was,
							file.basename
						);
						if (notes > 0) {
							new Notice(
								`Pantry renamed "${was}" in ${notes} meal plan${notes === 1 ? "" : "s"}.`
							);
						}
					});
				}
				if (file instanceof TFile && oldPath in this.settings.cookTimers) {
					guarded("could not move your cooking timers", () =>
						this.cook.renameSession(oldPath, file.path)
					);
				}
				if (file instanceof TFile && this.isRecipe(file)) {
					const was = oldPath.slice(oldPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
					guarded("could not update your meal plans", async () => {
						const notes = await this.plans.renameRecipe(was, file.basename);
						if (notes > 0) {
							new Notice(
								`Pantry updated ${notes} meal plan${notes === 1 ? "" : "s"}.`
							);
						}
					});
				}
				touched(file);
			})
		);

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
	/**
	 * Brings a screen up, reusing the tab it is already in.
	 *
	 * Op de telefoon deelt de hele plugin één tabblad: daar is een tweede
	 * Pantry-scherm naast het eerste geen ruimte maar verlies, dus wordt een
	 * bestaand Pantry-tabblad omgezet. Buiten de telefoon kostte diezelfde
	 * regel meer dan hij opleverde — klikken op het ribbon-icoon terwijl je op
	 * Voorraad stond maakte van jouw Voorraad-tab een Home-tab, twee schermen
	 * naast elkaar kon niet, en een vastgezet tabblad werd toch weggenavigeerd.
	 */
	private async activate(type: string): Promise<void> {
		const open = this.app.workspace.getLeavesOfType(type);
		if (open[0]) {
			await this.app.workspace.revealLeaf(open[0]);
			return;
		}

		const sibling = Platform.isPhone
			? PANTRY_VIEW_TYPES.flatMap((other) =>
					this.app.workspace.getLeavesOfType(other)
				)[0]
			: undefined;

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
	/** Een notitie in de kooksessie-map, herkend aan zijn plek. */
	isCookSession(file: TFile): boolean {
		if (file.extension !== "md") return false;
		const folder = normalizePath(this.settings.cookFolder || "Cook sessions");
		return file.path.startsWith(`${folder}/`);
	}

	/** Zet de kookmodus terug op een sessie die al bestaat. */
	async resumeCook(path: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: COOK_VIEW_TYPE,
			active: true,
			state: { path },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

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

		// Koken doe je een keer, voor dit aantal mensen. Die keer krijgt zijn
		// eigen notitie; de kookmodus staat daarop en niet op het recept.
		const wanted = servings ?? this.cook.householdServings();
		const session = await this.cook.openSession(file, wanted);
		if (!session) {
			new Notice("Could not start a cooking session for that recipe.");
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: COOK_VIEW_TYPE,
			active: true,
			state: { path: session.path },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	onunload(): void {
		this.embedded.forEach((grid) => grid.destroy());
		this.embedded.clear();
		// Paneel en achtergrond hangen aan document.body, buiten elke Component:
		// zonder dit blijven ze staan als de plugin wordt uitgezet.
		EatersPopover.closeAny();
		this.scheduleRefresh.cancel();
		// Een ronde die nog in de debounce hing hoort niet verloren te gaan
		// omdat je de plugin uitzet terwijl je in de winkel staat.
		guarded("could not save your shopping round", () => this.list.flushState());
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
		this.refreshViews(PLANNER_VIEW_TYPE);
	}

	/** Called after settings change so open planners pick the change up at once. */
	/**
	 * Redraws every open Pantry screen.
	 *
	 * Eén lus over de schermtabel, in plaats van zeven keer hetzelfde blok met
	 * een `instanceof` per view. Dat handmatige lijstje liep al achter: Cook
	 * stond er niet in, en `refreshStockViews` miste Cleanup.
	 */
	refreshViews(...except: string[]): void {
		for (const type of PANTRY_VIEW_TYPES) {
			if (except.includes(type)) continue;
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				if (isRefreshable(leaf.view)) leaf.view.refresh();
			}
		}
	}

	async loadSettings(): Promise<void> {
		// Gevalideerd, niet samengevoegd: zie normaliseSettings.
		this.settings = normaliseSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
