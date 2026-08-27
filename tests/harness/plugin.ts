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
import { GroceryList } from "../../src/list";
import type PantryPlugin from "../../src/main";
import { NeedIndex } from "../../src/needs";
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
	/** De boodschappennotitie zoals hij nu op schijf staat. */
	groceries(): string;
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
	plugin.list = new GroceryList(plugin);
	plugin.plans = new PlanStore(plugin);
	plugin.cook = new CookStore(plugin);
	plugin.shops = new ShopIndex(plugin);
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
			await plugin.shops.build();
			await plugin.needs.rebuild(weekStart);
		},
		groceries(): string {
			return vault.read(plugin.list.path());
		},
	};
}
