import { TFile, TFolder, type Vault } from "obsidian";

/**
 * De markdownnotities in één map.
 *
 * `vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix))` scant de
 * hele vault om één map te lezen — bij een vault met honderden recepten gebeurt
 * dat bij elke herbouw van elke index opnieuw. Obsidians eigen richtlijn is
 * `getFolderByPath()`, en die functie kende deze plugin al.
 *
 * Bestaat de map niet, dan is het antwoord leeg: dat is iets anders dan "alles",
 * en een index die per ongeluk de hele vault leest is erger dan een lege.
 */
export function markdownIn(vault: Vault, folder: string): TFile[] {
	const root = vault.getFolderByPath(folder);
	if (!root) return [];

	const found: TFile[] = [];
	const walk = (dir: TFolder): void => {
		for (const child of dir.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === "md") found.push(child);
		}
	};
	walk(root);
	return found;
}
