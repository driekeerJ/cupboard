/**
 * Losse boodschappen: wat je onderweg bedenkt en wat geen product is.
 *
 * Batterijen, bloemen, een tweede zak chips omdat er visite komt. Ze horen op
 * de lijst en verder nergens: er komt geen productnotitie van, ze tellen niet
 * mee in de voorraad, en ze zeggen niets over volgende week. Precies dat maakt
 * ze goedkoop genoeg om ze op te schrijven zodra je eraan denkt.
 *
 * Waarom ze in `shopping.json` staan en niet in markdown: een los regeltje
 * hoort bij deze ronde en niet bij de vault. Vink je het af, dan is het weg —
 * er is dus nooit iets om later op te ruimen. Datzelfde bestand draagt al het
 * mandje en de ± aanpassingen, en gaat mee met Obsidian Sync, dus je telefoon
 * en je laptop zien hetzelfde lijstje.
 */

export interface Extra {
	/** Eigen sleutel: twee keer "melk" is twee regels, geen botsing. */
	id: string;
	name: string;
	/** Hoeveel je er wilt; altijd minstens 1. */
	amount: number;
	/** Leeg betekent: geen winkel gekozen, dus onderaan bij de rest. */
	shop: string;
	/** Leeg betekent: onbekend schap, dus onderaan in die winkel. */
	shelf: string;
}

/** Wat een regel is als je er niets bij zegt. */
export const DEFAULT_EXTRA_AMOUNT = 1;

export function newExtraId(): string {
	const stamp = Date.now().toString(36);
	const noise = Math.random().toString(36).slice(2, 8);
	return `x${stamp}${noise}`;
}

/**
 * Leest de losse boodschappen terug uit het rondebestand.
 *
 * Alles wat geen naam heeft verdwijnt: dit bestand staat in de vault, kan door
 * sync half aankomen en kan met de hand aangeraakt zijn. Een regel zonder naam
 * is niets waard op een lijst, en een id verzinnen we er desnoods bij.
 */
export function parseExtras(raw: unknown): Extra[] {
	if (!Array.isArray(raw)) return [];

	const extras: Extra[] = [];
	const seen = new Set<string>();

	for (const value of raw) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;

		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (name.length === 0) continue;

		const amount = Number(entry.amount);
		const id = typeof entry.id === "string" && entry.id.length > 0
			? entry.id
			: newExtraId();
		if (seen.has(id)) continue;
		seen.add(id);

		extras.push({
			id,
			name,
			amount:
				Number.isFinite(amount) && amount > 0
					? Math.round(amount)
					: DEFAULT_EXTRA_AMOUNT,
			shop: typeof entry.shop === "string" ? entry.shop.trim() : "",
			shelf: typeof entry.shelf === "string" ? entry.shelf.trim() : "",
		});
	}

	return extras;
}

/**
 * Hoe een losse boodschap in de notitie staat: `Batterijen · 2`.
 *
 * Zonder wikilink, want er is geen notitie om heen te wijzen. Het is dezelfde
 * tekst die het scherm toont, zodat je in de winkel niet hoeft te raden of
 * die regel uit de app of uit je hoofd kwam.
 */
export function extraLabel(extra: Extra): string {
	return extra.amount > 1 ? `${extra.name} · ${extra.amount}` : extra.name;
}
