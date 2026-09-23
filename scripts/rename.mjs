/**
 * Renames the plugin as it appears to the world: the id in the manifest, the
 * name in the UI, the repository links and the default shopping folder.
 *
 *   node scripts/rename.mjs <id> "<Name>"
 *   node scripts/rename.mjs larder Larder
 *
 * The id "pantry" is already taken in the community directory, so the plugin
 * needs another one before it can be submitted. What this script leaves alone
 * on purpose: the `pantry:` markers in note frontmatter (`pantry: shop`,
 * `pantry: shopping`, `pantry: cook`), the `pantry-` CSS class prefix and the
 * TypeScript identifiers. Those are internal, and changing the markers would
 * make every existing vault unreadable to the renamed build.
 *
 * Also not touched: the GitHub repository name. Rename it on GitHub, then
 * `git remote set-url origin git@github.com:<user>/<id>.git`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [, , id, name] = process.argv;

if (!id || !name) {
	console.error('Usage: node scripts/rename.mjs <id> "<Name>"');
	process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(id) || /obsidian/.test(id) || /plugin$/.test(id)) {
	console.error("The id must be lowercase letters, digits and hyphens, may not contain 'obsidian' and may not end in 'plugin'.");
	process.exit(1);
}
if (/obsidian|plugin/i.test(name)) {
	console.error("The name may not contain 'Obsidian' or 'Plugin' (community directory rule).");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const oldId = manifest.id;
const oldName = manifest.name;

let changed = 0;

function edit(path, transform) {
	const before = readFileSync(path, "utf8");
	const after = transform(before);
	if (after !== before) {
		writeFileSync(path, after);
		changed++;
		console.log(`  ${path.slice(ROOT.length + 1)}`);
	}
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(ts|css|md|mjs|json)$/.test(entry)) out.push(full);
	}
	return out;
}

// The word as it shows in the UI, in messages and in docs. `\b` keeps
// identifiers such as PantryPlugin and PantrySettings out of it.
const word = new RegExp(`\\b${oldName}\\b`, "g");
const files = [
	...walk(join(ROOT, "src")),
	...walk(join(ROOT, "tests")),
	...walk(join(ROOT, "scripts")),
	...walk(join(ROOT, "demo")),
	join(ROOT, "README.md"),
	join(ROOT, "styles.css"),
];
for (const file of files) {
	edit(file, (text) => text.replace(word, name));
}

// The id: manifest, package, the deploy target and the vault folder the
// screenshot script writes into.
edit(join(ROOT, "manifest.json"), (text) => {
	const json = JSON.parse(text);
	json.id = id;
	json.name = name;
	return JSON.stringify(json, null, "\t") + "\n";
});
edit(join(ROOT, "package.json"), (text) => {
	const json = JSON.parse(text);
	json.name = id;
	return JSON.stringify(json, null, "  ") + "\n";
});
edit(join(ROOT, "scripts", "deploy.mjs"), (text) =>
	text.replace(`"plugins", "${oldId}"`, `"plugins", "${id}"`)
);
edit(join(ROOT, "README.md"), (text) => text.replaceAll(`driekeerJ/${oldId}`, `driekeerJ/${id}`));

// The demo vault keeps its shopping lists in the default folder, which carries
// the name; the folder on disk has to follow the string in the notes.
const demoFolder = join(ROOT, "demo", oldName);
if (existsSync(demoFolder)) {
	renameSync(demoFolder, join(ROOT, "demo", name));
	console.log(`  demo/${oldName} -> demo/${name}`);
}

console.log(`\n${changed} files changed: ${oldName} (${oldId}) is now ${name} (${id}).`);
console.log("Next: npm run build, check the diff, rename the GitHub repository, commit.");
console.log(`In your own vault, rename .obsidian/plugins/${oldId} to .obsidian/plugins/${id} to keep data.json.`);
