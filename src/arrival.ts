import { addDays, fromISODate, toISODate } from "./date";
import type { MealType, ShoppingStop } from "./types";

/**
 * Een punt in het plan: een dag, en de hoeveelste maaltijd van die dag.
 *
 * De maaltijd is een index in `settings.meals`, niet een naam: de gebruiker
 * bepaalt zelf welke maaltijden er zijn en in welke volgorde, en die volgorde
 * is het enige wat "eerder" betekent binnen een dag. Een plugin die "ontbijt"
 * of "avondeten" zou kennen, kent alleen Nederlandse of Engelse huishoudens.
 */
export interface Moment {
	/** ISO-datum, yyyy-mm-dd. */
	date: string;
	/** Index in `settings.meals`. 0 is de eerste maaltijd van de dag. */
	meal: number;
}

/** Een boodschappenmoment met de dag waar het in het plan op staat. */
export interface DatedStop extends ShoppingStop {
	/** ISO-datum van de dag in het weekplan. */
	date: string;
}

/** Negatief als `a` eerder ligt: datum eerst, dan de maaltijd binnen die dag. */
export function compareMoments(a: Moment, b: Moment): number {
	if (a.date !== b.date) return a.date < b.date ? -1 : 1;
	return a.meal - b.meal;
}

/** Het vroegste van twee momenten; `null` telt als "nog geen". */
export function earliest(a: Moment | null, b: Moment | null): Moment | null {
	if (!a) return b;
	if (!b) return a;
	return compareMoments(a, b) <= 0 ? a : b;
}

/**
 * Zoekt een maaltijd op naam of id, hoofdletterongevoelig. Geeft -1 als de
 * naam niet bestaat: het blok is met de hand te bewerken en een maaltijd kan
 * hernoemd zijn, dus een onbekende naam mag niet stil als iets anders gelden.
 */
export function mealIndex(meals: MealType[], value: string): number {
	const key = value.trim().toLowerCase();
	if (key.length === 0) return -1;
	return meals.findIndex(
		(meal) => meal.name.toLowerCase() === key || meal.id.toLowerCase() === key
	);
}

/**
 * Het punt in het plan waarop een boodschappenmoment valt.
 *
 * `after` op de laatste maaltijd van de dag schuift door naar de eerste
 * maaltijd van de volgende dag: een bezorging ná het avondeten is er voor het
 * ontbijt, niet voor dat avondeten.
 *
 * Een onbekende of ontbrekende maaltijdnaam telt als het begin van de dag.
 * Dat is de enige lezing die niets stilletjes tekort doet: hij maakt de winkel
 * eerder beschikbaar, en een boodschap die je al in huis hebt is een kleiner
 * probleem dan een maaltijd waarvoor je hem nog niet had.
 */
export function stopMoment(stop: DatedStop, meals: MealType[]): Moment {
	const date = fromISODate(stop.date);
	const day = date ? toISODate(date) : stop.date;
	const index = mealIndex(meals, stop.meal ?? "");
	if (index === -1) return { date: day, meal: 0 };
	if (stop.when !== "after") return { date: day, meal: index };
	if (index + 1 < meals.length) return { date: day, meal: index + 1 };
	const next = date ? addDays(date, 1) : null;
	return { date: next ? toISODate(next) : day, meal: 0 };
}

/**
 * Het vroegste boodschappenmoment per winkel, gesleuteld op de winkelnaam in
 * kleine letters.
 *
 * Komt een winkel meerdere keren voor, dan telt de eerste: vanaf dát moment
 * staat haar spul in huis. Een winkel zonder moment komt niet in de kaart voor
 * en geldt daarmee als altijd beschikbaar — er staat niets in het plan om op
 * te wachten.
 */
export function arrivalsByShop(
	stops: DatedStop[],
	meals: MealType[]
): Map<string, Moment> {
	const found = new Map<string, Moment>();
	for (const stop of stops) {
		const key = stop.shop.trim().toLowerCase();
		if (key.length === 0) continue;
		const best = earliest(found.get(key) ?? null, stopMoment(stop, meals));
		if (best) found.set(key, best);
	}
	return found;
}

/**
 * Is deze winkel op tijd voor dit moment?
 *
 * Geen aankomstmoment betekent: altijd. Geen nodig-moment betekent ook altijd,
 * want een product dat nergens in het plan voorkomt heeft geen deadline — dat
 * is gewone voorraadaanvulling en die mag rustig vrijdag komen.
 */
export function arrivesInTime(
	arrival: Moment | null,
	need: Moment | null
): boolean {
	if (!arrival) return true;
	if (!need) return true;
	return compareMoments(arrival, need) <= 0;
}

/** Wat er van de toewijzing terugkomt: waar het heen gaat, en of het te laat is. */
export interface Assignment {
	shop: string;
	/**
	 * Geen enkele winkel is op tijd. Het product blijft bij zijn voorkeur
	 * staan, want het ergens anders neerzetten maakt het niet op tijd — het
	 * maakt alleen onzichtbaar dat er iets niet klopt.
	 */
	late: boolean;
	/** Waar het volgens het product zelf had moeten liggen, als dat verschilt. */
	movedFrom?: string;
}

/**
 * Waar dit product gekocht moet worden als het op `need` in huis moet zijn.
 *
 * De lijst is de voorkeursvolgorde: de eerste winkel die op tijd is, wint. Dat
 * is voorspelbaar — jij bepaalt per product waar het bij voorkeur vandaan komt
 * — en het verklaart zichzelf, want de volgorde staat in de productnotitie.
 *
 * Redt geen enkele winkel uit de lijst het, dan blijft het bij de eerste staan
 * met `late`. Het naar een winkel duwen waar dit product niet te krijgen is,
 * maakt het niet op tijd; het maakt alleen onzichtbaar dat er iets niet kan.
 * Dat is precies het moment waarop de planner moet waarschuwen.
 */
export function assignShop(
	preferred: string[],
	need: Moment | null,
	arrivals: Map<string, Moment>
): Assignment {
	const shops = preferred.map((shop) => shop.trim()).filter(Boolean);
	const first = shops[0];
	if (!first) return { shop: "", late: false };

	for (const shop of shops) {
		const arrival = arrivals.get(shop.toLowerCase()) ?? null;
		if (!arrivesInTime(arrival, need)) continue;
		return shop === first
			? { shop, late: false }
			: { shop, late: false, movedFrom: first };
	}

	return { shop: first, late: true };
}
