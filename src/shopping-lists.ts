import { TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type PantryPlugin from "./main";
import { markdownIn } from "./folder";
import { NeedIndex } from "./needs";
import {
	clearWarning,
	ensureFolder,
	hasRegion,
	replaceRegion,
	warnOnce,
} from "./notes";
import { toBuy, type Product } from "./products";
import { DEFAULT_EXTRA_AMOUNT, extraLabel, newExtraId, type Extra } from "./extras";
import { groupForShopping, NO_SHOP } from "./grouping";
import { fromISODate, startOfWeek } from "./date";
import { setShopping, shoppingAt } from "./plan";
import type { ShoppingStop } from "./types";
import {
	LIST_REGION,
	hasShop,
	isValidDraft,
	listLabel,
	listPath,
	mealKey,
	parseList,
	sameName,
	serialiseList,
	type Arrival,
	type BasketEntry,
	type ListDraft,
	type MealRef,
	type ShoppingList,
} from "./shopping-list";

/** Waar de lijsten staan als er niets is ingesteld. */
export const DEFAULT_SHOPPING_FOLDER = "Pantry/Shopping";

const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";
const ELSEWHERE_HEADING = "## On another list";
const NOT_HERE_HEADING = "## Not at these shops";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;
/** Elk vinkvakje, ook zonder wikilink: zo staan losse boodschappen erin. */
const ANY_TICK = /^\s*-\s\[([ xX])\]\s*(.+?)\s*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const SIGNATURE =
	"*Kept up to date by Pantry. Tick a box and that product counts as full again.*";

/** De sleutels die de plugin zelf beheert in de frontmatter van een lijst. */
const OWN_KEYS = ["pantry", "date", "arrives", "shops", "meals", "basket", "nudge", "extras"];

/** Wat een lijst deze keer te zeggen heeft over elk product. */
export interface ListBuckets {
	/** Kopen, in deze winkels. */
	buy: Product[];
	/** Kan nog niet gezegd worden: nooit geteld, of bewust "even kijken". */
	unsure: Product[];
	/** Staat al op een eerdere lijst die nog niet gedaan is. */
	elsewhere: { product: Product; list: ShoppingList }[];
	/** Een gekozen maaltijd vraagt erom, maar het ligt niet in deze winkels. */
	notHere: Product[];
}

/** Minstens één, altijd heel: een halve zak batterijen bestaat niet. */
function cleanAmount(value: number): number {
	const amount = Math.round(Number(value));
	return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_EXTRA_AMOUNT;
}

/** Eerder is eerder: op datum, en bij dezelfde dag op pad — vast en voorspelbaar. */
function precedes(a: ShoppingList, b: ShoppingList): boolean {
	if (a.date !== b.date) return a.date < b.date;
	return a.path < b.path;
}

/**
 * Alle boodschappenlijsten, en alles wat ze uitrekenen.
 *
 * Elke lijst is een notitie in de lijstmap; dit is de index erop plus de
 * rekenkern: per lijst een eigen `NeedIndex` (alleen háár maaltijden, alleen
 * háár winkels), het mandje, de ± aanpassingen en de losse boodschappen. De
 * productnotities blijven de waarheid over de voorraad; een lijst zegt alleen
 * wat je déze keer haalt.
 */
export class ShoppingLists {
	private plugin: PantryPlugin;
	private lists: Map<string, ShoppingList> = new Map();
	private needs: Map<string, NeedIndex> = new Map();
	/** De inhoud van onze laatste schrijfactie per notitie, om de echo te herkennen. */
	private lastWritten: Map<string, string> = new Map();

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	folder(): string {
		return normalizePath(this.plugin.settings.shoppingFolder || DEFAULT_SHOPPING_FOLDER);
	}

	isListNote(path: string): boolean {
		return normalizePath(path).startsWith(`${this.folder()}/`) && path.endsWith(".md");
	}

	/** Op datum, de eerste boodschappen bovenaan. */
	all(): ShoppingList[] {
		return [...this.lists.values()].sort((a, b) => (precedes(a, b) ? -1 : 1));
	}

	byPath(path: string): ShoppingList | null {
		return this.lists.get(normalizePath(path)) ?? null;
	}

	label(list: ShoppingList): string {
		return listLabel(list);
	}

	/** Is dit precies wat wij net in deze notitie schreven? */
	wroteExactly(path: string, content: string): boolean {
		return this.lastWritten.get(normalizePath(path)) === content;
	}

	/**
	 * Leest de lijstmap. Een notitie die we zelf net schreven wordt niet
	 * teruggelezen — de metadata-cache loopt achter op onze eigen schrijfactie
	 * en zou ons een oudere lijst teruggeven dan we net hebben neergezet.
	 */
	async build(): Promise<void> {
		const seen = new Set<string>();
		for (const file of markdownIn(this.plugin.app.vault, this.folder())) {
			const path = file.path;
			seen.add(path);
			const content = await this.plugin.app.vault.cachedRead(file);
			if (this.lists.has(path) && this.wroteExactly(path, content)) continue;
			const list = this.read(path, content);
			if (list) this.lists.set(path, list);
			else this.forget(path);
		}
		for (const path of [...this.lists.keys()]) {
			if (!seen.has(path)) this.forget(path);
		}
	}

	private forget(path: string): void {
		this.lists.delete(path);
		this.needs.delete(path);
		this.lastWritten.delete(path);
	}

	/** Een lijst uit de tekst van haar notitie, of null als het geen lijst is. */
	private read(path: string, content: string): ShoppingList | null {
		const parsed = parseList(this.frontmatterOf(content));
		if (!parsed) return null;

		const list: ShoppingList = {
			path,
			...parsed.draft,
			basket: new Map(),
			nudge: new Map(),
			extras: parsed.extras,
		};
		for (const { name, entry } of parsed.basket) {
			const product = this.resolve(name, path);
			if (product) list.basket.set(product.path, entry);
		}
		for (const { name, step } of parsed.nudge) {
			const product = this.resolve(name, path);
			if (product) list.nudge.set(product.path, step);
		}
		return list;
	}

	private frontmatterOf(content: string): Record<string, unknown> {
		const match = FRONTMATTER.exec(content);
		if (!match) return {};
		try {
			const raw: unknown = parseYaml(match[1] ?? "");
			return raw && typeof raw === "object" && !Array.isArray(raw)
				? (raw as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	private resolve(linkText: string, from: string): Product | null {
		const target = this.plugin.app.metadataCache.getFirstLinkpathDest(linkText, from);
		if (target) return this.plugin.products.byPath(target.path);
		return this.plugin.products.match(linkText);
	}

	// -------------------------------------------------------------- rekenen

	needsOf(list: ShoppingList): NeedIndex {
		let index = this.needs.get(list.path);
		if (!index) {
			index = new NeedIndex(this.plugin);
			this.needs.set(list.path, index);
		}
		return index;
	}

	/** Herleest de map, rekent elke lijst door en schrijft elke notitie bij. */
	async refreshAll(): Promise<void> {
		await this.build();
		for (const list of this.lists.values()) await this.needsOf(list).rebuildFor(list);
		for (const list of this.lists.values()) await this.write(list);
	}

	/** Eén lijst doorrekenen en bijschrijven. */
	async refresh(list: ShoppingList): Promise<void> {
		await this.needsOf(list).rebuildFor(list);
		await this.write(list);
	}

	/**
	 * Ligt dit product in een winkel van deze lijst? Zonder winkels op de
	 * lijst, of zonder winkel bij het product, is het antwoord ja: dan is er
	 * niets om het tegen te houden.
	 */
	atShops(list: ShoppingList, product: Product): boolean {
		if (list.shops.length === 0 || product.shops.length === 0) return true;
		return product.shops.some((shop) => hasShop(list.shops, shop));
	}

	/**
	 * In welke winkel van deze lijst dit product ligt: de eerste voorkeur van
	 * het product die op de lijst staat. Zonder winkels op de lijst wint de
	 * eerste voorkeur; zonder winkel bij het product blijft het leeg.
	 */
	shopFor(list: ShoppingList, product: Product): string {
		const preferred = product.shops.map((shop) => shop.trim()).filter(Boolean);
		if (list.shops.length === 0) return preferred[0] ?? "";
		for (const shop of preferred) {
			const known = list.shops.find((candidate) => sameName(candidate, shop));
			if (known) return known;
		}
		return "";
	}

	minimumOf(list: ShoppingList, product: Product): number {
		return this.needsOf(list).minimumOf(product);
	}

	/** Wat de lijst van dit product vraagt: het minimum plus de maaltijden. */
	need(list: ShoppingList, product: Product): number {
		return this.minimumOf(list, product) + this.needsOf(list).get(product);
	}

	/** Hoeveel je hiervan koopt, met de ± aanpassing van deze lijst erbij. */
	amount(list: ShoppingList, product: Product): number | null {
		const base = toBuy(product, this.needsOf(list).get(product), this.minimumOf(list, product));
		if (base === null) return null;
		return Math.max(0, base + (list.nudge.get(product.path) ?? 0));
	}

	/**
	 * Hoort dit product in de voorraadcheck van deze lijst? Alles wat de lijst
	 * vraagt en in haar winkels ligt, plus wat je zelf hebt gemarkeerd om even
	 * te kijken — maar ook dat alleen als het hier te koop is.
	 */
	relevant(list: ShoppingList, product: Product): boolean {
		if (product.ignored || !this.atShops(list, product)) return false;
		return product.check || this.need(list, product) > 0;
	}

	/** De lijst die dit product al op zich heeft genomen, als die eerder valt. */
	ownerOf(list: ShoppingList, product: Product): ShoppingList | null {
		for (const other of this.all()) {
			if (other.path === list.path || !precedes(other, list)) continue;
			if (this.claims(other, product)) return other;
		}
		return null;
	}

	/** Staat het op die lijst om te kopen of te checken, en is het daar nog niet afgevinkt? */
	private claims(list: ShoppingList, product: Product): boolean {
		if (product.ignored || list.basket.has(product.path)) return false;
		if (!this.atShops(list, product)) return false;
		const amount = this.amount(list, product);
		if (amount === null) return this.need(list, product) > 0;
		return amount > 0;
	}

	/** Dezelfde verdeling voor het scherm en de notitie, zodat die nooit verschillen. */
	buckets(list: ShoppingList): ListBuckets {
		const out: ListBuckets = { buy: [], unsure: [], elsewhere: [], notHere: [] };

		for (const product of this.plugin.products.all()) {
			// `pantry: ignore`: bestaat alleen zodat recepten ernaar kunnen
			// wijzen. Nooit op de lijst, wat er ook in `minimum` staat.
			if (product.ignored || list.basket.has(product.path)) continue;

			if (!this.atShops(list, product)) {
				// Een maaltijd vraagt erom, maar het ligt niet waar je heen gaat.
				// Dat is een waarschuwing, geen regel op de lijst — en alleen als
				// je het niet al in huis hebt, want dan valt er niets te halen.
				const asked = this.needsOf(list).get(product);
				const short = toBuy(product, asked, 0);
				if (asked > 0 && (short === null || short > 0)) out.notHere.push(product);
				continue;
			}

			const amount = this.amount(list, product);
			const wanted =
				amount === null ? this.need(list, product) > 0 : amount > 0;
			if (!wanted) continue;

			const owner = this.ownerOf(list, product);
			if (owner) {
				out.elsewhere.push({ product, list: owner });
				continue;
			}
			if (amount === null || product.check) out.unsure.push(product);
			else out.buy.push(product);
		}

		return out;
	}

	boughtProducts(list: ShoppingList): Product[] {
		return [...list.basket.keys()]
			.map((path) => this.plugin.products.byPath(path))
			.filter((product): product is Product => product !== null);
	}

	/** De winkelgroepen van de lijst, in de volgorde van de lijst. */
	groups(list: ShoppingList, items: Product[]) {
		return groupForShopping(
			this.plugin,
			items,
			list.extras,
			(product) => this.shopFor(list, product),
			list.shops
		);
	}

	/** Welke geplande maaltijd bij welke lijst hoort, voor het kiezen. */
	claimedMeals(): Map<string, ShoppingList> {
		const claimed = new Map<string, ShoppingList>();
		for (const list of this.all()) {
			for (const ref of list.meals) claimed.set(mealKey(ref), list);
		}
		return claimed;
	}

	/** De maaltijden van een lijst die nog in het plan staan en nog niet gegeten zijn. */
	async liveMeals(list: ShoppingList): Promise<MealRef[]> {
		if (list.meals.length === 0) return [];
		const wanted = new Map(list.meals.map((ref) => [mealKey(ref), ref]));
		const dates = list.meals.map((ref) => ref.date).sort();
		const first = fromISODate(dates[0] ?? "");
		const last = fromISODate(dates[dates.length - 1] ?? "");
		if (!first || !last) return [];
		const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;

		const live: MealRef[] = [];
		for (const plan of await this.plugin.plans.covering(first, span)) {
			for (const day of plan.days) {
				for (const meal of day.meals) {
					for (const entry of meal.recipes) {
						if (entry.status) continue;
						const key = mealKey({ date: day.date, meal: meal.meal, recipe: entry.recipe });
						const ref = wanted.get(key);
						if (ref) live.push(ref);
					}
				}
			}
		}
		return live;
	}

	// ------------------------------------------------------------ mutaties

	/** Zet een nieuwe lijst neer als notitie, en het boodschappenmoment in het plan. */
	async create(draft: ListDraft): Promise<ShoppingList | null> {
		if (!isValidDraft(draft)) return null;
		const path = this.freePath(draft);
		const list: ShoppingList = {
			path,
			date: draft.date,
			arrival: draft.arrival,
			shops: [...draft.shops],
			meals: draft.meals.map((ref) => ({ ...ref })),
			basket: new Map(),
			nudge: new Map(),
			extras: [],
		};
		this.lists.set(path, list);
		await this.needsOf(list).rebuildFor(list);
		await this.write(list, true);
		await this.placeStops(list.date, list.shops, list.arrival);
		return list;
	}

	/**
	 * Past de keuzes van een lijst aan. Het mandje blijft staan: wat je al in
	 * je karretje hebt liggen wordt niet anders van een maaltijd erbij.
	 * Verandert de naam, dan verhuist de notitie mee.
	 */
	async update(list: ShoppingList, draft: ListDraft): Promise<void> {
		if (!isValidDraft(draft)) return;
		const before = { date: list.date, shops: [...list.shops] };

		list.date = draft.date;
		list.arrival = draft.arrival;
		list.shops = [...draft.shops];
		list.meals = draft.meals.map((ref) => ({ ...ref }));

		const wanted = listPath(this.folder(), list);
		if (wanted !== list.path) await this.move(list, this.freePath(list));

		await this.needsOf(list).rebuildFor(list);
		await this.write(list);

		const sameStop =
			before.date === list.date &&
			before.shops.length === list.shops.length &&
			before.shops.every((shop) => hasShop(list.shops, shop));
		if (!sameStop) await this.removeStops(before.date, before.shops);
		await this.placeStops(list.date, list.shops, list.arrival);
	}

	private freePath(draft: Pick<ListDraft, "date" | "shops">): string {
		const base = listPath(this.folder(), draft);
		if (!this.plugin.app.vault.getFileByPath(base)) return base;
		for (let n = 2; n < 100; n += 1) {
			const candidate = base.replace(/\.md$/, ` ${n}.md`);
			if (!this.plugin.app.vault.getFileByPath(candidate)) return candidate;
		}
		return base;
	}

	private async move(list: ShoppingList, to: string): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(list.path);
		const from = list.path;
		if (file) await this.plugin.app.fileManager.renameFile(file, to);
		const needs = this.needs.get(from);
		const written = this.lastWritten.get(from);
		this.forget(from);
		list.path = to;
		this.lists.set(to, list);
		if (needs) this.needs.set(to, needs);
		if (written !== undefined) this.lastWritten.set(to, written);
	}

	/** Klaar: de notitie gaat weg, het boodschappenmoment blijft in het plan staan. */
	async finish(list: ShoppingList): Promise<void> {
		await this.remove(list);
	}

	/** Toch niet: de notitie én het boodschappenmoment gaan weg. */
	async discard(list: ShoppingList): Promise<void> {
		await this.remove(list);
		await this.removeStops(list.date, list.shops);
	}

	private async remove(list: ShoppingList): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(list.path);
		this.forget(list.path);
		if (file) await this.plugin.app.fileManager.trashFile(file);
	}

	// ------------------------------------------------ boodschappenmomenten

	private stopFor(shop: string, arrival: Arrival | null): ShoppingStop {
		if (!arrival || arrival.meal.trim().length === 0) return { shop };
		return { shop, meal: arrival.meal, when: arrival.when };
	}

	/** Zet het boodschappenmoment van deze lijst in het weekplan, één per winkel. */
	private async placeStops(date: string, shops: string[], arrival: Arrival | null): Promise<void> {
		if (shops.length === 0) return;
		const day = fromISODate(date);
		if (!day) return;
		const weekStart = startOfWeek(day, this.plugin.settings.weekStartDay);
		const plan = await this.plugin.plans.load(weekStart);
		const kept = shoppingAt(plan, date).filter((stop) => !hasShop(shops, stop.shop));
		setShopping(plan, date, [...kept, ...shops.map((shop) => this.stopFor(shop, arrival))]);
		await this.plugin.plans.save(weekStart, plan);
	}

	private async removeStops(date: string, shops: string[]): Promise<void> {
		if (shops.length === 0) return;
		const day = fromISODate(date);
		if (!day) return;
		const weekStart = startOfWeek(day, this.plugin.settings.weekStartDay);
		const plan = await this.plugin.plans.load(weekStart);
		const stops = shoppingAt(plan, date);
		const kept = stops.filter((stop) => !hasShop(shops, stop.shop));
		if (kept.length === stops.length) return;
		setShopping(plan, date, kept);
		await this.plugin.plans.save(weekStart, plan);
	}

	// --------------------------------------------------------------- mandje

	/**
	 * Afvinken is de hele boekhouding: gekocht betekent weer meer dan genoeg.
	 * De oude telling gaat het mandje in, zodat terugvinken hem terugzet.
	 */
	async markBought(list: ShoppingList, product: Product): Promise<void> {
		await this.markBoughtQuietly(list, product);
		await this.write(list);
	}

	async undoBought(list: ShoppingList, product: Product): Promise<void> {
		await this.undoBoughtQuietly(list, product);
		await this.write(list);
	}

	private async markBoughtQuietly(list: ShoppingList, product: Product): Promise<void> {
		// Ook de check-vlag bewaren: die wordt hieronder gewist, en zonder
		// bewaren kreeg een product uit "Check first" hem nooit meer terug.
		list.basket.set(product.path, { count: product.count, check: product.check });
		list.nudge.delete(product.path);
		await this.plugin.products.update(product, { count: "plus", check: false });
	}

	private async undoBoughtQuietly(list: ShoppingList, product: Product): Promise<void> {
		const before: BasketEntry | undefined = list.basket.get(product.path);
		list.basket.delete(product.path);
		await this.plugin.products.update(product, {
			count: before?.count ?? null,
			check: before?.check ?? false,
		});
	}

	async setNudge(list: ShoppingList, product: Product, step: number): Promise<void> {
		if (step === 0) list.nudge.delete(product.path);
		else list.nudge.set(product.path, step);
		await this.write(list);
	}

	// ------------------------------------------------------ losse boodschappen

	extraById(list: ShoppingList, id: string): Extra | null {
		return list.extras.find((extra) => extra.id === id) ?? null;
	}

	async addExtra(list: ShoppingList, draft: Omit<Extra, "id">): Promise<Extra | null> {
		const name = draft.name.trim();
		if (name.length === 0) return null;
		const extra: Extra = {
			id: newExtraId(),
			name,
			amount: cleanAmount(draft.amount),
			shop: draft.shop.trim(),
			shelf: draft.shelf.trim(),
		};
		list.extras.push(extra);
		await this.write(list);
		return extra;
	}

	async updateExtra(
		list: ShoppingList,
		id: string,
		patch: Partial<Omit<Extra, "id">>
	): Promise<void> {
		const extra = this.extraById(list, id);
		if (!extra) return;
		if (patch.name !== undefined) {
			const name = patch.name.trim();
			if (name.length > 0) extra.name = name;
		}
		if (patch.amount !== undefined) extra.amount = cleanAmount(patch.amount);
		if (patch.shop !== undefined) extra.shop = patch.shop.trim();
		if (patch.shelf !== undefined) extra.shelf = patch.shelf.trim();
		await this.write(list);
	}

	/** Afvinken is wissen: een los regeltje heeft geen voorraad om naar terug te vallen. */
	async removeExtra(list: ShoppingList, id: string): Promise<void> {
		const at = list.extras.findIndex((extra) => extra.id === id);
		if (at === -1) return;
		list.extras.splice(at, 1);
		await this.write(list);
	}

	private matchExtra(list: ShoppingList, text: string): Extra | null {
		const name = text.replace(/\s*·\s*\d+(\s.*)?$/, "").trim().toLowerCase();
		if (name.length === 0) return null;
		return list.extras.find((extra) => extra.name.toLowerCase() === name) ?? null;
	}

	// -------------------------------------------------------------- notitie

	/**
	 * Verwerkt wat iemand in de notitie zelf deed — een vinkje op de telefoon,
	 * een maaltijd erbij in de frontmatter — en schrijft de notitie dan één
	 * keer opnieuw.
	 *
	 * De notitie is de waarheid over de keuzes: wat er in de frontmatter staat
	 * vervangt wat we hadden. Alle tikken worden eerst verwerkt en pas daarna
	 * wordt er geschreven; schreef elke tik apart, dan werd de notitie vijf keer
	 * herschreven vanuit één momentopname — en een vinkje dat je zette tussen
	 * het lezen en het laatste schrijven werd stil weer uitgevinkt.
	 */
	async syncFromNote(file: TFile): Promise<void> {
		const content = await this.plugin.app.vault.cachedRead(file);
		if (this.wroteExactly(file.path, content)) return;

		const fresh = this.read(file.path, content);
		if (!fresh) {
			this.forget(file.path);
			return;
		}
		const known = this.lists.get(file.path);
		const list = known ?? fresh;
		if (known) {
			// Keuzes uit de notitie; het mandje ook, want daar staan de vinkjes
			// van een ander apparaat in.
			known.date = fresh.date;
			known.arrival = fresh.arrival;
			known.shops = fresh.shops;
			known.meals = fresh.meals;
			known.basket = fresh.basket;
			known.nudge = fresh.nudge;
			known.extras = fresh.extras;
		} else {
			this.lists.set(file.path, list);
		}

		let inBought = false;
		const tickedExtras: string[] = [];
		for (const line of content.split(/\r?\n/)) {
			if (line.startsWith("## ")) {
				inBought = line.trim() === BOUGHT_HEADING;
				continue;
			}
			const box = ANY_TICK.exec(line);
			if (!box) continue;
			const ticked = (box[1] ?? "").toLowerCase() === "x";

			const match = TICK.exec(line);
			if (match) {
				const product = this.resolve((match[2] ?? "").trim(), file.path);
				if (!product) continue;
				if (ticked && !inBought && !list.basket.has(product.path)) {
					await this.markBoughtQuietly(list, product);
				} else if (!ticked && inBought && list.basket.has(product.path)) {
					await this.undoBoughtQuietly(list, product);
				}
				continue;
			}

			if (!ticked) continue;
			const extra = this.matchExtra(list, (box[2] ?? "").trim());
			if (extra) tickedExtras.push(extra.id);
		}
		for (const id of tickedExtras) {
			const at = list.extras.findIndex((extra) => extra.id === id);
			if (at !== -1) list.extras.splice(at, 1);
		}

		await this.needsOf(list).rebuildFor(list);
		await this.write(list);
	}

	/**
	 * Schrijft de notitie van een lijst: de keuzes in de frontmatter, de
	 * afvinklijst in het stuk dat Pantry beheert. Wat je zelf onder de lijst
	 * schrijft blijft staan; een frontmatter-veld dat niet van ons is ook.
	 */
	async write(list: ShoppingList, fresh = false): Promise<void> {
		const { vault } = this.plugin.app;
		// M40: een lege productindex is geen boodschappenlijst van niks.
		if (this.plugin.products.all().length === 0) return;

		const file = vault.getFileByPath(list.path);
		if (!file) {
			if (!fresh) return;
			await ensureFolder(vault, list.path);
			const content = this.compose(list, "");
			this.lastWritten.set(list.path, content);
			await vault.create(list.path, content);
			return;
		}

		const current = await vault.cachedRead(file);
		if (!this.mayWriteTo(current, list.path)) return;
		clearWarning(file);
		if (current === this.compose(list, current)) return;

		// process() in plaats van modify(): dit is precies de notitie die je
		// waarschijnlijk open hebt staan, en een blinde modify gooit weg wat er
		// tussen lezen en schrijven bij kwam.
		const written = await vault.process(file, (latest: string) =>
			this.compose(list, latest)
		);
		this.lastWritten.set(list.path, written);
	}

	/** Alleen een notitie die van Pantry is, of leeg is, wordt aangeraakt. */
	private mayWriteTo(content: string, path: string): boolean {
		if (content.trim().length === 0) return true;
		if (hasRegion(content, LIST_REGION)) return true;
		if (parseList(this.frontmatterOf(content))) return true;
		warnOnce(path, `left ${path} alone: it is not a Pantry shopping list`);
		return false;
	}

	/** De hele notitie zoals hij hoort te zijn, gegeven wat er nu staat. */
	private compose(list: ShoppingList, current: string): string {
		const existing = this.frontmatterOf(current);
		for (const key of OWN_KEYS) delete existing[key];
		const frontmatter = {
			...serialiseList(list, (path) => this.plugin.products.byPath(path)?.name ?? null),
			...existing,
		};
		const yaml = stringifyYaml(frontmatter).trimEnd();

		const match = FRONTMATTER.exec(current);
		let body = match ? current.slice(match[0].length) : current;

		// De titel is van ons: hij zegt waar de lijst voor is, en dat kan
		// veranderen. De eerste kop wordt vervangen; staat er geen, dan komt
		// hij erbij.
		const title = `# ${listLabel(list)}`;
		const lines = body.split(/\r?\n/);
		const at = lines.findIndex((line) => line.trim().length > 0);
		if (at !== -1 && (lines[at] ?? "").startsWith("# ")) {
			lines[at] = title;
			body = lines.join("\n");
		} else {
			body = `${title}\n\n${body.replace(/^\s+/, "")}`;
		}

		const withRegion = replaceRegion(body, LIST_REGION, this.render(list));
		return `---\n${yaml}\n---\n${withRegion.startsWith("\n") ? "" : "\n"}${withRegion}`;
	}

	private render(list: ShoppingList): string {
		const { buy, unsure, elsewhere, notHere } = this.buckets(list);
		const lines: string[] = [SIGNATURE, ""];

		const done = this.boughtProducts(list);
		if (
			buy.length === 0 &&
			unsure.length === 0 &&
			elsewhere.length === 0 &&
			notHere.length === 0 &&
			done.length === 0 &&
			list.extras.length === 0
		) {
			lines.push("Nothing needed.", "");
			return lines.join("\n");
		}

		this.groups(list, buy).forEach((group) => {
			lines.push(`## ${group.shop}`, "");
			group.shelves.forEach(({ shelf, items, extras }) => {
				if (group.shelves.length > 1) lines.push(`### ${shelf}`, "");
				items.forEach((product) => lines.push(this.line(list, product, false)));
				extras.forEach((extra) => lines.push(`- [ ] ${extraLabel(extra)}`));
				lines.push("");
			});
		});

		if (unsure.length > 0) {
			lines.push(CHECK_HEADING, "");
			[...unsure]
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => lines.push(this.line(list, product, false)));
			lines.push("");
		}

		if (elsewhere.length > 0) {
			lines.push(ELSEWHERE_HEADING, "");
			[...elsewhere]
				.sort((a, b) => a.product.name.localeCompare(b.product.name))
				.forEach(({ product, list: owner }) =>
					lines.push(`- [[${product.name}]] — ${listLabel(owner)}`)
				);
			lines.push("");
		}

		if (notHere.length > 0) {
			lines.push(NOT_HERE_HEADING, "");
			[...notHere]
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => {
					const where = product.shops.join(", ");
					lines.push(`- [[${product.name}]] · ${this.amountText(list, product)}${where ? ` — ${where}` : ""}`);
				});
			lines.push("");
		}

		if (done.length > 0) {
			lines.push(BOUGHT_HEADING, "");
			[...done]
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => lines.push(this.line(list, product, true)));
			lines.push("", "*Untick to put the old count back.*", "");
		}

		return lines.join("\n");
	}

	amountText(list: ShoppingList, product: Product): string {
		const amount = this.amount(list, product);
		if (amount === null) return "?";
		return `${amount}${product.unit ? ` ${product.unit}` : ""}`;
	}

	private line(list: ShoppingList, product: Product, ticked: boolean): string {
		if (ticked) return `- [x] [[${product.name}]]`;
		return `- [ ] [[${product.name}]] · ${this.amountText(list, product)}`;
	}
}

export { NO_SHOP };
