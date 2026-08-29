/**
 * Wikilinks lezen en schrijven. Eén regel, op één plek.
 *
 * Dit stond in vijf varianten door de plugin heen, elk met een eigen idee over
 * `|weergave` en `#kop` — de een gaf `Rijst|de rijst` terug waar de ander
 * `Rijst` gaf. Bewust zonder import uit `obsidian`, zodat ook de modules die
 * puur tekst bewerken hem kunnen gebruiken.
 */
export const LINK_TARGET = /\[\[([^\]|#]+)/;

/** Turns "[[Chickpea stew|stew]]" into "Chickpea stew". */
export function linkTarget(value: string): string {
	const match = new RegExp(`^${LINK_TARGET.source}`).exec(value.trim());
	return (match?.[1] ?? value).trim();
}

export function toLink(name: string): string {
	return `[[${name}]]`;
}

/** Alle wikilinkdoelen in een regel, in volgorde. */
export function linkTargets(line: string): string[] {
	const found: string[] = [];
	const pattern = new RegExp(LINK_TARGET.source, "g");
	let match = pattern.exec(line);
	while (match) {
		const inner = (match[1] ?? "").trim();
		if (inner.length > 0) found.push(inner);
		match = pattern.exec(line);
	}
	return found;
}

/**
 * `[[Rijst]]` en `[[Rijst|de rijst]]` worden wat een lezer zou zeggen.
 *
 * Alleen voor weergave. Het matchen gebeurt op de ruwe regel, want een
 * expliciete link is de schrijver die precies is en die mag je niet
 * wegpoetsen voordat je hem gebruikt hebt.
 */
export function withoutLinks(line: string): string {
	return line.replace(/\[\[([^\]]+)\]\]/g, (_all, inner: string) => {
		const parts = inner.split("|");
		return (parts[1] ?? parts[0] ?? "").trim();
	});
}
