import { TFile } from "obsidian";
import type PantryPlugin from "./main";
import {
	arrivalsByShop,
	earliest,
	mealIndex,
	type DatedStop,
	type Moment,
} from "./arrival";
import { addDays, atMidnight, fromISODate, toISODate } from "./date";
import { parseRecipeBody } from "./cook";
import {
	parseIngredient,
	withoutLinks,
	type ParsedIngredient,
} from "./ingredients";
import { linkTarget, servingsFor } from "./plan";
import type { Product } from "./products";
import { SPOON_ML, family, sameUnit, unitKey } from "./units";
import type { PlannedRecipe, WeekPlan } from "./types";
import { mealKey, type MealRef, type ShoppingList } from "./shopping-list";

/** Converts `amount from` into `to` binnen één maatfamilie, anders null. */
function inFamily(amount: number, from: string, to: string): number | null {
	const table = family(from);
	if (!table || table !== family(to)) return null;
	const a = table[unitKey(from)];
	const b = table[unitKey(to)];
	if (!a || !b) return null;
	return (amount * a) / b;
}

/**
 * Converts `amount from` into `to`, or null when the units are unrelated.
 *
 * Lepels horen bij geen enkele familie, en dat kostte de boodschappenlijst het
 * meeste: "2 el tomatenpuree" tegen een blikje van 70 g leverde nul op, en
 * zestien recepten met tomatenpuree vroegen samen om geen enkel blikje. Een
 * lepel gaat daarom eerst naar milliliter.
 *
 * Staat de verpakking in grammen, dan wordt 1 ml als 1 g gerekend. Dat is een
 * benadering, maar wel een die kleiner is dan de fout die er al in zit: een
 * afgestreken en een volle eetlepel schelen meer dan de dichtheid van stroop
 * en water. En de uitkomst wordt alsnog naar hele verpakkingen afgerond. De
 * brug geldt bewust *alleen* voor lepels: "240 ml water" tegen een product in
 * grammen blijft null, want daar is niets aan te benaderen.
 */
function convert(amount: number, from: string, to: string): number | null {
	const spoon = SPOON_ML[unitKey(from)];
	if (spoon !== undefined) {
		const ml = amount * spoon;
		return inFamily(ml, "ml", to) ?? inFamily(ml, "g", to);
	}
	return inFamily(amount, from, to);
}

/**
 * One recipe line expressed in the unit the user counts that product in.
 *
 * Deliberately returns 0 rather than a guess when it cannot tell: a splash of
 * oil is a presence question, not an amount question, and inventing a number
 * there would poison every figure downstream.
 */
export function inProductUnits(
	parsed: ParsedIngredient,
	product: Product,
	factor: number
): number {
	// Salt and oil are kept, not measured: the user said the amount does not
	// matter, so there is nothing to add here.
	if (!product.amountMatters) return 0;
	if (parsed.amount === null || parsed.kind === "vague") return 0;
	const amount = parsed.amount * factor;

	if (product.size) {
		// "500 g rijst" while he counts packs: needs the package size.
		if (parsed.unit) {
			const converted = convert(amount, parsed.unit, product.size.unit);
			if (converted !== null) return converted / product.size.amount;
		} else if (!family(product.size.unit)) {
			// De verpakking is in stuks opgegeven — `size: 12 stuks`, of kaal
			// `12`. Een regel zonder maat telt in diezelfde stuks, dus zes
			// eieren uit een doos van twaalf is een halve doos. Deze tak stond
			// eerst ná "geen maat" en werd daardoor nooit bereikt: de lijst
			// vroeg om zes dozen en de voorraad werd er zes lichter van.
			return amount / product.size.amount;
		}
	}

	// The recipe already speaks the counting unit, e.g. "2 tins".
	if (parsed.unit && sameUnit(parsed.unit, product.unit)) return amount;

	// "2 uien": no measure and no package to divide by, so the recipe counts
	// in the same pieces the user does.
	if (!parsed.unit) return amount;

	// Spoons of something counted in jars, and anything else we cannot express.
	return 0;
}

/**
 * One planned recipe line that asked for this product, kept so the shopper can
 * see where a figure came from. "4 spring onions" is unreadable on its own —
 * four bunches or four stalks? — and the recipe line is the only place that
 * ever said. The line is stored as the recipe wrote it, brackets stripped.
 */
export interface NeedSource {
	/** The recipe note's name. */
	recipe: string;
	/** The ingredient line, verbatim minus wikilink syntax. */
	line: string;
	/** What this line added, in the unit the product is counted in. 0 when
	 *  the amount could not be expressed there — a vague measure, a spoon of
	 *  something counted in jars. Those lines are kept and marked, never hidden:
	 *  an ingredient that counts for nothing is exactly the confusing one. */
	amount: number;
}

/** One ingredient line that resolved to a product, with what it asks for. */
export interface RecipeAmount {
	product: Product;
	/** The ingredient line, verbatim minus wikilink syntax. */
	line: string;
	/** In the unit the product is counted in; 0 when it cannot be expressed. */
	amount: number;
}

/**
 * Elke receptregel die een product raakt, omgerekend naar de eenheid waarin
 * dat product geteld wordt.
 *
 * Dit is de enige plek waar die som staat. Hij voedt zowel de boodschappenlijst
 * (`NeedIndex`) als de voorraadaftrek (`consumptionOf`); die twee hadden er
 * ieder een eigen kopie van, en een reparatie aan één kant liet de lijst en de
 * voorraad uit de pas lopen zonder dat iets dat meldde.
 */
export async function amountsForRecipe(
	plugin: PantryPlugin,
	file: TFile,
	factor: number
): Promise<RecipeAmount[]> {
	const content = await plugin.app.vault.cachedRead(file);
	const found: RecipeAmount[] = [];

	for (const line of parseRecipeBody(content).ingredients) {
		const parsed = parseIngredient(line);
		const product = plugin.products.match(parsed.name || parsed.raw);
		if (!product) continue;
		found.push({
			product,
			line: withoutLinks(line),
			amount: inProductUnits(parsed, product, factor),
		});
	}

	return found;
}

/**
 * Hoe sterk dit recept geschaald moet worden: gekookt voor zoveel personen,
 * gedeeld door waar het recept zelf voor geschreven is. Zegt het recept niets,
 * dan is er niets te schalen.
 */
export function factorFor(
	plugin: PantryPlugin,
	file: TFile,
	entry: PlannedRecipe
): number {
	const base = plugin.cook.baseServings(file);
	if (!base || base <= 0) return 1;
	return servingsFor(plugin, entry) / base;
}

/**
 * How much each product is needed for on top of its minimum, summed over every
 * recipe planned this week. Keyed by product path, always a whole number of the
 * unit he counts in — rounded up, because half a tin cannot be bought.
 */
export class NeedIndex {
	private plugin: PantryPlugin;
	private amounts: Map<string, number> = new Map();
	private origins: Map<string, NeedSource[]> = new Map();
	/** Het vroegste moment waarop een product in het plan gevraagd wordt. */
	private moments: Map<string, Moment> = new Map();
	/** Vanaf wanneer elke winkel in huis is, gesleuteld op naam in kleine letters. */
	private shopArrivals: Map<string, Moment> = new Map();
	/**
	 * Welke producten er per maaltijdvak gevraagd worden, gesleuteld op
	 * `datum|maaltijdindex`.
	 *
	 * Nodig omdat de planner per blokje wil weten of het te koken valt, en dat
	 * antwoord hangt aan dát moment — niet aan het vroegste moment waarop een
	 * product ergens in de week voorkomt.
	 */
	private slots: Map<string, Set<string>> = new Map();
	/**
	 * De winkels waar deze index voor rekent, in kleine letters — of null als
	 * hij voor het hele plan rekent en elk minimum telt. Zie `minimumOf`.
	 */
	private scopeShops: Set<string> | null = null;

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Hoeveel je hiervan altijd in huis wilt hebben — déze keer.
	 *
	 * Voor het hele plan (All stock, de planner) is dat gewoon het minimum van
	 * het product. Voor een boodschappenlijst telt het minimum alleen voor een
	 * product uit een winkel die op de lijst staat: dat is wat "de standaard
	 * boodschappen van de Lidl" betekent. Een lijst zonder winkels heeft dus
	 * geen minimums — alleen wat de gekozen maaltijden vragen.
	 */
	minimumOf(product: Product): number {
		if (this.scopeShops === null) return product.minimum;
		const inScope = product.shops.some((shop) =>
			this.scopeShops?.has(shop.trim().toLowerCase())
		);
		return inScope ? product.minimum : 0;
	}

	get(product: Product): number {
		return this.amounts.get(product.path) ?? 0;
	}

	/** Every planned recipe line that asked for this product, in plan order. */
	sources(product: Product): NeedSource[] {
		return this.origins.get(product.path) ?? [];
	}

	/**
	 * Wanneer dit product voor het eerst op tafel moet staan, of null als het
	 * nergens in het plan voorkomt. Dat laatste is gewone voorraadaanvulling:
	 * die heeft geen deadline.
	 */
	momentFor(product: Product): Moment | null {
		return this.moments.get(product.path) ?? null;
	}

	/** De boodschappenmomenten uit het plan, per winkel het vroegste. */
	arrivals(): Map<string, Moment> {
		return this.shopArrivals;
	}

	/**
	 * De producten die dit maaltijdvak vraagt, voor zover ze een hoeveelheid
	 * opleveren. Regels die nergens op uitkomen — een snuf zout, een vage maat
	 * — staan er niet bij: die zeggen niets over of je dit kunt koken.
	 */
	productsAt(date: string, meal: number): Product[] {
		const paths = this.slots.get(`${date}|${meal}`);
		if (!paths) return [];
		return [...paths]
			.map((path) => this.plugin.products.byPath(path))
			.filter((product): product is Product => product !== null);
	}

	/**
	 * Leest het plan van `from` tot en met `from + days - 1`.
	 *
	 * Een rollende horizon en niet "deze week", want boodschappen doen loopt
	 * niet met de weeknotitie mee: wie op woensdag bestelt voor tot en met
	 * volgende week dinsdag kijkt over de weekgrens. Er worden dus zoveel
	 * weeknotities gelezen als de horizon raakt.
	 */
	async rebuild(from: Date, days?: number): Promise<void> {
		const span = Math.max(1, days ?? this.plugin.settings.horizonDays);
		const start = atMidnight(from);
		const first = toISODate(start);
		const last = toISODate(addDays(start, span - 1));

		this.origins = new Map();
		this.moments = new Map();
		this.slots = new Map();

		const raw = new Map<string, number>();
		const stops: DatedStop[] = [];

		this.scopeShops = null;
		for (const plan of await this.plugin.plans.covering(start, span)) {
			await this.collect(plan, first, last, raw, stops, null);
		}

		this.shopArrivals = arrivalsByShop(stops, this.plugin.settings.meals);
		this.amounts = roundUp(raw);
	}

	/**
	 * Rekent voor één boodschappenlijst: alleen de maaltijden die erop staan,
	 * en alleen de minimums van de winkels die erop staan.
	 *
	 * Geen boodschappenmomenten: de lijst ís het moment, en binnen één lijst
	 * is elke winkel op tijd. Welke winkel een product krijgt beslist de lijst
	 * zelf (zie `ShoppingLists.shopFor`).
	 */
	async rebuildFor(list: ShoppingList): Promise<void> {
		this.origins = new Map();
		this.moments = new Map();
		this.slots = new Map();
		this.shopArrivals = new Map();
		this.scopeShops = new Set(list.shops.map((shop) => shop.trim().toLowerCase()));

		const raw = new Map<string, number>();
		const wanted = new Set(list.meals.map(mealKey));
		if (wanted.size > 0) {
			const dates = list.meals.map((ref) => ref.date).sort();
			const first = fromISODate(dates[0] ?? "") ?? atMidnight(new Date());
			const last = fromISODate(dates[dates.length - 1] ?? "") ?? first;
			const span = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1);
			for (const plan of await this.plugin.plans.covering(first, span)) {
				await this.collect(plan, toISODate(first), toISODate(last), raw, [], wanted);
			}
		}

		this.amounts = roundUp(raw);
	}

	/**
	 * Telt de maaltijden van een weeknotitie op. `only` beperkt dat tot de
	 * maaltijden van een lijst (sleutels uit `mealKey`); null telt alles.
	 */
	private async collect(
		plan: WeekPlan,
		first: string,
		last: string,
		raw: Map<string, number>,
		stops: DatedStop[],
		only: Set<string> | null
	): Promise<void> {
		const meals = this.plugin.settings.meals;

		for (const day of plan.days) {
			// De weeknotitie loopt van maandag tot zondag, de horizon niet: een
			// dag die er buiten valt telt niet mee, ook niet als hij in dezelfde
			// notitie staat.
			if (day.date < first || day.date > last) continue;

			for (const stop of day.shopping ?? []) {
				stops.push({ ...stop, date: day.date });
			}

			for (const meal of day.meals) {
				// De maaltijd staat als naam in het blok; de volgorde die de
				// gebruiker instelt bepaalt wat "eerder op de dag" betekent.
				const index = mealIndex(meals, meal.meal);
				const moment: Moment = {
					date: day.date,
					meal: index === -1 ? 0 : index,
				};

				for (const entry of meal.recipes) {
					// Ticked off, either way: an eaten meal already took its
					// ingredients out of the house and a skipped one never will.
					if (entry.status) continue;
					if (only && !only.has(mealKey(refOf(day.date, meal.meal, entry.recipe)))) {
						continue;
					}
					// The plan stores the link as written, brackets and all.
					const file = this.plugin.cook.file(linkTarget(entry.recipe));
					if (!file) continue;
					await this.addRecipe(
						raw,
						file,
						factorFor(this.plugin, file, entry),
						moment,
						`${day.date}|${moment.meal}`
					);
				}
			}
		}
	}

	private async addRecipe(
		into: Map<string, number>,
		file: TFile,
		factor: number,
		moment: Moment,
		slot: string
	): Promise<void> {
		for (const { product, line, amount } of await amountsForRecipe(
			this.plugin,
			file,
			factor
		)) {
			// Recorded before the zero check: a line that contributes nothing
			// still tells the shopper what the recipe actually asks for.
			const seen = this.origins.get(product.path) ?? [];
			seen.push({ recipe: file.basename, line, amount });
			this.origins.set(product.path, seen);

			if (amount <= 0) continue;
			into.set(product.path, (into.get(product.path) ?? 0) + amount);

			// Alleen een regel die echt iets vraagt zet een deadline. Een vage
			// maat draagt nul bij aan de lijst en mag er dus ook geen winkel
			// mee verzetten.
			const best = earliest(this.moments.get(product.path) ?? null, moment);
			if (best) this.moments.set(product.path, best);

			const here = this.slots.get(slot) ?? new Set<string>();
			here.add(product.path);
			this.slots.set(slot, here);
		}
	}
}

/** Een geplande maaltijd als verwijzing, zoals een boodschappenlijst hem bewaart. */
export function refOf(date: string, meal: string, recipe: string): MealRef {
	return { date, meal, recipe: linkTarget(recipe) };
}

/** Naar hele eenheden omhoog: een halve blik kun je niet kopen. */
function roundUp(raw: Map<string, number>): Map<string, number> {
	const rounded = new Map<string, number>();
	raw.forEach((amount, path) => {
		const whole = Math.ceil(amount - 1e-9);
		if (whole > 0) rounded.set(path, whole);
	});
	return rounded;
}
