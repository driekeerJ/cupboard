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
		files: ["src/**/*.ts"],
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
);
