/**
 * Welke versie van de notitieformaten deze build schrijft, en wanneer hij
 * gebouwd is.
 *
 * Twee apparaten, één vault, en Obsidian Sync neemt de plugin zelf niet
 * automatisch mee: de telefoon kan weken op een oudere build draaien dan de
 * Mac. Een oudere build die een nieuwere notitie herschrijft, gooit stil weg
 * wat hij niet kent. Daarom staat in elke notitie die Cupboard schrijft het
 * formaatnummer, en weigert een build die een hoger nummer tegenkomt te
 * schrijven — met een banner op Home die zegt: werk Cupboard op dit apparaat bij.
 *
 * Verhoog `PANTRY_FORMAT` alleen als een oudere build een nieuwe notitie
 * verkeerd zou lezen of iets zou weggooien. Een extra optioneel veld is geen
 * reden; een veld dat van betekenis verandert wel.
 */
export const PANTRY_FORMAT = 3;

/**
 * Het formaat dat elke build sinds de formaatcontrole leest: weekplannen, en
 * boodschappenlijsten waarvan de standaardlijsten met de winkels meegaan.
 *
 * Een notitie draagt het láágste nummer dat hem goed leest, niet het hoogste
 * dat deze build kent. Formaat 3 bracht alleen `staples` op de lijst; een
 * weekplan en een gewone lijst zijn er niet door veranderd. Kregen die toch
 * een 3, dan bevroor een telefoon die nog niet bijgewerkt is op élke notitie,
 * voor een veld dat er niet eens in staat — en werd elke bestaande notitie
 * herschreven zonder dat er iets aan veranderd was.
 */
export const WIDE_FORMAT = 2;

/**
 * Een lijst met eigen `staples`: standaardlijsten van andere winkels dan waar
 * je heen gaat. Een oudere build bewaart het veld wel, maar rekent zonder —
 * en toont dan een kortere lijst dan je thuis hebt geteld. Dat is verkeerd
 * lezen, dus die build mag er niet aan komen.
 */
export const STAPLES_FORMAT = 3;

/** De frontmatter-sleutel (lijsten) en YAML-sleutel (planblok) voor het formaat. */
export const FORMAT_KEY = "format";

declare const PANTRY_BUILD: string | undefined;

/** Tijdstip van de build, door esbuild ingevuld; "dev" buiten de bundel om. */
export const BUILD_STAMP: string =
	typeof PANTRY_BUILD === "string" && PANTRY_BUILD.length > 0 ? PANTRY_BUILD : "dev";

/** Het formaatnummer uit een notitie: ontbreekt het, dan is het 1 (van vóór dit veld). */
export function formatOf(value: unknown): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : 1;
}

/** Geschreven door een nieuwere Cupboard dan deze build: niet aanraken. */
export function isNewer(value: unknown): boolean {
	return formatOf(value) > PANTRY_FORMAT;
}

export function newerMessage(value: unknown): string {
	return `written by a newer Cupboard (format ${formatOf(value)}, this build reads ${PANTRY_FORMAT}) — update Cupboard on this device`;
}
