/**
 * Eén regel voor "past deze tekst bij wat je typt".
 *
 * Er waren er drie: producten en voorraad zochten op naam plus aliassen, en de
 * receptenlijst alleen op de titel. Zoek je "kikkererwt", dan gaf de zijbalk
 * niets terug tenzij het recept zo *heet* — terwijl Obsidians eigen zoekfunctie
 * body én frontmatter leest. De hooiberg hoort breder te zijn dan de naam.
 */
export function matchesQuery(query: string, haystack: readonly string[]): boolean {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return true;
	return haystack.some((value) => value.toLowerCase().includes(needle));
}
