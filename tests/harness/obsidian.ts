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
import { dump, load } from "./yaml";

export class TAbstractFile {
	path = "";
	name = "";
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "md";
}

/**
 * Echte klassen, geen platte objecten: `markdownIn()` in src/folder.ts leunt op
 * `instanceof`, zoals Obsidians eigen richtlijn voorschrijft.
 */
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

/** Alleen aanwezig omdat plan.ts en settings.ts ze importeren; nooit gebruikt. */
export class MarkdownView {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class App {}

/**
 * Obsidians `debounce`, maar dan meteen: in een test wil je het resultaat van
 * een schrijfactie in dezelfde stap kunnen nakijken, niet anderhalve seconde
 * later. `cancel()` hoort erbij omdat de plugin hem bij `onunload` aanroept.
 */
export function debounce<T extends unknown[]>(
	fn: (...args: T) => unknown
): ((...args: T) => void) & { cancel: () => void } {
	const run = (...args: T): void => {
		fn(...args);
	};
	run.cancel = (): void => undefined;
	return run;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}

export function parseYaml(value: string): unknown {
	return load(value) ?? {};
}

export function stringifyYaml(value: unknown): string {
	return dump(value);
}
