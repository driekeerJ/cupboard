/**
 * Een boodschappenronde: wat je déze keer haalt, los van het weekplan.
 *
 * Meestal volgt de lijst het weekplan: alles wat de geplande maaltijden
 * vragen, plus alles wat onder zijn minimum zit. Maar soms ga je even de deur
 * uit voor één recept en de vaste Lidl-boodschappen, en dan is die volledige
 * lijst ruis. Een ronde zegt welke invoer er meetelt:
 *
 * - **recepten**, elk met een aantal porties — ze hoeven niet in het weekplan
 *   te staan en komen er ook niet in; dit is een ronde, geen maaltijd;
 * - **winkels** — voor elke gekozen winkel tellen de producten mee die daar
 *   liggen én een minimum hebben: de "standaard boodschappen" van die winkel.
 *
 * Zolang er een ronde staat, vervangt hij het weekplan: het Voorraad-scherm,
 * het Boodschappen-scherm en `Groceries.md` laten alleen zien wat de ronde
 * vraagt. Een lege ronde is géén ronde — dan geldt het weekplan weer.
 *
 * De ronde staat in `Pantry/shopping.json`, naast het mandje en de losse
 * boodschappen, want hij hoort bij deze ronde en niet bij de vault. Hij blijft
 * staan tot je hem wist, ook na een herstart en op je andere apparaat.
 */

export interface RoundRecipe {
	/** Vaultpad van de receptnotitie. */
	path: string;
	/** Voor hoeveel personen; wordt tegen `servings` van het recept gezet. */
	servings: number;
}

export interface Round {
	recipes: RoundRecipe[];
	/** Winkelnamen zoals ze in de winkelnotitie staan. */
	shops: string[];
}

/** De kleinste stap van de portie-stepper: een kind eet een halve. */
export const SERVINGS_STEP = 0.5;

/** Meer dan dit is geen ronde meer maar een feest — en een tikfout. */
const MAX_SERVINGS = 50;

export function emptyRound(): Round {
	return { recipes: [], shops: [] };
}

/** Een ronde zonder invoer is geen ronde: dan geldt het weekplan. */
export function isActiveRound(round: Round | null): round is Round {
	return round !== null && (round.recipes.length > 0 || round.shops.length > 0);
}

/** Altijd positief, in halve stappen, en nooit belachelijk groot. */
export function cleanServings(value: number): number {
	if (!Number.isFinite(value)) return 1;
	const stepped = Math.round(value / SERVINGS_STEP) * SERVINGS_STEP;
	return Math.min(MAX_SERVINGS, Math.max(SERVINGS_STEP, stepped));
}

function sameShop(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function hasShop(round: Round, shop: string): boolean {
	return round.shops.some((known) => sameShop(known, shop));
}

export function recipeIn(round: Round, path: string): RoundRecipe | null {
	return round.recipes.find((entry) => entry.path === path) ?? null;
}

/**
 * Leest de ronde terug uit het rondebestand.
 *
 * Alles wat geen pad of naam is verdwijnt; een portie die niet klopt wordt
 * rechtgezet in plaats van weggegooid, want het recept zelf is wat je koos.
 * Levert null als er niets bruikbaars staat — dat is dezelfde toestand als
 * "geen ronde", en zo hoort een half aangekomen bestand zich ook te gedragen.
 */
export function parseRound(raw: unknown): Round | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;

	const recipes: RoundRecipe[] = [];
	const seen = new Set<string>();
	if (Array.isArray(entry.recipes)) {
		for (const value of entry.recipes) {
			if (!value || typeof value !== "object") continue;
			const item = value as Record<string, unknown>;
			const path = typeof item.path === "string" ? item.path.trim() : "";
			if (path.length === 0 || seen.has(path)) continue;
			seen.add(path);
			recipes.push({ path, servings: cleanServings(Number(item.servings)) });
		}
	}

	const shops: string[] = [];
	if (Array.isArray(entry.shops)) {
		for (const value of entry.shops) {
			if (typeof value !== "string") continue;
			const shop = value.trim();
			if (shop.length === 0 || shops.some((known) => sameShop(known, shop))) continue;
			shops.push(shop);
		}
	}

	const round = { recipes, shops };
	return isActiveRound(round) ? round : null;
}

/**
 * De ronde in één regel, voor de banner en de tegel: "Rijst met ui · Lidl".
 *
 * Recepten eerst, dan winkels; namen en geen paden, want dit staat op je
 * scherm terwijl je je jas aantrekt.
 */
export function roundLabel(
	round: Round,
	recipeName: (path: string) => string
): string {
	return [...round.recipes.map((entry) => recipeName(entry.path)), ...round.shops].join(
		" · "
	);
}

/** De naam uit een vaultpad, als de notitie zelf niet meer te vinden is. */
export function pathName(path: string): string {
	const last = path.split("/").pop() ?? path;
	return last.replace(/\.md$/i, "");
}
