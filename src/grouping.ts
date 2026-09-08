import type PantryPlugin from "./main";
import type { Product } from "./products";
import type { Extra } from "./extras";

export const NO_SHOP = "Anywhere";
export const NO_CATEGORY = "Other";

/** Eén winkel met haar schappen, in de volgorde waarin je erlangs loopt. */
export interface ShopGroup {
	shop: string;
	items: Product[];
	/**
	 * Losse boodschappen voor deze winkel — dingen die geen product zijn.
	 * Ze lopen mee in dezelfde schappen als de producten, want in de winkel
	 * is een pak batterijen net zo goed iets dat op een schap ligt.
	 */
	extras: Extra[];
	shelves: { shelf: string; items: Product[]; extras: Extra[] }[];
}

/**
 * Eén emmer per winkel of per schap: de naam zoals hij getoond wordt, en wat
 * erin ligt. Gesleuteld op kleine letters, want "Koeling" en "koeling" zijn
 * hetzelfde schap — en twee kopjes voor één schap is precies het soort ruis
 * waar je met een kar in je hand overheen leest.
 */
interface Bucket {
	name: string;
	items: Product[];
	extras: Extra[];
}

function bucketOf(map: Map<string, Bucket>, name: string): Bucket {
	const key = name.toLowerCase();
	const found = map.get(key);
	if (found) return found;
	const fresh: Bucket = { name, items: [], extras: [] };
	map.set(key, fresh);
	return fresh;
}

/**
 * De boodschappenlijst gegroepeerd per winkel en per schap.
 *
 * De notitie en het boodschappenscherm bouwden dit allebei zelf op — dezelfde
 * winkelgroepering, dezelfde schapbuckets, dezelfde sortering, twee keer
 * uitgeschreven. Wat er in de notitie stond en wat je op je telefoon zag kon
 * daardoor uit elkaar lopen zonder dat iemand er iets aan veranderd had.
 *
 * `shopOf` zegt in welke winkel een product deze keer ligt; `order` zet de
 * winkels op volgorde. Allebei van de lijst, want die weet waar je heen gaat.
 */
export function groupForShopping(
	plugin: PantryPlugin,
	items: Product[],
	extras: readonly Extra[],
	shopOf: (product: Product) => string,
	order: readonly string[]
): ShopGroup[] {
	const byShop = new Map<string, Bucket>();

	for (const product of items) {
		bucketOf(byShop, shopOf(product) || NO_SHOP).items.push(product);
	}

	// Een losse boodschap ligt waar jij zegt dat hij ligt, en anders nergens.
	for (const extra of extras) {
		bucketOf(byShop, extra.shop.trim() || NO_SHOP).extras.push(extra);
	}

	// De winkels van de lijst in hun eigen volgorde; wat daarbuiten valt erna,
	// en zonder winkel als restcategorie helemaal achteraan.
	const rank = (shop: string): number => {
		if (shop === NO_SHOP) return Number.MAX_SAFE_INTEGER;
		const at = order.findIndex(
			(known) => known.trim().toLowerCase() === shop.trim().toLowerCase()
		);
		return at === -1 ? order.length : at;
	};

	return [...byShop.values()]
		.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
		.map((shop) => {
			const byShelf = new Map<string, Bucket>();
			for (const product of shop.items) {
				bucketOf(byShelf, product.shelf || NO_CATEGORY).items.push(product);
			}
			for (const extra of shop.extras) {
				bucketOf(byShelf, extra.shelf.trim() || NO_CATEGORY).extras.push(extra);
			}

			const shelves = [...byShelf.values()]
				.sort((a, b) => plugin.compareShelves(shop.name, a.name, b.name))
				.map((shelf) => ({
					shelf: shelf.name,
					items: [...shelf.items].sort((a, b) => a.name.localeCompare(b.name)),
					extras: [...shelf.extras].sort((a, b) => a.name.localeCompare(b.name)),
				}));

			return { shop: shop.name, items: shop.items, extras: shop.extras, shelves };
		});
}
