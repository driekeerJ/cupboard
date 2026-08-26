/**
 * Scenario's staan als markdownbestanden op schijf, niet als JS-objecten.
 *
 * `tests/fixtures/<scenario>/Products/Rijst.md` is daardoor gewoon een vault:
 * te openen in Obsidian, te lezen zonder de test erbij, en het past bij de
 * file-over-app-lijn van de plugin zelf. Een scenario aanpassen is een notitie
 * aanpassen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function walk(dir: string, into: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, into);
		else if (entry.name.endsWith(".md")) into.push(full);
	}
	return into;
}

/** Alle notities van één scenario, als `{ vaultpad: markdown }`. */
export function loadFixture(scenario: string): Record<string, string> {
	const base = join(ROOT, scenario);
	const files: Record<string, string> = {};
	for (const full of walk(base, [])) {
		files[relative(base, full).split(/[\\/]/).join("/")] = readFileSync(full, "utf8");
	}
	return files;
}
