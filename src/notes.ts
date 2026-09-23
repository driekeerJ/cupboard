import { Notice, TFile, type Vault } from "obsidian";

/**
 * Gedeeld gereedschap voor notities die de plugin zelf schrijft.
 *
 * De rode draad: **een notitie is van de gebruiker.** Cupboard schrijft alleen in
 * het stuk dat het zelf heeft neergezet, en laat de rest ongemoeid — ook als
 * dat een handgeschreven regel, een Dataview-blok of een briefje aan de slager
 * is. Wat de plugin niet herkent, blijft staan.
 */

export { LINK_TARGET, linkTarget, linkTargets, toLink } from "./links";

/** Maakt de map van een pad aan als hij er nog niet is. */
export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder.length === 0) return;
	if (vault.getFolderByPath(folder)) return;
	await vault.createFolder(folder).catch(() => undefined);
}

/**
 * De grenzen van het stuk dat Cupboard beheert.
 *
 * HTML-commentaar en geen `%%`: een Obsidian-commentaarblok verbergt álles
 * ertussen, en dan is de boodschappenlijst onzichtbaar in leesweergave.
 */
export function regionMarkers(name: string): { start: string; end: string } {
	return { start: `<!-- pantry:${name} -->`, end: `<!-- /pantry:${name} -->` };
}

/**
 * Vervangt het gemarkeerde stuk, of plakt het onderaan als het er nog niet is.
 *
 * Nooit `String.replace` met de vervanging als patroon: `$&` en `$1` in de
 * tekst worden dan als terugverwijzing uitgelegd, en een dagnotitie of
 * productnaam met een dollarteken plakt zo het oude blok midden in het nieuwe.
 */
export function replaceRegion(content: string, name: string, body: string): string {
	const { start, end } = regionMarkers(name);
	const block = `${start}\n${body.trim()}\n${end}`;

	const from = content.indexOf(start);
	const to = content.indexOf(end);
	if (from !== -1 && to > from) {
		return content.slice(0, from) + block + content.slice(to + end.length);
	}

	const before = content.trimEnd();
	return before.length === 0 ? `${block}\n` : `${before}\n\n${block}\n`;
}

/** True als de notitie een stuk van Cupboard bevat. */
export function hasRegion(content: string, name: string): boolean {
	const { start, end } = regionMarkers(name);
	const from = content.indexOf(start);
	return from !== -1 && content.indexOf(end) > from;
}

/** Frontmatter-waarde uitlezen zonder de metadata-cache, voor eigendomscontrole. */
export function frontmatterValue(content: string, key: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return null;
	const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(match[1] ?? "");
	return line ? (line[1] ?? "").trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Meldt één keer per notitie dat de plugin er met haar handen vanaf blijft.
 *
 * Bij elke vaultwijziging opnieuw waarschuwen zou de melding tot ruis maken, en
 * ruis is precies waar je overheen leest.
 */
const warned = new Set<string>();

export function warnOnce(path: string, message: string): void {
	if (warned.has(path)) return;
	warned.add(path);
	console.error(`Cupboard: ${message} (${path})`);
	new Notice(`Cupboard ${message}.`);
}

/** Vergeet de waarschuwing, zodat een opgeloste situatie opnieuw gemeld kan worden. */
export function clearWarning(file: TFile): void {
	warned.delete(file.path);
}
