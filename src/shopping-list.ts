/**
 * Een boodschappenlijst: één keer boodschappen doen, als notitie.
 *
 * Voorraad checken en een lijst maken is geen eenmalig proces per week. Het
 * zijn twee stappen die bij elkaar horen en die je meerdere keren naast elkaar
 * doet: vandaag naar de Lidl voor morgen en overmorgen, morgen bij de AH
 * bestellen voor de dagen daarna. Elke keer is een eigen lijst, met een eigen
 * voorraadcheck en een eigen afvinklijst, en die lijsten bestaan naast elkaar.
 *
 * Een lijst zegt waar hij voor is:
 *
 * - **de datum** waarop je boodschappen doet — die maakt hem uniek en zet het
 *   boodschappenmoment in het weekplan;
 * - **de winkels** — voor elke winkel tellen de producten mee die daar liggen
 *   én een minimum hebben: de "standaard boodschappen" van die winkel;
 * - **de maaltijden** uit het weekplan die deze keer meegaan. Een maaltijd zit
 *   in hooguit één lijst, anders koop je dubbel.
 *
 * De lijst is een notitie in `Pantry/Shopping/`: de keuzes, het mandje en de
 * ± aanpassingen staan in de frontmatter, de afvinklijst in de body. Klaar
 * verhuist de notitie naar `Done/`. Zo is er niets buiten de vault dat
 * bijgehouden moet worden, en neemt Obsidian Sync alles mee naar je telefoon.
 *
 * Wat hier staat is het pure model: lezen, schrijven, benoemen. De rekenkern
 * en de vault-kant staan in `shopping-lists.ts`.
 */

import { linkTarget, toLink } from "./links";
import { parseCount, type Count } from "./products";
import { parseExtras, type Extra } from "./extras";
import { asText } from "./text";
import { fromISODate, toISODate, WEEKDAY_NAMES } from "./date";
import { safeFileName } from "./cook-session";
import { FORMAT_KEY, PANTRY_FORMAT, isNewer, newerMessage } from "./format";

/** De frontmatter-sleutel die een notitie als boodschappenlijst merkt. */
export const LIST_MARK = "pantry";
export const LIST_MARK_VALUE = "shopping";
/**
 * Een afgeronde lijst. Hij verhuist naar de map `Done/` en krijgt dit merk,
 * zodat de index hem niet meer ziet maar de notitie er nog wel is: wat je
 * gehaald hebt staat erin, en een Done die je niet bedoelde is terug te
 * draaien door het merk terug te zetten. Na `cookKeepDays` ruimt Pantry hem op.
 */
export const DONE_MARK_VALUE = "shopping-done";
/** Submap van de lijstmap waar afgeronde lijsten heen gaan. */
export const DONE_FOLDER = "Done";

/** Het stuk van de notitie dat Pantry beheert; zie src/notes.ts. */
export const LIST_REGION = "shopping";

/** Een geplande maaltijd uit het weekplan, precies genoeg om hem terug te vinden. */
export interface MealRef {
	/** ISO-datum van de dag in het plan. */
	date: string;
	/** Naam van de maaltijd zoals hij in het blok staat. */
	meal: string;
	/** Naam van het recept, zonder haakjes. */
	recipe: string;
}

/**
 * Vanaf wanneer het spul van deze lijst in huis is: het begin van de dag
 * (niets ingevuld), of vóór of ná een maaltijd. Hetzelfde begrip als het
 * boodschappenmoment in het weekplan, want dat is wat de lijst daar neerzet.
 */
export interface Arrival {
	meal: string;
	when: "before" | "after";
}

/** Wat een product was vóór je het afvinkte, zodat een misser terug kan. */
export interface BasketEntry {
	count: Count | null;
	check: boolean;
}

export interface ShoppingList {
	/** Vaultpad van de notitie. */
	path: string;
	/** ISO-datum waarop je boodschappen doet. */
	date: string;
	arrival: Arrival | null;
	/** Winkelnamen zoals de winkelnotities heten, in de gekozen volgorde. */
	shops: string[];
	meals: MealRef[];
	/** Afgevinkt, gesleuteld op productpad. */
	basket: Map<string, BasketEntry>;
	/** De ± aanpassingen van de lijst, gesleuteld op productpad. */
	nudge: Map<string, number>;
	/**
	 * Deze keer overgeslagen, als productpaden. Niet tellen, niet kopen: je
	 * gaat lopend naar de winkel en haalt alleen wat echt moet. Het product
	 * zelf blijft zoals het is — de volgende lijst vraagt er gewoon weer om.
	 */
	skipped: Set<string>;
	extras: Extra[];
	/**
	 * Wat in de notitie staat maar nu niet naar een product te herleiden is.
	 *
	 * Een product dat Sync nog niet gebracht heeft, of dat net hernoemd is,
	 * lost even niet op. Dat is geen reden om het uit de notitie te halen: de
	 * volgende keer lezen kan het er wél zijn. Dit blijft dus staan zoals het
	 * was en gaat bij het schrijven ongewijzigd mee. Op 2026-09-09 verloor een
	 * half gesynchroniseerde telefoon zo bijna een mandje.
	 */
	unresolved: Unresolved;
	/**
	 * Waarom deze lijst hier niet geschreven mag worden: de notitie komt van
	 * een nieuwere Pantry dan deze build. Lezen en tonen mag; elke schrijfactie
	 * weigert, en Home zegt dat dit apparaat bijgewerkt moet worden.
	 */
	frozen: string | null;
}

export interface Unresolved {
	basket: { name: string; entry: BasketEntry }[];
	nudge: { name: string; step: number }[];
	skipped: string[];
}

export function noUnresolved(): Unresolved {
	return { basket: [], nudge: [], skipped: [] };
}

/** De keuzes uit het setup-scherm: alles behalve wat je in de winkel doet. */
export interface ListDraft {
	date: string;
	arrival: Arrival | null;
	shops: string[];
	meals: MealRef[];
}

export function emptyDraft(date: string): ListDraft {
	return { date, arrival: null, shops: [], meals: [] };
}

/** Nul maaltijden én nul winkels is geen lijst: er valt niets te halen. */
export function isValidDraft(draft: ListDraft): boolean {
	return (
		fromISODate(draft.date) !== null &&
		(draft.shops.length > 0 || draft.meals.length > 0)
	);
}

export function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function hasShop(shops: readonly string[], shop: string): boolean {
	return shops.some((known) => sameName(known, shop));
}

/** De sleutel van een geplande maaltijd, zodat twee lijsten hem niet allebei nemen. */
export function mealKey(ref: MealRef): string {
	return `${ref.date}|${ref.meal.trim().toLowerCase()}|${linkTarget(ref.recipe).toLowerCase()}`;
}

export function hasMeal(meals: readonly MealRef[], ref: MealRef): boolean {
	const key = mealKey(ref);
	return meals.some((known) => mealKey(known) === key);
}

// ------------------------------------------------------------------ namen

const MONTH_NAMES = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "Wed 10 Sep" — met de hand, niet via `toLocaleDateString`: dat wisselt per
 * apparaat en per ICU-versie ("Sept"), en dit staat in een bestandsnaam.
 */
export function formatListDate(iso: string): string {
	const date = fromISODate(iso);
	if (!date) return iso;
	const weekday = (WEEKDAY_NAMES[date.getDay()] ?? "").slice(0, 3);
	return `${weekday} ${date.getDate()} ${MONTH_NAMES[date.getMonth()] ?? ""}`;
}

/**
 * De naam van een lijst: "Lidl · AH · Wed 10 Sep". Winkels eerst, want dat is
 * waar je heen gaat; zonder winkels staat er wat er dan wél in zit.
 */
export function listLabel(draft: Pick<ListDraft, "date" | "shops">): string {
	const where = draft.shops.length > 0 ? draft.shops.join(" · ") : "Meals";
	return `${where} · ${formatListDate(draft.date)}`;
}

/** `Pantry/Shopping/2026-09-10 Lidl · AH.md` — de datum voorop, dan sorteert de map zichzelf. */
export function listPath(folder: string, draft: Pick<ListDraft, "date" | "shops">): string {
	const base = folder.replace(/\/+$/, "");
	const where = draft.shops.length > 0 ? draft.shops.join(" · ") : "Shopping";
	const name = safeFileName(`${draft.date} ${where}`);
	return base.length > 0 ? `${base}/${name}.md` : `${name}.md`;
}

/** Vóór vandaag: de lijst had al gedaan moeten zijn. */
export function isOverdue(list: Pick<ShoppingList, "date">, today = new Date()): boolean {
	return list.date < toISODate(today);
}

// ---------------------------------------------------------------- lezen

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Een datum uit de frontmatter, ook als de YAML-lezer er een Date van maakte. */
function dateText(value: unknown): string {
	const text = asText(value).trim();
	return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
}

/** "after Dinner" → { meal: "Dinner", when: "after" }; iets anders → begin van de dag. */
export function parseArrival(raw: unknown): Arrival | null {
	const text = asText(raw).trim();
	const match = /^(before|after)\s+(.+)$/i.exec(text);
	if (!match) return null;
	const meal = (match[2] ?? "").trim();
	if (meal.length === 0) return null;
	return { meal, when: (match[1] ?? "").toLowerCase() === "after" ? "after" : "before" };
}

export function serialiseArrival(arrival: Arrival | null): string | null {
	if (!arrival) return null;
	const meal = arrival.meal.trim();
	return meal.length > 0 ? `${arrival.when} ${meal}` : null;
}

/** Wat er van de keuzes in de frontmatter te lezen valt. */
export interface ParsedList {
	draft: ListDraft;
	/** Zie ShoppingList.frozen. */
	frozen: string | null;
	/** Het mandje, nog op productnáám: paden kent de notitie niet. */
	basket: { name: string; entry: BasketEntry }[];
	nudge: { name: string; step: number }[];
	/** Overgeslagen, ook nog op naam. */
	skipped: string[];
	extras: Extra[];
}

/**
 * Leest de keuzes terug uit de frontmatter van een lijstnotitie.
 *
 * Tolerant, want dit is een notitie: winkels mogen als link of als kale naam
 * staan, een maaltijd zonder recept telt niet, en een mandje zonder product
 * ook niet. Levert null zonder bruikbare datum — dan is het geen lijst.
 */
export function parseList(frontmatter: Record<string, unknown>): ParsedList | null {
	if (asText(frontmatter[LIST_MARK]).trim() !== LIST_MARK_VALUE) return null;
	const date = dateText(frontmatter.date);
	if (!fromISODate(date)) return null;

	const shops: string[] = [];
	const rawShops = frontmatter.shops;
	const shopValues = Array.isArray(rawShops)
		? rawShops
		: asText(rawShops).split(",");
	for (const value of shopValues) {
		const shop = linkTarget(asText(value));
		if (shop.length > 0 && !hasShop(shops, shop)) shops.push(shop);
	}

	const meals: MealRef[] = [];
	for (const value of asArray(frontmatter.meals)) {
		const record = asRecord(value);
		const ref: MealRef = {
			date: dateText(record.date),
			meal: asText(record.meal).trim(),
			recipe: linkTarget(asText(record.recipe)),
		};
		if (!fromISODate(ref.date) || ref.recipe.length === 0) continue;
		if (!hasMeal(meals, ref)) meals.push(ref);
	}

	const basket: { name: string; entry: BasketEntry }[] = [];
	for (const value of asArray(frontmatter.basket)) {
		const record = asRecord(value);
		const name = linkTarget(asText(record.product));
		if (name.length === 0) continue;
		basket.push({
			name,
			entry: {
				count: record.count === undefined || record.count === null
					? null
					: parseCount(record.count),
				check: record.check === true,
			},
		});
	}

	const nudge: { name: string; step: number }[] = [];
	for (const value of asArray(frontmatter.nudge)) {
		const record = asRecord(value);
		const name = linkTarget(asText(record.product));
		const step = Number(record.step);
		if (name.length === 0 || !Number.isFinite(step) || step === 0) continue;
		nudge.push({ name, step: Math.round(step) });
	}

	const skipped: string[] = [];
	for (const value of asArray(frontmatter.skipped)) {
		const name = linkTarget(asText(value));
		if (name.length > 0 && !skipped.includes(name)) skipped.push(name);
	}

	return {
		draft: {
			date,
			arrival: parseArrival(frontmatter.arrives),
			shops,
			meals,
		},
		frozen: isNewer(frontmatter[FORMAT_KEY]) ? newerMessage(frontmatter[FORMAT_KEY]) : null,
		basket,
		nudge,
		skipped,
		extras: parseExtras(frontmatter.extras),
	};
}

// ------------------------------------------------------------- schrijven

/**
 * De frontmatter zoals hij in de notitie komt. Alleen velden die iets zeggen:
 * een leeg mandje staat er niet, een lijst zonder losse boodschappen ook niet.
 *
 * Producten als wikilink, zodat Obsidian ze bijwerkt als een product van naam
 * verandert, en zodat de notitie in de graph naar de producten wijst.
 */
export function serialiseList(
	list: ShoppingList,
	nameOf: (path: string) => string | null
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		[LIST_MARK]: LIST_MARK_VALUE,
		[FORMAT_KEY]: PANTRY_FORMAT,
		date: list.date,
	};
	const arrives = serialiseArrival(list.arrival);
	if (arrives) out.arrives = arrives;
	if (list.shops.length > 0) out.shops = list.shops.map((shop) => toLink(shop));
	if (list.meals.length > 0) {
		out.meals = list.meals.map((ref) => ({
			date: ref.date,
			meal: ref.meal,
			recipe: toLink(ref.recipe),
		}));
	}

	const basketEntry = (name: string, entry: BasketEntry): Record<string, unknown> => {
		const clean: Record<string, unknown> = { product: toLink(name) };
		if (entry.count !== null) clean.count = entry.count === "plus" ? "+" : entry.count;
		if (entry.check) clean.check = true;
		return clean;
	};
	const basket: Record<string, unknown>[] = [];
	for (const [path, entry] of list.basket) {
		const name = nameOf(path);
		if (!name) continue;
		basket.push(basketEntry(name, entry));
	}
	for (const { name, entry } of list.unresolved.basket) basket.push(basketEntry(name, entry));
	if (basket.length > 0) out.basket = basket;

	const nudge: Record<string, unknown>[] = [];
	for (const [path, step] of list.nudge) {
		const name = nameOf(path);
		if (!name || step === 0) continue;
		nudge.push({ product: toLink(name), step });
	}
	for (const { name, step } of list.unresolved.nudge) nudge.push({ product: toLink(name), step });
	if (nudge.length > 0) out.nudge = nudge;

	const skipped: string[] = [];
	for (const path of list.skipped) {
		const name = nameOf(path);
		if (name) skipped.push(toLink(name));
	}
	for (const name of list.unresolved.skipped) skipped.push(toLink(name));
	if (skipped.length > 0) out.skipped = skipped;

	if (list.extras.length > 0) {
		out.extras = list.extras.map((extra) => {
			const clean: Record<string, unknown> = {
				id: extra.id,
				name: extra.name,
				amount: extra.amount,
			};
			if (extra.shop) clean.shop = extra.shop;
			if (extra.shelf) clean.shelf = extra.shelf;
			return clean;
		});
	}

	return out;
}
