/**
 * A number out of frontmatter or a text field, or null when it does not say one.
 *
 * Frontmatter en invoervelden zijn met de hand getypt, dus er kan van alles
 * staan — een getal, "2,5", een lijst, niets. Alles wat geen getal is levert
 * null op en geen 0: "nooit ingevuld" en "nul" zijn verschillende antwoorden.
 *
 * De komma stond op negen plaatsen los uitgeschreven, elk met een net iets
 * andere volgorde van trimmen, vervangen en controleren. Eén regel.
 */
export function parseNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const parsed = Number(trimmed.replace(",", "."));
	return Number.isFinite(parsed) ? parsed : null;
}
