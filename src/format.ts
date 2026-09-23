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
export const PANTRY_FORMAT = 2;

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
