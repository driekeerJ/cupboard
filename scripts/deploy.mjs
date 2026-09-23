/**
 * Kopieert de gebouwde plugin naar de vault.
 *
 * Sinds de bron uit de vault is gehaald staan er twee plekken: hier de repo
 * (src, tests, node_modules, git) en in de vault alleen wat Obsidian laadt —
 * main.js, manifest.json, styles.css, plus de data.json die van de gebruiker
 * is en hier niets te zoeken heeft.
 *
 * Het pad naar de vault verschilt per omgeving, dus het wordt gezocht in
 * plaats van vastgelegd:
 *
 *   1. $PANTRY_VAULT, als die gezet is — dat wint altijd.
 *   2. ~/Obsidian/Digitale_voorraadkast, de gewone plek op de Mac.
 *   3. ~/mnt/Obsidian--Digitale_voorraadkast, zoals een cloudsessie hem ziet.
 *
 * Wordt er niets gevonden, dan stopt het script met een uitleg in plaats van
 * ergens een map aan te maken die niemand ooit terugvindt.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARTEFACTS = ["main.js", "manifest.json", "styles.css"];

const CANDIDATES = [
	process.env.PANTRY_VAULT,
	join(homedir(), "Obsidian", "Digitale_voorraadkast"),
	join(homedir(), "mnt", "Obsidian--Digitale_voorraadkast"),
].filter(Boolean);

const vault = CANDIDATES.find((path) => existsSync(join(path, ".obsidian")));

if (!vault) {
	console.error("Geen vault gevonden. Gezocht op:");
	for (const path of CANDIDATES) console.error(`  ${path}`);
	console.error("\nZet PANTRY_VAULT naar de vaultmap en probeer opnieuw.");
	process.exit(1);
}

const target = join(vault, ".obsidian", "plugins", "cupboard");
mkdirSync(target, { recursive: true });

for (const name of ARTEFACTS) {
	const from = join(ROOT, name);
	if (!existsSync(from)) {
		console.error(`ONTBREEKT  ${name} — is er wel gebouwd?`);
		process.exit(1);
	}
	copyFileSync(from, join(target, name));

	const stat = statSync(join(target, name));
	const kb = (stat.size / 1024).toFixed(stat.size < 10240 ? 1 : 0).padStart(5);
	console.log(`${name.padEnd(14)} ${kb} kB   ${stat.mtime.toTimeString().slice(0, 8)}`);
}

console.log(`\nNaar ${target}`);
console.log("Herstart Obsidian volledig om het op te pikken.");
