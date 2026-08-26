/**
 * Wat de plugin van Obsidian gebruikt, nagebouwd.
 *
 * De kern draait op **zes** dingen: `vault.cachedRead`,
 * `metadataCache.getFileCache().frontmatter`, `fileManager.processFrontMatter`,
 * `metadataCache.getFirstLinkpathDest`, `vault.getMarkdownFiles` en
 * `vault.getFileByPath`. Die zitten in `vault.ts`. Dit bestand is alleen de
 * module `obsidian` zelf: de handvol klassen en functies die de kernbestanden
 * importeren.
 *
 * Waarom een module-stub en geen bundel: Node vervangt bij het draaien van de
 * tests de specifier "obsidian" door dit bestand (zie `register.mjs`), zodat
 * `products.ts`, `needs.ts`, `list.ts` en `consume.ts` **ongewijzigd** draaien.
 * Er is dus geen tweede versie van de code die kan gaan afwijken.
 */
import { dump, load } from "js-yaml";

export class TAbstractFile {
	path = "";
	name = "";
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "md";
}

export class TFolder extends TAbstractFile {}

/** Alleen aanwezig omdat plan.ts en settings.ts ze importeren; nooit gebruikt. */
export class MarkdownView {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class App {}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}

export function parseYaml(value: string): unknown {
	return load(value) ?? {};
}

export function stringifyYaml(value: unknown): string {
	// Obsidian schrijft blokstijl zonder regelafbreking; js-yaml doet dat met
	// lineWidth -1. Zonder dat knipt hij lange receptnamen af en klopt de
	// snapshot van de boodschappennotitie niet meer.
	return dump(value, { lineWidth: -1, noRefs: true });
}
