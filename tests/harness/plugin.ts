/**
 * Zet een complete Pantry neer op een neppe vault.
 *
 * De indexen zijn de **echte** klassen uit `src/`. Alleen `PantryPlugin` zelf
 * is nagemaakt, want die erft van Obsidians `Plugin` en dat is precies het
 * stuk dat niets met de rekenkern te maken heeft. Wat de kern van de plugin
 * vraagt is een handvol velden: `app`, `settings`, en de indexen die elkaar
 * aanroepen.
 */
import { CleanupIndex } from "../../src/cleanup";
import { CookStore } from "../../src/cook";
import { ShoppingLists } from "../../src/shopping-lists";
import type { ListDraft, MealRef, ShoppingList } from "../../src/shopping-list";
import { linkTarget } from "../../src/links";
import { toISODate } from "../../src/date";
import { dedupe } from "../../src/text";
import type PantryPlugin from "../../src/main";
import { NeedIndex } from "../../src/needs";
import { HouseholdIndex } from "../../src/people";
import { RecipeIndex } from "../../src/recipes";
import { PlanStore } from "../../src/plan";
import { ProductIndex } from "../../src/products";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { ShopIndex } from "../../src/shops";
import type { PantrySettings } from "../../src/types";
import { FakeVault } from "./vault";

export interface Harness {
	vault: FakeVault;
	plugin: PantryPlugin;
	/** Leest de index opnieuw uit de vault, zoals de plugin na een wijziging doet. */
	rebuild(weekStart: Date): Promise<void>;
	/**
	 * Een boodschappenlijst voor deze week: gedateerd op `weekStart`, met alle
	 * nog niet gegeten maaltijden van die week en — tenzij anders gezegd — alle
	 * winkels. Dat is de lijst die het oude "hele weekplan"-gedrag nabootst.
	 */
	list(weekStart: Date, options?: Partial<ListDraft>): Promise<ShoppingList>;
	/** De notitie van een lijst zoals hij nu op schijf staat. */
	note(list: ShoppingList): string;
}

export function makeHarness(
	files: Record<string, string>,
	settings: Partial<PantrySettings> = {}
): Harness {
	const vault = new FakeVault(files);

	// Eerst een leeg omhulsel: de indexen krijgen de plugin in hun constructor
	// mee, dus het object moet bestaan voordat ze gemaakt kunnen worden.
	const plugin = {
		app: vault,
		settings: { ...DEFAULT_SETTINGS, ...settings, cook: {} },
		saveSettings: () => Promise.resolve(),
	} as unknown as PantryPlugin;

	plugin.products = new ProductIndex(plugin);
	plugin.needs = new NeedIndex(plugin);
	plugin.lists = new ShoppingLists(plugin);
	plugin.plans = new PlanStore(plugin);
	plugin.cook = new CookStore(plugin);
	plugin.shops = new ShopIndex(plugin);
	plugin.people = new HouseholdIndex(plugin);
	plugin.recipes = new RecipeIndex(plugin);
	plugin.cleanup = new CleanupIndex(plugin);

	// De echte implementatie staat in main.ts, dat de hele UI meesleept.
	// Dit is dezelfde regel: onbekende schappen achteraan, "Other" helemaal.
	plugin.compareShelves = (shop: string, a: string, b: string): number => {
		if (a === b) return 0;
		if (a === "Other") return 1;
		if (b === "Other") return -1;
		const left = plugin.shops.order(shop, a);
		const right = plugin.shops.order(shop, b);
		if (left !== right) return left - right;
		return a.localeCompare(b);
	};

	return {
		vault,
		plugin,
		async rebuild(weekStart: Date): Promise<void> {
			plugin.products.build();
			plugin.people.build();
			await plugin.shops.build();
			await plugin.needs.rebuild(weekStart);
		},
		async list(weekStart: Date, options: Partial<ListDraft> = {}): Promise<ShoppingList> {
			const plan = await plugin.plans.load(weekStart);
			const meals: MealRef[] = [];
			for (const day of plan.days) {
				for (const meal of day.meals) {
					for (const entry of meal.recipes) {
						if (entry.status) continue;
						meals.push({ date: day.date, meal: meal.meal, recipe: linkTarget(entry.recipe) });
					}
				}
			}
			const shops = dedupe([...plugin.shops.names(), ...plugin.products.values("shop")]);
			const created = await plugin.lists.create({
				date: toISODate(weekStart),
				arrival: null,
				shops,
				meals,
				...options,
			});
			if (!created) throw new Error("the list was not created");
			return created;
		},
		note(list: ShoppingList): string {
			return vault.read(list.path);
		},
	};
}
