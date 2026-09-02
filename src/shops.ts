import { TFile, normalizePath } from "obsidian";
import { markdownIn } from "./folder";
import { ensureFolder } from "./notes";
import type PantryPlugin from "./main";

/**
 * What a new shop starts with. A visible starting point beats an empty screen:
 * a shelf you do not have is one tap to remove, and one to rename in the note.
 * Roughly the order most supermarkets are laid out in.
 */
export const DEFAULT_SHELVES = [
	"Fruit & vegetables",
	"Bakery",
	"Dairy & eggs",
	"Meat & fish",
	"Chilled",
	"Frozen",
	"Tins & jars",
	"Pasta, rice & grains",
	"Herbs, spices & oils",
	"Snacks & sweets",
	"Drinks",
	"Household",
	"Personal care",
];

/**
 * Zet de looproute in de eerste routesectie van een winkelnotitie.
 *
 * Losse functie: dan is de tekstbewerking te testen zonder vault, en kan hij
 * binnen `vault.process()` draaien op de inhoud zoals die op dat moment is.
 */
export function writeShelves(content: string, shelves: string[]): string {
	const bullets = shelves.map((shelf) => `- ${shelf}`);
	const kept: string[] = [];
	let inSection = false;
	let wrote = false;

	for (const line of content.split(/\r?\n/)) {
		const heading = HEADING.exec(line);
		if (heading) {
			inSection = SHELF_HEADING.test(heading[1] ?? "") && !wrote;
			kept.push(line);
			if (inSection) {
				kept.push("", ...bullets);
				wrote = true;
			}
			continue;
		}
		// Binnen de sectie verdwijnen de oude bullets; daarbuiten blijft alles
		// staan, ook een tweede routekop die iemand zelf heeft geschreven.
		if (inSection && (BULLET.test(line) || line.trim().length === 0)) continue;
		kept.push(line);
	}

	if (!wrote) kept.push("", "## Shelves", "", ...bullets);

	return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export interface Shop {
	name: string;
	path: string;
	/** Shelves in the order you walk past them. */
	shelves: string[];
	/**
	 * The shop's own search page, with `{q}` where the term goes.
	 *
	 * This is how "look this product up at the shop" works without the plugin
	 * knowing a single shop by name. Whoever owns the note fills in the
	 * address of the supermarket they actually walk into; an empty template
	 * simply means no button appears. The plugin never guesses one.
	 */
	search: string;
}

/**
 * The shop's search page for one search term, or null when there is nothing
 * usable to open.
 *
 * A template without `{q}` gets the term appended, because
 * `https://shop.example/search?q=` is the shape people paste out of their
 * address bar. Anything that is not http(s) is refused: a note is user input,
 * and `javascript:` in a link the plugin opens is not a link.
 */
export function searchUrl(template: string, query: string): string | null {
	const base = template.trim();
	const term = query.trim();
	if (base.length === 0 || term.length === 0) return null;
	if (!/^https?:\/\//i.test(base)) return null;
	const encoded = encodeURIComponent(term);
	return base.includes("{q}") ? base.replace(/\{q\}/g, encoded) : `${base}${encoded}`;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.+?)\s*$/;
const SHELF_HEADING = /shel(f|ves)|schap|route|aisle|gangpad/i;

/**
 * A shop is a note, and the bullet list inside it is the walking route. Editing
 * your route means dragging lines around in a note — no settings screen needed,
 * and it stays readable without the plugin.
 */
export class ShopIndex {
	private plugin: PantryPlugin;
	private shops: Shop[] = [];

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	folder(): string {
		return normalizePath(this.plugin.settings.shopFolder || "Shops");
	}

	isShopNote(path: string): boolean {
		return normalizePath(path).startsWith(`${this.folder()}/`);
	}

	all(): Shop[] {
		return this.shops;
	}

	names(): string[] {
		return this.shops.map((shop) => shop.name);
	}

	find(name: string): Shop | null {
		const key = name.trim().toLowerCase();
		return this.shops.find((shop) => shop.name.toLowerCase() === key) ?? null;
	}

	shelves(shopName: string): string[] {
		return this.find(shopName)?.shelves ?? [];
	}

	/** Where to look this product name up, or null if the shop never said. */
	searchFor(shopName: string, query: string): string | null {
		const shop = this.find(shopName);
		return shop ? searchUrl(shop.search, query) : null;
	}

	/** Where a shelf sits on the route; unknown shelves sort to the back. */
	order(shopName: string, shelf: string): number {
		const shelves = this.shelves(shopName);
		const index = shelves.findIndex(
			(item) => item.toLowerCase() === shelf.trim().toLowerCase()
		);
		return index === -1 ? Number.MAX_SAFE_INTEGER : index;
	}

	async build(): Promise<void> {
		const files = markdownIn(this.plugin.app.vault, this.folder()).sort((a, b) =>
			a.basename.localeCompare(b.basename)
		);

		const shops: Shop[] = [];
		for (const file of files) {
			const frontmatter =
				this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			shops.push({
				name: file.basename,
				path: file.path,
				shelves: await this.readShelves(file),
				search:
					typeof frontmatter.search === "string" ? frontmatter.search.trim() : "",
			});
		}
		this.shops = shops;
	}

	/**
	 * Bullets under a heading that looks like it names the route, and otherwise
	 * every bullet in the note. Forgiving on purpose: this is a note a person
	 * writes, not a form they fill in.
	 */
	private async readShelves(file: TFile): Promise<string[]> {
		const content = await this.plugin.app.vault.cachedRead(file);
		const lines = content.split(/\r?\n/);

		const inSection: string[] = [];
		const everything: string[] = [];
		let collecting = false;
		let seenSection = false;

		for (const line of lines) {
			const heading = HEADING.exec(line);
			if (heading) {
				// Alleen de éérste routekop telt. `SHELF_HEADING` matcht ruim —
				// "shelves", "route", "schap", "gangpad" — dus een notitie met
				// "## Shelves" én "## Mijn route" leverde beide lijsten achter
				// elkaar op, en `setShelves` schreef ze allebei vol. Twee
				// koppen betekende twee kopieën, en die verdubbelden bij elke
				// opslag: 2 → 4 → 8 → 16.
				const matches = SHELF_HEADING.test(heading[1] ?? "");
				collecting = matches && !seenSection;
				if (matches) seenSection = true;
				continue;
			}
			const bullet = BULLET.exec(line);
			if (!bullet) continue;
			const name = (bullet[1] ?? "").replace(/^\[[ xX]\]\s*/, "").trim();
			if (name.length === 0) continue;
			everything.push(name);
			if (collecting) inSection.push(name);
		}

		return seenSection ? inSection : everything;
	}

	async createShop(name: string): Promise<TFile | null> {
		const folder = this.folder();
		const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
		if (safe.length === 0) return null;

		const path = normalizePath(`${folder}/${safe}.md`);
		await ensureFolder(this.plugin.app.vault, path);
		const existing = this.plugin.app.vault.getFileByPath(path);
		if (existing) return existing;

		const file = await this.plugin.app.vault.create(
			path,
			[
				"---",
				"pantry: shop",
				'search: ""',
				"---",
				"",
				`# ${safe}`,
				"",
				"> [!info]- Looking a product up at this shop",
				"> Put this shop's search address in `search` above, with `{q}` where",
				"> the product name goes \u2014 for example",
				"> `https://www.example.com/search?query={q}`. The new product form then",
				"> offers a button that looks the name up here. Leave it empty and no",
				"> button appears.",
				"",
				"## Shelves",
				"",
				"*In the order you walk past them. Drag lines to change the route.*",
				"",
				...DEFAULT_SHELVES.map((shelf) => `- ${shelf}`),
				"",
			].join("\n")
		);
		await this.build();
		return file;
	}

	/** Writes the route back, keeping everything else in the note intact. */
	/**
	 * Schrijft de looproute terug, alleen in de eerste routesectie.
	 *
	 * Alles buiten die sectie blijft staan: een openingstijdenlijstje, een
	 * notitie over de kassa, wat dan ook. En `process()` in plaats van
	 * `read()` + `modify()`, want dat laatste is lezen en later schrijven met
	 * een gat ertussen waarin iemand anders de notitie kan aanraken.
	 */
	async setShelves(shop: Shop, shelves: string[]): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(shop.path);
		if (!file) return;

		await this.plugin.app.vault.process(file, (content: string) =>
			writeShelves(content, shelves)
		);
		await this.build();
	}
}
