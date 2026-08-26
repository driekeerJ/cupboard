import { TFile, normalizePath } from "obsidian";
import { startOfWeek } from "./date";
import type PantryPlugin from "./main";
import { toBuy, type Count, type Product } from "./products";

const NO_SHOP = "Anywhere";
const NO_CATEGORY = "Other";
const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;

/**
 * The grocery list as a note. It is a mirror, not a source: the product notes
 * stay the truth and this file is rewritten whenever they change. Ticking a box
 * here does exactly what ticking in the view does, so the phone works with or
 * without the plugin's own screen.
 */
export class GroceryList {
	private plugin: PantryPlugin;
	/** Our own last write, so its echo is not read back as a user edit. */
	private lastWrite = 0;
	/**
	 * What the count was before an item was ticked. Lives only for as long as
	 * the app runs: it exists to undo a mistake while you are still in the shop.
	 */
	readonly bought: Map<string, Count | null> = new Map();
	/** Session-only tweaks from the + / − buttons, applied to both renderings. */
	readonly nudge: Map<string, number> = new Map();

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	path(): string {
		return normalizePath(this.plugin.settings.listNote || "Groceries.md");
	}

	file(): TFile | null {
		return this.plugin.app.vault.getFileByPath(this.path());
	}

	isListNote(path: string): boolean {
		return normalizePath(path) === this.path();
	}

	recentlyWrote(): boolean {
		return Date.now() - this.lastWrite < 800;
	}

	amount(product: Product): number | null {
		const base = toBuy(product, this.plugin.needs.get(product));
		if (base === null) return null;
		return Math.max(0, base + (this.nudge.get(product.path) ?? 0));
	}

	private needed(product: Product): boolean {
		return product.minimum + this.plugin.needs.get(product) > 0;
	}

	/** To buy, and what cannot be answered yet because it was never counted. */
	buckets(): { buy: Product[]; unsure: Product[] } {
		const buy: Product[] = [];
		const unsure: Product[] = [];

		this.plugin.products.all().forEach((product) => {
			if (this.bought.has(product.path)) return;
			const amount = this.amount(product);
			if (amount === null) {
				if (this.needed(product)) unsure.push(product);
				return;
			}
			if (amount <= 0) return;
			if (product.check) unsure.push(product);
			else buy.push(product);
		});

		return { buy, unsure };
	}

	boughtProducts(): Product[] {
		return [...this.bought.keys()]
			.map((path) => this.plugin.products.byPath(path))
			.filter((product): product is Product => product !== null);
	}

	async markBought(product: Product): Promise<void> {
		this.bought.set(product.path, product.count);
		this.nudge.delete(product.path);
		await this.plugin.products.update(product, { count: "plus", check: false });
		await this.write();
	}

	async undoBought(product: Product): Promise<void> {
		const before = this.bought.get(product.path) ?? null;
		this.bought.delete(product.path);
		await this.plugin.products.update(product, { count: before });
		await this.write();
	}

	/** Reads ticks a person made in the note itself, then repaints the note. */
	async syncFromNote(): Promise<void> {
		const file = this.file();
		if (!file) return;

		const content = await this.plugin.app.vault.cachedRead(file);
		let inBought = false;

		for (const line of content.split(/\r?\n/)) {
			if (line.startsWith("## ")) {
				inBought = line.trim() === BOUGHT_HEADING;
				continue;
			}
			const match = TICK.exec(line);
			if (!match) continue;

			const ticked = match[1].toLowerCase() === "x";
			const product = this.resolve(match[2].trim());
			if (!product) continue;

			if (ticked && !inBought && !this.bought.has(product.path)) {
				await this.markBought(product);
			} else if (!ticked && inBought && this.bought.has(product.path)) {
				await this.undoBought(product);
			}
		}

		await this.write();
	}

	private resolve(linkText: string): Product | null {
		const target = this.plugin.app.metadataCache.getFirstLinkpathDest(
			linkText,
			this.path()
		);
		if (target) return this.plugin.products.byPath(target.path);
		return this.plugin.products.match(linkText);
	}

	/** Rebuilds the note, but only touches the vault when it truly differs. */
	async write(): Promise<void> {
		const { vault } = this.plugin.app;
		const path = this.path();
		const wanted = this.render();

		const file = vault.getFileByPath(path);
		if (!file) {
			if (this.isEmpty()) return;
			this.lastWrite = Date.now();
			await vault.create(path, wanted);
			return;
		}

		const current = await vault.cachedRead(file);
		if (current.trim() === wanted.trim()) return;

		this.lastWrite = Date.now();
		await vault.modify(file, wanted);
	}

	private isEmpty(): boolean {
		const { buy, unsure } = this.buckets();
		return buy.length === 0 && unsure.length === 0 && this.bought.size === 0;
	}

	async refresh(): Promise<void> {
		await this.plugin.needs.rebuild(
			startOfWeek(new Date(), this.plugin.settings.weekStartDay)
		);
		await this.write();
	}

	private render(): string {
		const { buy, unsure } = this.buckets();
		const lines: string[] = [];

		lines.push("---");
		lines.push("pantry: groceries");
		lines.push("---");
		lines.push("");
		lines.push("# Groceries");
		lines.push("");
		lines.push(
			"*Kept up to date by Pantry. Tick a box and that product counts as full again.*"
		);
		lines.push("");

		if (buy.length === 0 && unsure.length === 0 && this.bought.size === 0) {
			lines.push("Nothing needed.");
			lines.push("");
			return lines.join("\n");
		}

		this.shops(buy).forEach((shop) => {
			const items = buy.filter((product) => (product.shop || NO_SHOP) === shop);
			if (items.length === 0) return;
			lines.push(`## ${shop}`);
			lines.push("");

			const shelves = new Map<string, Product[]>();
			items.forEach((product) => {
				const key = product.shelf || NO_CATEGORY;
				const bucket = shelves.get(key) ?? [];
				bucket.push(product);
				shelves.set(key, bucket);
			});

			[...shelves.keys()]
				.sort((a, b) => this.plugin.compareShelves(shop, a, b))
				.forEach((shelf) => {
					if (shelves.size > 1) {
						lines.push(`### ${shelf}`);
						lines.push("");
					}
					(shelves.get(shelf) ?? [])
						.sort((a, b) => a.name.localeCompare(b.name))
						.forEach((product) => lines.push(this.line(product, false)));
					lines.push("");
				});
		});

		if (unsure.length > 0) {
			lines.push(CHECK_HEADING);
			lines.push("");
			unsure
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => lines.push(this.line(product, false)));
			lines.push("");
		}

		const done = this.boughtProducts();
		if (done.length > 0) {
			lines.push(BOUGHT_HEADING);
			lines.push("");
			done
				.sort((a, b) => a.name.localeCompare(b.name))
				.forEach((product) => lines.push(this.line(product, true)));
			lines.push("");
			lines.push("*Untick to put the old count back.*");
			lines.push("");
		}

		return lines.join("\n");
	}

	private line(product: Product, ticked: boolean): string {
		const box = ticked ? "x" : " ";
		if (ticked) return `- [${box}] [[${product.name}]]`;
		const amount = this.amount(product);
		const text =
			amount === null
				? "?"
				: `${amount}${product.unit ? ` ${product.unit}` : ""}`;
		return `- [${box}] [[${product.name}]] · ${text}`;
	}

	private shops(items: Product[]): string[] {
		const found = new Set<string>();
		items.forEach((product) => found.add(product.shop || NO_SHOP));
		return [...found].sort((a, b) =>
			a === NO_SHOP ? 1 : b === NO_SHOP ? -1 : a.localeCompare(b)
		);
	}
}
