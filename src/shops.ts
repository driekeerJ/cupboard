import { TFile, normalizePath } from "obsidian";
import { markdownIn } from "./folder";
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

export interface Shop {
	name: string;
	path: string;
	/** Shelves in the order you walk past them. */
	shelves: string[];
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
			shops.push({
				name: file.basename,
				path: file.path,
				shelves: await this.readShelves(file),
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

		for (const line of lines) {
			const heading = HEADING.exec(line);
			if (heading) {
				collecting = SHELF_HEADING.test(heading[1]);
				continue;
			}
			const bullet = BULLET.exec(line);
			if (!bullet) continue;
			const name = bullet[1].replace(/^\[[ xX]\]\s*/, "").trim();
			if (name.length === 0) continue;
			everything.push(name);
			if (collecting) inSection.push(name);
		}

		return inSection.length > 0 ? inSection : everything;
	}

	async createShop(name: string): Promise<TFile | null> {
		const folder = this.folder();
		if (!this.plugin.app.vault.getFolderByPath(folder)) {
			await this.plugin.app.vault.createFolder(folder).catch(() => undefined);
		}

		const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
		if (safe.length === 0) return null;

		const path = normalizePath(`${folder}/${safe}.md`);
		const existing = this.plugin.app.vault.getFileByPath(path);
		if (existing) return existing;

		const file = await this.plugin.app.vault.create(
			path,
			[
				"---",
				"pantry: shop",
				"---",
				"",
				`# ${safe}`,
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
	async setShelves(shop: Shop, shelves: string[]): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(shop.path);
		if (!file) return;

		const content = await this.plugin.app.vault.read(file);
		const lines = content.split(/\r?\n/);
		const kept: string[] = [];
		let inSection = false;
		let wrote = false;

		for (const line of lines) {
			const heading = HEADING.exec(line);
			if (heading) {
				if (inSection && !wrote) {
					kept.push(...shelves.map((shelf) => `- ${shelf}`), "");
					wrote = true;
				}
				inSection = SHELF_HEADING.test(heading[1]);
				kept.push(line);
				if (inSection) {
					kept.push("");
					kept.push(...shelves.map((shelf) => `- ${shelf}`));
					wrote = true;
				}
				continue;
			}
			if (inSection && (BULLET.test(line) || line.trim().length === 0)) continue;
			kept.push(line);
		}

		if (!wrote) {
			kept.push("", "## Shelves", "", ...shelves.map((shelf) => `- ${shelf}`));
		}

		await this.plugin.app.vault.modify(
			file,
			`${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
		);
		await this.build();
	}
}
