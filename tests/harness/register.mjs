// Laat de broncode uit src/ ongewijzigd in Node draaien.
//
// Twee dingen moeten opgelost worden voordat `node --test` de echte modules
// kan laden:
//
// 1. `import ... from "obsidian"` bestaat alleen binnen Obsidian. Die wijst
//    hier naar de stub, zodat er geen tweede versie van de code nodig is.
// 2. De broncode importeert zonder extensie (`./date`), wat esbuild prima
//    vindt maar Node niet. Relatieve specifiers zonder extensie krijgen er
//    daarom `.ts` bij.
//
// Aanroepen met: node --import ./tests/harness/register.mjs --test "tests/**/*.test.ts"
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const stub = pathToFileURL(
	join(dirname(fileURLToPath(import.meta.url)), "obsidian.ts")
).href;

const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$|\.node$/i;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "obsidian") return { url: stub, shortCircuit: true };

		if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
			try {
				return next(`${specifier}.ts`, context);
			} catch {
				// Geen .ts ernaast: laat Node het op de gewone manier proberen,
				// zodat de foutmelding over het échte pad gaat.
			}
		}

		return next(specifier, context);
	},
});
