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

/**
 * Trimmed values, first spelling wins, case-insensitive.
 *
 * Every picker in the plugin builds its chips from two or three lists stuck
 * together — the shop's own shelves plus whatever other products mention —
 * and those lists overlap. Without this you get "Koeling" twice.
 */
export function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	values.forEach((value) => {
		const key = value.trim().toLowerCase();
		if (key.length === 0 || seen.has(key)) return;
		seen.add(key);
		kept.push(value.trim());
	});
	return kept;
}
