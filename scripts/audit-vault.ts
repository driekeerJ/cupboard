import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { makeHarness } from "../tests/harness/plugin";

const VAULT = join(homedir(), "mnt", "Obsidian--Digitale_voorraadkast");

function walk(dir: string, into: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, into);
		else if (entry.name.endsWith(".md")) into.push(full);
	}
	return into;
}

const files: Record<string, string> = {};
for (const full of walk(VAULT, [])) {
	files[relative(VAULT, full).split(/[\\/]/).join("/")] = readFileSync(full, "utf8");
}
const data = JSON.parse(
	readFileSync(join(VAULT, ".obsidian/plugins/pantry/data.json"), "utf8")
);

const h = makeHarness(files, data);
await h.rebuild(new Date());
await h.plugin.cleanup.rebuild();

const open = h.plugin.cleanup.open();
const missing = h.plugin.cleanup.missing();
const stubborn = h.plugin.cleanup.stubborn();
import { missingFields } from "../src/products";
const gaps = h.plugin.products.all().filter((p) => missingFields(p).length > 0);
const unsorted = h.plugin.products.all().filter((p) => !p.shelf);
console.log("open", open.length, "| missing", missing.length, "| stubborn", stubborn.length);
console.log("producten", h.plugin.products.all().length, "| missing info", gaps.length, "| zonder schap", unsorted.length);
gaps.forEach((p) => console.log("   gat:", p.name, missingFields(p).join(",")));

writeFileSync(
	join(homedir(), "tmp", "audit.json"),
	JSON.stringify(
		{
			open: open.map((i) => ({ product: i.product.name, zero: i.zero.map((l) => ({ r: l.recipe, t: l.text, u: l.unit })) })),
			missing: missing.map((u) => ({ name: u.name, n: u.lines.length, lines: u.lines.map((l) => `${l.recipe} :: ${l.text}`) })),
			stubborn: stubborn.map((i) => ({
				product: i.product.name,
				unit: i.product.unit,
				size: i.product.size,
				zero: i.zero.map((l) => ({ r: l.recipe, t: l.text, u: l.unit })),
			})),
		},
		null,
		1
	)
);
