/**
 * Wat er van een onbekende waarde te lezen valt.
 *
 * Frontmatter is van de gebruiker: daar kan een getal staan, een lijst, of een
 * los object. `${value}` maakte van dat laatste stilletjes "[object Object]"
 * en zette dat vervolgens in je notitie. Beter een lege string dan onzin die
 * eruitziet als data.
 */
export function asText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return `${value}`;
	if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
	if (value instanceof Date) return value.toISOString();
	return "";
}
