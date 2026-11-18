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
import { shelfAt, toBuy, type Product } from "./products";
import { DEFAULT_EXTRA_AMOUNT, extraLabel, newExtraId, type Extra } from "./extras";
import { groupForShopping, NO_SHOP } from "./grouping";
import { fromISODate, startOfWeek, toISODate } from "./date";
import { asText } from "./text";
import { setShopping, shoppingAt } from "./plan";
import type { ShoppingStop } from "./types";
import {
	DONE_FOLDER,
	DONE_MARK_VALUE,
	LIST_MARK,
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
	noUnresolved,
	type ListDraft,
	type MealRef,
	type ShoppingList,
} from "./shopping-list";
import { Refusal } from "./guard";
import { arrivesInTime, earliest, stopMoment, type Moment } from "./arrival";

/** Waar de lijsten staan als er niets is ingesteld. */
export const DEFAULT_SHOPPING_FOLDER = "Cupboard/Shopping";

const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";
const ELSEWHERE_HEADING = "## On another list";
const NOT_HERE_HEADING = "## Not at these shops";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;
/** Elk vinkvakje, ook zonder wikilink: zo staan losse boodschappen erin. */
const ANY_TICK = /^\s*-\s\[([ xX])\]\s*(.+?)\s*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const SIGNATURE =
	"*Kept up to date by Cupboard. Tick a box and that product counts as full again.*";

/** De sleutels die de plugin zelf beheert in de frontmatter van een lijst. */
const OWN_KEYS = ["pantry", "format", "date", "arrives", "shops", "staples", "meals", "basket", "nudge", "skipped", "extras"];

/** Wat een lijst deze keer te zeggen heeft over elk product. */
export interface ListBuckets {
	/** Kopen, in deze winkels. */
	buy: Product[];
	/** Kan nog niet gezegd worden: nooit geteld, of bewust "even kijken". */
	unsure: Product[];
	/** Een andere open lijst haalt dit; hier alleen ter herinnering. */
	elsewhere: { product: Product; list: ShoppingList }[];
	/** Een gekozen maaltijd vraagt erom, maar geen lijst kan het op tijd halen. */
	notHere: Product[];
}

/** Zie `ShoppingLists.placement`. */
export interface Placement {
	/** De lijst die het haalt; null als geen enkele lijst erom vraagt of het kan. */
	owner: ShoppingList | null;
	/**
	 * Er gaat wel een lijst naar een winkel waar dit ligt, maar geen enkele is
	 * er op tijd mee. Wie het dan toch houdt, heeft het te laat in huis.
	 */
	late: boolean;
	/** Het minimum plus de maaltijden van alle open lijsten samen. */
	need: number;
	/** Hoeveel er samen gekocht moet worden; null als de telling ontbreekt. */
	amount: number | null;
	/** Vraagt er nu een lijst om: iets te kopen, of iets na te kijken? */
	wanted: boolean;
}

/** Minstens één, altijd heel: een halve zak batterijen bestaat niet. */
function cleanAmount(value: number): number {
	const amount = Math.round(Number(value));
	return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_EXTRA_AMOUNT;
}

/** Neemt alles wat de notitie zegt over in het object dat het scherm vasthoudt. */
function adopt(into: ShoppingList, from: ShoppingList): void {
	into.date = from.date;
	into.arrival = from.arrival;
	into.shops = from.shops;
	into.staples = from.staples;
	into.meals = from.meals;
	into.basket = from.basket;
	into.nudge = from.nudge;
	into.skipped = from.skipped;
	into.extras = from.extras;
	into.unresolved = from.unresolved;
	into.frozen = from.frozen;
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

	/** De reden dat deze build een lijst niet mag schrijven, als er zo'n lijst is. */
	frozenReason(): string | null {
		for (const list of this.lists.values()) if (list.frozen) return list.frozen;
		return null;
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
			skipped: new Set(),
			extras: parsed.extras,
			unresolved: noUnresolved(),
			frozen: parsed.frozen,
		};
		// Wat niet oplost blijft bewaard op naam: zie ShoppingList.unresolved.
		for (const { name, entry } of parsed.basket) {
			const product = this.resolve(name, path);
			if (product) list.basket.set(product.path, entry);
			else list.unresolved.basket.push({ name, entry });
		}
		for (const { name, step } of parsed.nudge) {
			const product = this.resolve(name, path);
			if (product) list.nudge.set(product.path, step);
			else list.unresolved.nudge.push({ name, step });
		}
		for (const name of parsed.skipped) {
			const product = this.resolve(name, path);
			if (product) list.skipped.add(product.path);
			else list.unresolved.skipped.push(name);
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
		// Ook wat via een standaardlijst meekomt: wie de Lidl-lijst meeneemt
		// naar de AH heeft gezegd dat hij dat spul dáár haalt.
		return product.shops.some(
			(shop) => hasShop(list.shops, shop) || hasShop(list.staples, shop)
		);
	}

	/**
	 * In welke winkel van deze lijst dit product ligt: de eerste voorkeur van
	 * het product die op de lijst staat. Zonder winkels op de lijst wint de
	 * eerste voorkeur; zonder winkel bij het product blijft het leeg.
	 *
	 * Komt het product mee via een standaardlijst van een winkel waar je deze
	 * keer niet heen gaat, dan haal je het in een winkel waar je wél heen
	 * gaat: de eerste waar het een schap heeft, en anders de eerste. Daar
	 * staat het dan onder "No shelf at …" tot iemand zegt waar het ligt.
	 */
	shopFor(list: ShoppingList, product: Product): string {
		const preferred = product.shops.map((shop) => shop.trim()).filter(Boolean);
		if (list.shops.length === 0) return preferred[0] ?? "";
		for (const shop of preferred) {
			const known = list.shops.find((candidate) => sameName(candidate, shop));
			if (known) return known;
		}
		if (!preferred.some((shop) => hasShop(list.staples, shop))) return "";
		return (
			list.shops.find((shop) => this.plugin.shops.hasShelf(shop, shelfAt(product, shop))) ??
			list.shops[0] ??
			""
		);
	}

	minimumOf(list: ShoppingList, product: Product): number {
		return this.needsOf(list).minimumOf(product);
	}

	/** Wat déze lijst zelf vraagt: haar minimum plus haar eigen maaltijden. */
	private ownNeed(list: ShoppingList, product: Product): number {
		return this.minimumOf(list, product) + this.needsOf(list).get(product);
	}

	/** Vanaf wanneer het spul van deze lijst in huis is. */
	private tripMoment(list: ShoppingList): Moment {
		return stopMoment(
			{ ...this.stopFor("", list.arrival), date: list.date },
			this.plugin.settings.meals
		);
	}

	/**
	 * Wat de open lijsten sámen van dit product vragen, en welke lijst het
	 * haalt.
	 *
	 * Lijsten zijn winkelbezoeken, en die horen bij elkaar: woensdag naar de
	 * Lidl, vrijdag naar de AH, één keer tellen. Tot 1.4 pakte de vroegste
	 * lijst alles wat ze kon krijgen. Olijfolie die je bij de AH wilt halen
	 * stond dan op de Lidl-lijst, alleen omdat die eerder was; en tortilla's
	 * voor zaterdag, die alleen de Lidl heeft, waren op de AH-lijst een
	 * waarschuwing terwijl je woensdag gewoon bij de Lidl stond.
	 *
	 * De regel is die van het weekplan (`assignShop` in arrival.ts): de
	 * voorkeursvolgorde van het product, en de eerste winkel die op tijd is
	 * wint. Hier is "een winkel" een open lijst die erheen gaat, en "op tijd"
	 * het moment waarop die lijst in huis is. Een lijst die de standaard
	 * boodschappen van een winkel meeneemt zonder erheen te gaan telt ook,
	 * maar pas na een lijst die er wél heen gaat.
	 *
	 * Is geen enkele lijst op tijd, dan verhuist er niets: de lijst die erom
	 * vraagt houdt het zelf als ze het kan kopen, en anders is het een
	 * waarschuwing. Het stil ergens anders neerzetten maakt het niet op tijd.
	 *
	 * De hoeveelheid is van alle lijsten samen. Wie het haalt, haalt het voor
	 * iedereen: afvinken zet de voorraad op "+", en daarna vraagt geen lijst
	 * er meer om.
	 */
	placement(product: Product): Placement {
		// Wie het al in het mandje heeft of deze keer overslaat doet niet mee:
		// niet als vrager, en niet als lijst die het zou kunnen halen.
		const pool = this.all().filter(
			(list) => !list.basket.has(product.path) && !this.isSkipped(list, product)
		);

		let meals = 0;
		let minimum = 0;
		let deadline: Moment | null = null;
		for (const list of pool) {
			const index = this.needsOf(list);
			const asked = index.get(product);
			meals += asked;
			minimum = Math.max(minimum, index.minimumOf(product));
			if (asked > 0) deadline = earliest(deadline, index.momentFor(product));
		}

		const need = minimum + meals;
		const amount = toBuy(product, meals, minimum);
		const out: Placement = { owner: null, late: false, need, amount, wanted: false };
		if (product.ignored) return out;

		// Een telling ontbreekt of is gevlagd als onzeker: dan is de vraag
		// "heb je het?" en telt wat er nodig is. Anders telt wat je zou kopen
		// — en "+" is dan genoeg. Zonder de vlag hier zou een product waar je
		// mee gekookt hebt terwijl het op "+" stond, stil van de lijst blijven.
		const wanted = amount === null || product.check ? need > 0 : amount > 0;
		if (!wanted) return out;
		out.wanted = true;

		const preferred = product.shops.map((shop) => shop.trim()).filter(Boolean);
		for (const shop of preferred) {
			const going = pool.filter((list) => hasShop(list.shops, shop));
			const carrying = pool.filter(
				(list) =>
					list.shops.length > 0 &&
					!preferred.some((known) => hasShop(list.shops, known)) &&
					hasShop(list.staples, shop)
			);
			for (const trip of [...going, ...carrying]) {
				out.late = true;
				if (!arrivesInTime(this.tripMoment(trip), deadline)) continue;
				return { ...out, owner: trip, late: false };
			}
		}

		// Niemand op tijd, of geen lijst naar een winkel van dit product: de
		// eerste lijst die er zelf om vraagt en het kan kopen houdt het.
		out.owner =
			pool.find((list) => this.ownNeed(list, product) > 0 && this.atShops(list, product)) ??
			null;
		return out;
	}

	/**
	 * Hoort dit product in de telronde over alle open lijsten?
	 *
	 * Alles wat een lijst in haar eigen voorraadcheck zou tonen, één keer.
	 */
	inRound(product: Product): boolean {
		return this.all().some((list) => this.relevant(list, product));
	}

	/**
	 * Tot welk getal de telronde voor dit product loopt: het minimum plus de
	 * maaltijden van álle open lijsten. Ook van een lijst die het al in het
	 * mandje heeft — anders stond een net gekocht product er als "no minimum
	 * set" in plaats van als "enough".
	 */
	roundNeed(product: Product): number {
		let meals = 0;
		let minimum = 0;
		for (const list of this.all()) {
			meals += this.needsOf(list).get(product);
			minimum = Math.max(minimum, this.minimumOf(list, product));
		}
		return minimum + meals;
	}

	/**
	 * Wat de lijst van dit product vraagt: het minimum plus de maaltijden.
	 * Voor de lijst die het haalt is dat de vraag van alle lijsten samen.
	 */
	need(list: ShoppingList, product: Product): number {
		const placed = this.placement(product);
		return placed.owner === list ? placed.need : this.ownNeed(list, product);
	}

	/** Hoeveel je hiervan koopt, met de ± aanpassing van deze lijst erbij. */
	amount(list: ShoppingList, product: Product): number | null {
		const placed = this.placement(product);
		const base =
			placed.owner === list
				? placed.amount
				: toBuy(product, this.needsOf(list).get(product), this.minimumOf(list, product));
		if (base === null) return null;
		return Math.max(0, base + (list.nudge.get(product.path) ?? 0));
	}

	/**
	 * Hoort dit product in de voorraadcheck van deze lijst?
	 *
	 * Alleen wat de lijst vraagt: het minimum of een maaltijd. Ook wat niet in
	 * deze winkels ligt telt mee: tellen doe je thuis, in één ronde langs je
	 * kasten, en juist daar blijkt dat je van de hummus nog drie bakjes hebt.
	 * Blijkt er genoeg te zijn, dan valt hij vanzelf uit de waarschuwing "Not
	 * at these shops" — hij hoefde nooit gehaald te worden. En wat deze lijst
	 * voor een andere lijst haalt hoort er ook bij: je koopt het hier.
	 *
	 * De check-vlag maakt een product hier níét relevant. Een kooksessie zet
	 * hem op alles wat op "+" stond (zie consume.ts), en de meeste van die
	 * producten vraagt niemand deze week. Tot de tik van 2026-09-23 stonden ze
	 * dan toch in de check, en wie de vlag daar uitzette zag de regel
	 * verdwijnen. De vlag blijft op het product staan en doet zijn werk zodra
	 * een lijst het product wél vraagt: dan staat het onder "Check first" in
	 * plaats van als "genoeg" — zie `placement()`.
	 */
	relevant(list: ShoppingList, product: Product): boolean {
		if (product.ignored) return false;
		return this.ownNeed(list, product) > 0 || this.placement(product).owner === list;
	}

	/** Deze keer bewust niet: niet tellen, niet kopen, niet waarschuwen. */
	isSkipped(list: ShoppingList, product: Product): boolean {
		return list.skipped.has(product.path);
	}

	/** De ándere lijst die dit product haalt, als deze lijst er ook om vraagt. */
	ownerOf(list: ShoppingList, product: Product): ShoppingList | null {
		if (list.basket.has(product.path) || this.isSkipped(list, product)) return null;
		const { owner } = this.placement(product);
		if (!owner || owner === list || this.ownNeed(list, product) <= 0) return null;
		return this.covers(owner, list, product) ? owner : null;
	}

	/**
	 * Is wat `owner` haalt op tijd voor wat `list` er zelf mee wil?
	 *
	 * Bijna altijd ja: dat is waarom die lijst het kreeg. Niet als geen
	 * enkele lijst op tijd was en een latere het toch houdt — feta voor
	 * donderdag, die pas vrijdag bij de AH op de lijst staat. Dan is "staat
	 * al op een andere lijst" een geruststelling die niet klopt.
	 */
	private covers(owner: ShoppingList, list: ShoppingList, product: Product): boolean {
		const index = this.needsOf(list);
		if (index.get(product) <= 0) return true;
		return arrivesInTime(this.tripMoment(owner), index.momentFor(product));
	}

	/** Dezelfde verdeling voor het scherm en de notitie, zodat die nooit verschillen. */
	buckets(list: ShoppingList): ListBuckets {
		const out: ListBuckets = { buy: [], unsure: [], elsewhere: [], notHere: [] };

		for (const product of this.plugin.products.all()) {
			// `pantry: ignore`: bestaat alleen zodat recepten ernaar kunnen
			// wijzen. Nooit op de lijst, wat er ook in `minimum` staat.
			if (product.ignored || list.basket.has(product.path)) continue;
			// Overgeslagen: niet op de lijst, en ook geen waarschuwing — dat je
			// hem niet haalt was juist de keuze.
			if (this.isSkipped(list, product)) continue;

			const placed = this.placement(product);
			if (placed.owner === list) {
				if (placed.amount === null || product.check) out.unsure.push(product);
				else out.buy.push(product);
				continue;
			}

			// Niet van ons om te halen. Dan staat het hier alleen als deze
			// lijst er zelf om vraagt: als herinnering dat een andere lijst
			// het haalt, of als waarschuwing dat niemand dat op tijd kan.
			if (this.ownNeed(list, product) <= 0) continue;
			const owner = this.ownerOf(list, product);
			if (owner) {
				out.elsewhere.push({ product, list: owner });
				continue;
			}
			// Een maaltijd vraagt erom, maar het ligt niet waar je heen gaat —
			// of pas als het te laat is. Dat is een waarschuwing, geen regel op
			// de lijst, en alleen als je het niet al in huis hebt.
			const asked = this.needsOf(list).get(product);
			const short = toBuy(product, asked, 0);
			if (asked > 0 && (short === null || short > 0)) out.notHere.push(product);
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
			staples: [...draft.staples],
			meals: draft.meals.map((ref) => ({ ...ref })),
			basket: new Map(),
			nudge: new Map(),
			skipped: new Set(),
			extras: [],
			unresolved: noUnresolved(),
			frozen: null,
		};
		this.lists.set(path, list);
		await this.needsOf(list).rebuildFor(list);
		await this.createNote(list);
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

		const wanted = listPath(this.folder(), draft);
		if (wanted !== list.path) await this.move(list, this.freePath(draft));

		await this.mutate(list, (fresh) => {
			fresh.date = draft.date;
			fresh.arrival = draft.arrival;
			fresh.shops = [...draft.shops];
			fresh.staples = [...draft.staples];
			fresh.meals = draft.meals.map((ref) => ({ ...ref }));
		});

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

	/**
	 * Klaar: de notitie verhuist naar `Done/` en krijgt het merk
	 * `shopping-done`; het boodschappenmoment blijft in het plan staan.
	 *
	 * Eerst ging de notitie de prullenbak in. Op een telefoon is Done één
	 * tik, en op 2026-09-09 was een lijst ineens weg zonder dat na te gaan
	 * viel hoe. Een afgeronde lijst is bovendien een verslag van wat je
	 * gehaald hebt. Dus: opzij, niet weg — `sweep()` ruimt hem later op.
	 */
	async finish(list: ShoppingList): Promise<void> {
		const { vault } = this.plugin.app;
		const file = vault.getFileByPath(list.path);
		this.forget(list.path);
		if (!file) return;

		const today = toISODate(new Date());
		await vault.process(file, (latest: string) => {
			const match = FRONTMATTER.exec(latest);
			const existing = this.frontmatterOf(latest);
			existing[LIST_MARK] = DONE_MARK_VALUE;
			existing.done = today;
			const yaml = stringifyYaml(existing).trimEnd();
			const body = match ? latest.slice(match[0].length) : latest;
			return `---\n${yaml}\n---\n${body}`;
		});

		const target = this.freeDonePath(file.basename);
		await ensureFolder(vault, target);
		await this.plugin.app.fileManager.renameFile(file, target);
	}

	private doneFolder(): string {
		return `${this.folder()}/${DONE_FOLDER}`;
	}

	private freeDonePath(basename: string): string {
		const base = `${this.doneFolder()}/${basename}.md`;
		if (!this.plugin.app.vault.getFileByPath(base)) return base;
		for (let n = 2; n < 100; n += 1) {
			const candidate = base.replace(/\.md$/, ` ${n}.md`);
			if (!this.plugin.app.vault.getFileByPath(candidate)) return candidate;
		}
		return base;
	}

	/**
	 * Ruimt afgeronde lijsten op die ouder zijn dan `cookKeepDays` — dezelfde
	 * termijn als kooksessies, want het is dezelfde vraag: hoe lang wil je
	 * terug kunnen kijken. Alleen notities met het merk `shopping-done` en
	 * een `done`-datum; wat iemand zelf in die map zette blijft staan.
	 */
	async sweep(): Promise<void> {
		const days = this.plugin.settings.cookKeepDays;
		if (!days || days <= 0) return;
		const cutoff = toISODate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
		for (const file of markdownIn(this.plugin.app.vault, this.doneFolder())) {
			const content = await this.plugin.app.vault.cachedRead(file);
			const frontmatter = this.frontmatterOf(content);
			if (frontmatter[LIST_MARK] !== DONE_MARK_VALUE) continue;
			const raw = frontmatter.done;
			// Obsidian leest een kale datum als Date; js-yaml in het harnas als tekst.
			const done = raw instanceof Date ? toISODate(raw) : asText(raw).slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(done) || done > cutoff) continue;
			await this.plugin.app.fileManager.trashFile(file);
		}
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
		// Op de notitie zoals hij nú is, niet op een gelezen kopie: zie
		// PlanStore.update.
		await this.plugin.plans.update(weekStart, (plan) => {
			const kept = shoppingAt(plan, date).filter((stop) => !hasShop(shops, stop.shop));
			setShopping(plan, date, [...kept, ...shops.map((shop) => this.stopFor(shop, arrival))]);
		});
	}

	private async removeStops(date: string, shops: string[]): Promise<void> {
		if (shops.length === 0) return;
		const day = fromISODate(date);
		if (!day) return;
		const weekStart = startOfWeek(day, this.plugin.settings.weekStartDay);
		// Alleen schrijven als er iets weg te halen valt; een lege wijziging
		// zou anders een notitie aanmaken voor een week zonder plan.
		const plan = await this.plugin.plans.load(weekStart);
		const stops = shoppingAt(plan, date);
		if (stops.every((stop) => !hasShop(shops, stop.shop))) return;
		await this.plugin.plans.update(weekStart, (fresh) => {
			const current = shoppingAt(fresh, date);
			setShopping(fresh, date, current.filter((stop) => !hasShop(shops, stop.shop)));
		});
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

	/**
	 * Zet het product in het mandje van de lijst zoals hij in de notitie
	 * staat, en boekt de voorraad. De productnotitie is van de voorraad, de
	 * lijstnotitie van het mandje; allebei worden ze aangepast op wat er nu
	 * staat, niet op wat het scherm nog dacht.
	 */
	private async markBoughtQuietly(list: ShoppingList, product: Product): Promise<void> {
		// Ook de check-vlag bewaren: die wordt hieronder gewist, en zonder
		// bewaren kreeg een product uit "Check first" hem nooit meer terug.
		const entry: BasketEntry = { count: product.count, check: product.check };
		await this.mutate(list, (fresh) => {
			if (fresh.basket.has(product.path)) return;
			fresh.basket.set(product.path, entry);
			fresh.nudge.delete(product.path);
		});
		await this.plugin.products.update(product, { count: "plus", check: false });
	}

	private async undoBoughtQuietly(list: ShoppingList, product: Product): Promise<void> {
		let before: BasketEntry | undefined;
		await this.mutate(list, (fresh) => {
			before = fresh.basket.get(product.path);
			fresh.basket.delete(product.path);
		});
		await this.plugin.products.update(product, {
			count: before?.count ?? null,
			check: before?.check ?? false,
		});
	}

	async setNudge(list: ShoppingList, product: Product, step: number): Promise<void> {
		await this.mutate(list, (fresh) => {
			if (step === 0) fresh.nudge.delete(product.path);
			else fresh.nudge.set(product.path, step);
		});
	}

	/**
	 * Deze keer overslaan, of toch weer meenemen. Alleen de lijst verandert;
	 * de telling in de productnotitie blijft wat hij was, want die zegt wat er
	 * in huis is, en daar verandert een winkelbezoek te voet niets aan.
	 */
	async setSkipped(list: ShoppingList, product: Product, skipped: boolean): Promise<void> {
		await this.mutate(list, (fresh) => {
			if (skipped) fresh.skipped.add(product.path);
			else fresh.skipped.delete(product.path);
		});
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
		await this.mutate(list, (fresh) => {
			fresh.extras.push(extra);
		});
		return extra;
	}

	async updateExtra(
		list: ShoppingList,
		id: string,
		patch: Partial<Omit<Extra, "id">>
	): Promise<void> {
		if (!this.extraById(list, id)) return;
		await this.mutate(list, (fresh) => {
			const extra = this.extraById(fresh, id);
			if (!extra) return;
			if (patch.name !== undefined) {
				const name = patch.name.trim();
				if (name.length > 0) extra.name = name;
			}
			if (patch.amount !== undefined) extra.amount = cleanAmount(patch.amount);
			if (patch.shop !== undefined) extra.shop = patch.shop.trim();
			if (patch.shelf !== undefined) extra.shelf = patch.shelf.trim();
		});
	}

	/** Afvinken is wissen: een los regeltje heeft geen voorraad om naar terug te vallen. */
	async removeExtra(list: ShoppingList, id: string): Promise<void> {
		if (!this.extraById(list, id)) return;
		await this.mutate(list, (fresh) => {
			const at = fresh.extras.findIndex((extra) => extra.id === id);
			if (at !== -1) fresh.extras.splice(at, 1);
		});
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
			adopt(known, fresh);
		} else {
			this.lists.set(file.path, list);
		}

		// Eerst alle vinkjes lezen, dan boeken, dan één keer schrijven.
		const bought: Product[] = [];
		const returned: Product[] = [];
		const tickedExtras: string[] = [];
		let inBought = false;
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
				if (ticked && !inBought && !list.basket.has(product.path)) bought.push(product);
				else if (!ticked && inBought && list.basket.has(product.path)) returned.push(product);
				continue;
			}

			if (!ticked) continue;
			const extra = this.matchExtra(list, (box[2] ?? "").trim());
			if (extra) tickedExtras.push(extra.id);
		}

		for (const product of bought) await this.markBoughtQuietly(list, product);
		for (const product of returned) await this.undoBoughtQuietly(list, product);

		await this.needsOf(list).rebuildFor(list);
		await this.mutate(list, (current) => {
			for (const id of tickedExtras) {
				const at = current.extras.findIndex((extra) => extra.id === id);
				if (at !== -1) current.extras.splice(at, 1);
			}
		});
	}

	/**
	 * Schrijft de notitie van een lijst: de keuzes in de frontmatter, de
	 * afvinklijst in het stuk dat Cupboard beheert. Wat je zelf onder de lijst
	 * schrijft blijft staan; een frontmatter-veld dat niet van ons is ook.
	 */
	async write(list: ShoppingList): Promise<void> {
		await this.mutate(list, null);
	}

	private async createNote(list: ShoppingList): Promise<void> {
		const { vault } = this.plugin.app;
		await ensureFolder(vault, list.path);
		const content = this.compose(list, "");
		this.lastWritten.set(list.path, content);
		await vault.create(list.path, content);
	}

	/**
	 * Past één wijziging toe op de lijst **zoals hij nu in de notitie staat**
	 * en schrijft het resultaat. Dit is de enige weg naar de notitie.
	 *
	 * Het object in het geheugen is een kopie van een moment; de notitie kan
	 * intussen van een ander apparaat een vinkje gekregen hebben dat hier nog
	 * niet verwerkt is. Vanuit het geheugen schrijven zou dat vinkje wissen —
	 * en het product stond op dat apparaat al op "gekocht". Daarom leest dit
	 * binnen `vault.process` de frontmatter opnieuw, past de wijziging daarop
	 * toe, en neemt daarna dat resultaat over in het object dat het scherm
	 * vasthoudt. De body is een spiegel en wordt altijd opnieuw getekend.
	 *
	 * `change` moet synchroon zijn; de voorraad boeken gebeurt erbuiten.
	 */
	private async mutate(
		list: ShoppingList,
		change: ((fresh: ShoppingList) => void) | null
	): Promise<void> {
		const { vault } = this.plugin.app;
		const file = vault.getFileByPath(list.path);
		if (!file) {
			// De notitie is weg (Done op een ander apparaat, of nog niet
			// gesynchroniseerd). Niet opnieuw aanmaken: dat zou een lijst
			// terugbrengen die iemand net had afgerond. Zonder wijziging
			// valt er ook niets te melden.
			if (!change) return;
			change(list);
			throw new Refusal(`Cupboard did not save: the list note ${list.path} is gone.`);
		}
		// M40: een lege productindex is geen boodschappenlijst van niks.
		if (this.plugin.products.all().length === 0) {
			change?.(list);
			return;
		}

		// Alleen een spiegel-verversing: niets schrijven als er niets te
		// verversen valt. Elke schrijfactie is een sync-ronde en een
		// cache-event, en die lopen anders rond.
		if (!change) {
			const current = await vault.cachedRead(file);
			if (!this.mayWriteTo(current, list.path)) return;
			const fresh = this.read(list.path, current);
			if (fresh) adopt(list, fresh);
			if (list.frozen || this.compose(list, current) === current) return;
		}

		let refused: string | null = null;
		const written = await vault.process(file, (latest: string) => {
			if (!this.mayWriteTo(latest, list.path)) {
				refused = `Cupboard left ${list.path} alone: it is not a Cupboard shopping list.`;
				return latest;
			}
			const fresh = this.read(list.path, latest);
			if (fresh) adopt(list, fresh);
			if (list.frozen) {
				refused = `Cupboard did not save ${file.basename}: ${list.frozen}.`;
				return latest;
			}
			change?.(list);
			return this.compose(list, latest);
		});
		if (refused) {
			if (!change) return;
			throw new Refusal(refused);
		}
		clearWarning(file);
		this.lastWritten.set(list.path, written);
	}

	/** Alleen een notitie die van Cupboard is, of leeg is, wordt aangeraakt. */
	private mayWriteTo(content: string, path: string): boolean {
		if (content.trim().length === 0) return true;
		if (hasRegion(content, LIST_REGION)) return true;
		if (parseList(this.frontmatterOf(content))) return true;
		warnOnce(path, `left ${path} alone: it is not a Cupboard shopping list`);
		return false;
	}

	/** De hele notitie zoals hij hoort te zijn, gegeven wat er nu staat. */
	private compose(list: ShoppingList, current: string): string {
		const existing = this.frontmatterOf(current);
		for (const key of OWN_KEYS) delete existing[key];
		const frontmatter = {
			...serialiseList(
				list,
				(path) => this.plugin.products.byPath(path)?.name ?? null,
				this.lists.size > 1
			),
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
			group.shelves.forEach(({ shelf, items, extras, unplaced }) => {
				if (group.shelves.length > 1 || unplaced) lines.push(`### ${shelf}`, "");
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
		// Gevlagd en op papier niets te kopen: de vlag zegt juist dat dat
		// papier niet klopt. Dan is "?" eerlijker dan "0".
		if (amount === null || (amount === 0 && product.check)) return "?";
		return `${amount}${product.unit ? ` ${product.unit}` : ""}`;
	}

	private line(list: ShoppingList, product: Product, ticked: boolean): string {
		if (ticked) return `- [x] [[${product.name}]]`;
		return `- [ ] [[${product.name}]] · ${this.amountText(list, product)}`;
	}
}

export { NO_SHOP };
