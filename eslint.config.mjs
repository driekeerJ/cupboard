/**
 * ESLint voor Pantry.
 *
 * De reden dat dit bestand bestaat is één regel: `no-floating-promises`. De
 * plugin schrijft voortdurend naar de vault, en een promise zonder catch laat
 * een mislukte schrijfactie geruisloos verdampen — de gebruiker denkt dat zijn
 * voorraad geboekt is terwijl er niets gebeurd is. Daarom staat de regel op
 * `ignoreVoid: false`: een kale `void promise` is géén afhandeling, alleen het
 * wegdrukken van de waarschuwing.
 *
 * Niveau `warn`, niet `error`, zolang de refactor loopt: er staan er nog
 * tientallen open en de build moet groen kunnen blijven. Zodra batch B klaar is
 * mag dit op `error`.
 */
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**", "scripts/**", "*.config.mjs"],
	},

	// Controleert manifest.json en package.json op Obsidians eisen.
	...obsidianmd.configs.recommended,

	{
		// Type-aware regels alleen op de broncode; anders probeert ESLint ook
		// package.json door de TypeScript-parser te halen en klapt hij eruit.
		files: ["src/**/*.ts", "tests/**/*.ts"],
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// De kern van 0b. Zie de kop van dit bestand.
			"@typescript-eslint/no-floating-promises": [
				"warn",
				{ ignoreVoid: false, ignoreIIFE: false },
			],

			// Uit: `console.error` naast een `Notice` is hier het bewuste patroon —
			// de gebruiker ziet wat er misging, de devtools houden het spoor vast.
			"no-console": "off",

			// Uit: een store-eis voor de communityplugin-catalogus. Deze plugin is
			// van één huishouden en gebruikt Nederlandse labels waar dat past.
			"obsidianmd/ui/sentence-case": "off",
		},
	},

	{
		// Het testharnas doet met opzet dingen die in productiecode fout zijn:
		// een neppe TFile is geen echte TFile, en de neppe plugin wordt met een
		// cast in elkaar gezet. Dat is het hele idee — de code uit src/ hoeft er
		// niets voor te veranderen.
		files: ["tests/**/*.ts", "tests/**/*.mjs"],
		rules: {
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-argument": "off",

			// `test()` levert een promise die de testrunner zelf afwacht; elke
			// testregel zou anders een waarschuwing zijn en de 85 echte gevallen
			// in src/ onvindbaar maken.
			"@typescript-eslint/no-floating-promises": "off",

			// node:test en node:fs draaien nooit op de telefoon; deze regel gaat
			// over de plugin, niet over het harnas eromheen.
			"obsidianmd/no-nodejs-modules": "off",

			// js-yaml staat in devDependencies en hoort daar: hij zit alleen in
			// het harnas, nooit in de bundel die de gebruiker draait.
			"import/no-extraneous-dependencies": "off",

			// De neppe vault maakt TFile-achtige objecten. Een `instanceof`-check
			// zou hier niets bewijzen: er is buiten Obsidian geen echte TFile.
			"obsidianmd/no-tfile-tfolder-cast": "off",
		},
	},
);
