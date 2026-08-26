/**
 * Bevestigt na een build dat main.js daadwerkelijk vernieuwd is.
 *
 * De pluginmap is tegelijk de repo en de installatiemap, dus "deployen" is
 * niets meer dan bouwen. Wat wél elke keer misgaat is dat Obsidian een oude
 * main.js in het geheugen houdt: een plugin off/on of Cmd+R pakt een verse
 * bundel niet op, alleen een volledige herstart van de app. Daarom drukt dit
 * script tijd en grootte af — als het getal niet verandert, is er niet
 * gebouwd; als het wél verandert en de app doet het oude, herstart de app.
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const name of ["main.js", "manifest.json", "styles.css"]) {
	const path = join(root, name);
	let stat;
	try {
		stat = statSync(path);
	} catch {
		console.error(`ONTBREEKT  ${name}`);
		process.exit(1);
	}
	const kb = (stat.size / 1024).toFixed(stat.size < 10240 ? 1 : 0).padStart(5);
	const time = stat.mtime.toTimeString().slice(0, 8);
	console.log(`${name.padEnd(14)} ${kb} kB   ${time}`);
}

console.log("\nStaat in de vault. Herstart Obsidian volledig om het op te pikken.");
