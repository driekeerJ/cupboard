import type PantryPlugin from "./main";
import { assignShop, type Assignment } from "./arrival";
import { toBuy, type Product } from "./products";

/**
 * Waar dit product volgens het hele plan gekocht moet worden: de eerste
 * voorkeurswinkel die op tijd is voor het vroegste moment waarop het nodig
 * is. Dit is wat de planner gebruikt om te waarschuwen; een boodschappenlijst
 * kiest zelf tussen háár winkels.
 */
export function assignmentFor(plugin: PantryPlugin, product: Product): Assignment {
	return assignShop(product.shops, plugin.needs.momentFor(product), plugin.needs.arrivals());
}

/**
 * De producten die dit maaltijdvak vraagt en die je er niet op tijd voor in
 * huis krijgt.
 *
 * Drie dingen moeten waar zijn: het recept vraagt erom, je hebt het niet al
 * staan, en geen van de winkels waar het te krijgen is komt op tijd langs. Dat
 * eerste is waarom een snuf zout hier nooit opduikt, en dat tweede is waarom
 * "ik heb het al" een geldige oplossing is — je telt het en de melding gaat weg.
 *
 * Het moment is dát van dit vak, niet het vroegste moment van het product:
 * kikkererwten die woensdag én volgende week dinsdag nodig zijn, zijn alleen
 * woensdag een probleem.
 *
 * De boodschappenmomenten komen uit het weekplan, en daar zet elke
 * boodschappenlijst het hare neer — dus een lijst voor de Lidl op woensdag
 * maakt een maaltijd op donderdag weer wit.
 */
export function lateProducts(
	plugin: PantryPlugin,
	date: string,
	meal: number
): { product: Product; shop: string }[] {
	const moment = { date, meal };
	const arrivals = plugin.needs.arrivals();
	const late: { product: Product; shop: string }[] = [];

	for (const product of plugin.needs.productsAt(date, meal)) {
		const amount = toBuy(product, plugin.needs.get(product));
		// null is "nooit geteld": dan weet je niet of je het hebt, en dat is
		// geen reden om te zwijgen.
		if (amount !== null && amount <= 0) continue;
		const assignment = assignShop(product.shops, moment, arrivals);
		if (assignment.late) late.push({ product, shop: assignment.shop });
	}

	return late.sort((a, b) => a.product.name.localeCompare(b.product.name));
}
