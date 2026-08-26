import { TFile, normalizePath } from "obsidian";
import type PantryPlugin from "./main";
import { parseIngredient } from "./ingredients";

/**
 * What a count can be. A number is exact. "plus" means "more than the target,
 * and I did not bother to say how many" — enough for cooking too. It is
 * deliberately not a number: the app must never invent one.
 */
export type Count = number | "plus";

/** A product is one note in the product folder; its frontmatter is the record. */
export interface Product {
	file: TFile;
	path: string;
	name: string;
	/** The floor: how many must always be in the house. */
	minimum: number;
	/** How you count it: tin, pack, piece. */
	unit: string;
	/** Contents per package, e.g. 400 g. Empty means one recipe unit per item. */
	size: { amount: number; unit: string } | null;
	/**
	 * False for salt, oil and spices: things you keep in the house rather than
	 * measure onto a list. Their recipe lines never add to what has to be
	 * bought, which is a decision the user made and not a failure to convert.
	 */
	amountMatters: boolean;
	shop: string;
	storage: string;
	/** Which shelf it sits on, for the walking route. */
	shelf: string;
	aliases: string[];
	/** null means never counted. */
	count: Count | null;
	/**
	 * Part of one unit already eaten but not yet worth subtracting: three
	 * hundred grams out of a one-kilo bag leaves 0.3 here. Once the leftovers
	 * add up to a whole unit the count drops by one. Wiped whenever the user
	 * counts the product himself, because that number supersedes everything.
	 */
	used: number;
	counted: string | null;
	/** The question-mark state: counted before, but worth checking again. */
	check: boolean;
	previous: Count | null;
	previousCounted: string | null;
}

export interface ProductPatch {
	minimum?: number;
	unit?: string;
	size?: string;
	/** "any" writes off the amount question; "" asks it again. */
	amount?: string;
	shop?: string;
	storage?: string;
	shelf?: string;
	aliases?: string[];
	count?: Count | null;
	check?: boolean;
	/** Leftover fraction of a unit; see Product.used. */
	used?: number;
}

export const UNASSIGNED = "Unsorted";

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(`${value}`.replace(",", "."));
	return Number.isFinite(parsed) ? parsed : null;
}

function list(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => `${item}`.trim()).filter(Boolean);
	const single = text(value);
	if (!single) return [];
	return single.split(",").map((item) => item.trim()).filter(Boolean);
}

/** Frontmatter holds "+" for the plus state; everything else is a number. */
export function parseCount(raw: unknown): Count | null {
	if (raw === null || raw === undefined || raw === "") return null;
	const value = `${raw}`.trim();
	if (value === "+" || value.endsWith("+")) return "plus";
	return num(value);
}

function serialiseCount(count: Count): string | number {
	return count === "plus" ? "+" : count;
}

/**
 * How many to buy. `extra` is what this week's meals ask for on top of the
 * minimum. null means the question cannot be answered yet because the product
 * was never counted. "plus" is enough by definition, so it buys nothing.
 */
export function toBuy(product: Product, extra = 0): number | null {
	if (product.count === null) return null;
	if (product.count === "plus") return 0;
	return Math.max(0, product.minimum + extra - product.count);
}

/** "400 g" -> { amount: 400, unit: "g" }. Bare numbers count as pieces. */
export function parseSize(raw: unknown): { amount: number; unit: string } | null {
	const value = text(raw);
	if (!value) return null;
	const match = /^([\d.,]+)\s*([a-zA-Z]*)$/.exec(value);
	if (!match) return null;
	const amount = Number(match[1].replace(",", "."));
	if (!Number.isFinite(amount) || amount <= 0) return null;
	return { amount, unit: match[2].toLowerCase() };
}

/** Lowercase, no punctuation, singular. Two spellings of one thing must collide. */
export function normalise(value: string): string {
	const base = value
		.toLowerCase()
		.replace(/\[\[|\]\]/g, " ")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return singular(base);
}

function singular(value: string): string {
	if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
	if (value.endsWith("ses") || value.endsWith("xes") || value.endsWith("zes")) {
		return value.slice(0, -2);
	}
	if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
	return value;
}

/**
 * Reads the product notes and answers "which product is this recipe line about".
 * Matching is deliberately dumb: exact on the normalised name or one of the
 * aliases. Anything else goes to the cleanup screen once, and the answer is
 * written back as an alias so it never has to be asked again.
 */
export class ProductIndex {
	private plugin: PantryPlugin;
	private products: Product[] = [];
	private lookup: Map<string, Product> = new Map();

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	folder(): string {
		return normalizePath(this.plugin.settings.productFolder || "Products");
	}

	build(): void {
		const prefix = `${this.folder()}/`;
		this.products = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(prefix))
			.map((file) => this.read(file))
			.sort((a, b) => a.name.localeCompare(b.name));

		this.reindex();
	}

	private remember(key: string, product: Product): void {
		if (key.length === 0) return;
		// First one wins, so an explicit name always beats someone else's alias.
		if (!this.lookup.has(key)) this.lookup.set(key, product);
	}

	private read(file: TFile): Product {
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

		return {
			file,
			path: file.path,
			name: file.basename,
			minimum: num(frontmatter.minimum) ?? num(frontmatter.target) ?? 0,
			unit: text(frontmatter.unit),
			size: parseSize(frontmatter.size),
			amountMatters: text(frontmatter.amount).toLowerCase() !== "any",
			shop: text(frontmatter.shop),
			storage: text(frontmatter.storage) || UNASSIGNED,
			shelf: text(frontmatter.shelf) || text(frontmatter.aisle),
			aliases: list(frontmatter.aliases),
			count: parseCount(frontmatter.count),
			used: Math.max(0, num(frontmatter.used) ?? 0),
			counted: text(frontmatter.counted) || null,
			check: frontmatter.check === true,
			previous: parseCount(frontmatter.previous),
			previousCounted: text(frontmatter.previousCounted) || null,
		};
	}

	all(): Product[] {
		return this.products;
	}

	byPath(path: string): Product | null {
		return this.products.find((product) => product.path === path) ?? null;
	}

	/** The product a piece of free text refers to, or null if we cannot tell. */
	match(rawName: string): Product | null {
		const link = /\[\[([^\]|#]+)/.exec(rawName);
		if (link) {
			// An explicit link is the author being precise; never second-guess it.
			const target = this.plugin.app.metadataCache.getFirstLinkpathDest(
				link[1].trim(),
				""
			);
			const linked = target ? this.byPath(target.path) : null;
			if (linked) return linked;
		}
		return this.lookup.get(normalise(rawName)) ?? null;
	}

	/** Distinct values of a field, for filters and pickers. */
	values(field: "shop" | "storage" | "unit" | "shelf"): string[] {
		const found = new Set<string>();
		this.products.forEach((product) => {
			const value = product[field];
			if (value) found.add(value);
		});
		return [...found].sort((a, b) => a.localeCompare(b));
	}

	async update(product: Product, patch: ProductPatch): Promise<void> {
		await this.plugin.app.fileManager.processFrontMatter(
			product.file,
			(frontmatter: Record<string, unknown>) => {
				if (patch.minimum !== undefined) {
					frontmatter.minimum = patch.minimum;
					// "target" was the old name; drop it so there is one truth.
					delete frontmatter.target;
				}
				if (patch.unit !== undefined) frontmatter.unit = patch.unit;
				if (patch.size !== undefined) frontmatter.size = patch.size;
				if (patch.amount !== undefined) {
					if (patch.amount) frontmatter.amount = patch.amount;
					else delete frontmatter.amount;
				}
				if (patch.shop !== undefined) frontmatter.shop = patch.shop;
				if (patch.storage !== undefined) frontmatter.storage = patch.storage;
				if (patch.shelf !== undefined) {
					frontmatter.shelf = patch.shelf;
					// "aisle" was the old name; drop it so there is one truth.
					delete frontmatter.aisle;
				}
				if (patch.aliases !== undefined) frontmatter.aliases = patch.aliases;
				if (patch.check !== undefined) frontmatter.check = patch.check;

				// A fresh count supersedes every leftover fraction, so counting
				// and booking a meal never fight over the same number.
				const used =
					patch.used !== undefined
						? patch.used
						: patch.count !== undefined
							? 0
							: null;
				if (used !== null) {
					if (used > 0.001) frontmatter.used = round(used);
					else delete frontmatter.used;
				}

				if (patch.count !== undefined) {
					// The stand being replaced becomes the previous one, so he can
					// see what it was last time and skip re-counting what he knows.
					const current = parseCount(frontmatter.count);
					if (current !== null && current !== patch.count) {
						frontmatter.previous = serialiseCount(current);
						frontmatter.previousCounted = frontmatter.counted ?? null;
					}
					if (patch.count === null) {
						delete frontmatter.count;
						delete frontmatter.counted;
					} else {
						frontmatter.count = serialiseCount(patch.count);
						frontmatter.counted = todayISO();
					}
				}
			}
		);
		// Obsidian's metadata cache has not caught up with the write yet, so
		// re-reading it here would hand back the old values and the screen would
		// need a second tap. Apply the change in memory instead; the cache event
		// that follows agrees with it.
		this.apply(product, patch);
		this.reindex();
	}

	/** Mirrors a written patch onto the product we already hold. */
	private apply(product: Product, patch: ProductPatch): void {
		if (patch.minimum !== undefined) product.minimum = patch.minimum;
		if (patch.unit !== undefined) product.unit = patch.unit;
		if (patch.size !== undefined) product.size = parseSize(patch.size);
		if (patch.amount !== undefined) {
			product.amountMatters = patch.amount.toLowerCase() !== "any";
		}
		if (patch.shop !== undefined) product.shop = patch.shop;
		if (patch.storage !== undefined) {
			product.storage = patch.storage || UNASSIGNED;
		}
		if (patch.shelf !== undefined) product.shelf = patch.shelf;
		if (patch.aliases !== undefined) product.aliases = [...patch.aliases];
		if (patch.check !== undefined) product.check = patch.check;

		if (patch.count !== undefined) {
			if (product.count !== null && product.count !== patch.count) {
				product.previous = product.count;
				product.previousCounted = product.counted;
			}
			product.count = patch.count;
			product.counted = patch.count === null ? null : todayISO();
		}

		if (patch.used !== undefined) product.used = round(patch.used);
		else if (patch.count !== undefined) product.used = 0;
	}

	private reindex(): void {
		this.lookup = new Map();
		for (const product of this.products) {
			this.remember(normalise(product.name), product);
			product.aliases.forEach((alias) => this.remember(normalise(alias), product));
		}
	}

	/** Adds an alias, so a line that needed the cleanup screen never does again. */
	async learn(product: Product, alias: string): Promise<void> {
		const value = alias.trim();
		if (!value) return;
		const known = product.aliases.map((item) => normalise(item));
		if (known.includes(normalise(value))) return;
		await this.update(product, { aliases: [...product.aliases, value] });
	}

	async create(name: string, patch: ProductPatch = {}): Promise<TFile | null> {
		const folder = this.folder();
		await this.ensureFolder(folder);

		const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "New product";
		const path = normalizePath(`${folder}/${safe}.md`);
		const existing = this.plugin.app.vault.getFileByPath(path);
		if (existing) return existing;

		const file = await this.plugin.app.vault.create(path, "");
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(frontmatter: Record<string, unknown>) => {
				frontmatter.minimum = patch.minimum ?? 0;
				frontmatter.unit = patch.unit ?? "";
				frontmatter.size = patch.size ?? "";
				frontmatter.shop = patch.shop ?? "";
				frontmatter.storage = patch.storage ?? "";
				frontmatter.shelf = patch.shelf ?? "";
				frontmatter.aliases = patch.aliases ?? [];
			}
		);
		this.build();
		return file;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (this.plugin.app.vault.getFolderByPath(path)) return;
		await this.plugin.app.vault.createFolder(path).catch(() => undefined);
	}

	/**
	 * Every distinct ingredient across all recipes that has no product yet.
	 * Used to fill the base list in one go instead of typing dozens of notes.
	 */
	unknownFromRecipes(bodies: string[][]): string[] {
		const found = new Map<string, string>();
		bodies.flat().forEach((line) => {
			const name = parseIngredient(line).name.trim();
			if (name.length === 0) return;
			if (this.match(name)) return;
			const key = normalise(name);
			if (key.length === 0 || found.has(key)) return;
			found.set(key, name);
		});
		return [...found.values()].sort((a, b) => a.localeCompare(b));
	}
}

/** Three decimals is far past what any recipe can justify. */
function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function todayISO(): string {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, "0");
	const day = `${now.getDate()}`.padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}



/**
 * What a product must say before the app can plan and shop with it. `minimum`
 * is deliberately absent: 0 is a real answer — "only buy this when a recipe
 * asks for it" — and frontmatter cannot tell that apart from never answered.
 */
export const MANDATORY = ["unit", "size", "shop", "shelf", "storage"] as const;

export type MandatoryField = (typeof MANDATORY)[number];

/**
 * Which mandatory fields this product still lacks. Package size is exempt when
 * the amount does not matter: salt and spices are kept, not measured, so there
 * is nothing to convert and asking for a size would be busywork.
 */
export function missingFields(product: Product): MandatoryField[] {
	const gaps: MandatoryField[] = [];
	if (!product.unit) gaps.push("unit");
	if (!product.size && product.amountMatters) gaps.push("size");
	if (!product.shop) gaps.push("shop");
	if (!product.shelf) gaps.push("shelf");
	if (!product.storage || product.storage === UNASSIGNED) gaps.push("storage");
	return gaps;
}

/** True when nothing is left to ask about this product. */
export function isComplete(product: Product): boolean {
	return missingFields(product).length === 0;
}
