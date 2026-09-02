import { TFile, normalizePath } from "obsidian";
import type PantryPlugin from "./main";
import { toISODate } from "./date";
import { parseNumber } from "./number";
import { markdownIn } from "./folder";
import { parseIngredient } from "./ingredients";
import { LINK_TARGET, linkTarget, toLink } from "./links";
import { ensureFolder } from "./notes";

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
	/**
	 * Where to find this product at the shop, as a full URL.
	 *
	 * Deliberately not a shop-specific field. This replaced `ahId` + `ahUrl`,
	 * and those were useless to anyone whose supermarket is not Albert Heijn:
	 * a plugin that has to know what "AH" is cannot travel. A link is a link
	 * wherever you shop, and the shop's own product code is still inside it
	 * for whoever needs it.
	 */
	url: string;
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
	/** Full URL to the product at the shop; "" clears it. */
	url?: string;
	count?: Count | null;
	check?: boolean;
	/** Leftover fraction of a unit; see Product.used. */
	used?: number;
	/**
	 * True when the app worked this count out itself — a meal that was ticked
	 * off, not a shelf that was looked at.
	 *
	 * Zonder dit onderscheid stempelt elke afgevinkte maaltijd `counted` op
	 * vandaag en schuift de oude stand naar `previous`. Je telt vier blikken op
	 * 1 augustus, eet er op 26 augustus één op, en de notitie beweert dat je op
	 * 26 augustus geteld hebt. Dat is precies het tegenovergestelde van wat dat
	 * veld moet betekenen.
	 */
	derived?: boolean;
}

export const UNASSIGNED = "Unsorted";

/**
 * A note name Obsidian will accept. Shared by the two places that turn a typed
 * product name into a path, so the duplicate check in the new-product form
 * asks about exactly the file `create()` is about to write.
 */
export function safeProductName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
}

/**
 * Wat er onder de frontmatter komt te staan bij een nieuw product.
 *
 * De uitleg hoort in de notitie, niet in de broncode van de plugin: wie over
 * tien jaar `Rijst.md` opent ziet `count: "+"`, `used: 0.33` en `previous: 4`
 * staan, en heeft dan iets aan een legenda op dezelfde pagina. Winkelnotities
 * en weeknotities doen dit al.
 */
const PRODUCT_BODY = [
	"",
	"> [!info]- Wat staat hier",
	"> `minimum` \u2014 hoeveel je hier altijd van in huis wilt hebben.",
	"> `unit` \u2014 waarin je telt: stuk, pak, kg.",
	"> `size` \u2014 hoeveel er in \u00e9\u00e9n verpakking zit, in de eenheid van je recepten.",
	"> `shop`, `shelf` \u2014 waar je het haalt en waar het in de winkel ligt.",
	"> `storage` \u2014 waar het thuis staat.",
	"> `aliases` \u2014 andere namen waarmee je recepten dit product noemen.",
	"> `url` \u2014 de link naar dit product bij de winkel.",
	"> `count` \u2014 de stand. `+` betekent: genoeg, niet geteld.",
	"> `used` \u2014 wat er sinds de laatste telling van op is, als deel van \u00e9\u00e9n eenheid.",
	"> `previous`, `counted` \u2014 de vorige stand en wanneer je voor het laatst telde.",
	"> `check` \u2014 met de hand gemarkeerd: hier wil je naar kijken.",
	"",
	"Pantry beheert de frontmatter hierboven. Deze tekst is van jou.",
	"",
].join("\n");

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export { parseNumber };

function list(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => `${item}`.trim()).filter(Boolean);
	const single = text(value);
	if (!single) return [];
	return single.split(",").map((item) => item.trim()).filter(Boolean);
}

/** Frontmatter holds "+" for the plus state; everything else is a number. */
export function parseCount(raw: unknown): Count | null {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (value.length === 0) return null;
	// "+" alleen betekent: genoeg, niet geteld. "3+" is iets anders \u2014 daar
	// staat een telling in. Die werd weggegooid, en `toBuy` geeft voor "plus"
	// altijd 0: met `minimum: 6` en `count: 3+` kocht je niets bij.
	if (value === "+") return "plus";
	const counted = parseNumber(value.replace(/\+$/, ""));
	if (counted !== null) return counted;
	return value.endsWith("+") ? "plus" : null;
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
	const amount = Number((match[1] ?? "").replace(",", "."));
	if (!Number.isFinite(amount) || amount <= 0) return null;
	return { amount, unit: (match[2] ?? "").toLowerCase() };
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
		this.products = markdownIn(this.plugin.app.vault, this.folder())
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
			minimum: parseNumber(frontmatter.minimum) ?? parseNumber(frontmatter.target) ?? 0,
			unit: text(frontmatter.unit),
			size: parseSize(frontmatter.size),
			amountMatters: text(frontmatter.amount).toLowerCase() !== "any",
			// `shop: "[[Lidl]]"` geeft de winkelnotitie een backlink en laat
			// Obsidian de verwijzing bijwerken als je hem hernoemt. Een kale
			// naam uit een oudere notitie blijft gewoon werken.
			shop: linkTarget(text(frontmatter.shop)),
			storage: text(frontmatter.storage) || UNASSIGNED,
			shelf: text(frontmatter.shelf) || text(frontmatter.aisle),
			aliases: list(frontmatter.aliases),
			url: text(frontmatter.url),
			count: parseCount(frontmatter.count),
			used: Math.max(0, parseNumber(frontmatter.used) ?? 0),
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
		const link = LINK_TARGET.exec(rawName);
		if (link) {
			// An explicit link is the author being precise; never second-guess it.
			const target = this.plugin.app.metadataCache.getFirstLinkpathDest(
				(link[1] ?? "").trim(),
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
				if (patch.shop !== undefined) {
					// Als de winkel een notitie heeft, schrijf de link; anders de
					// naam, want een link naar niets helpt niemand.
					frontmatter.shop = patch.shop
						? this.plugin.shops.find(patch.shop)
							? toLink(patch.shop)
							: patch.shop
						: "";
				}
				if (patch.storage !== undefined) frontmatter.storage = patch.storage;
				if (patch.shelf !== undefined) {
					frontmatter.shelf = patch.shelf;
					// "aisle" was the old name; drop it so there is one truth.
					delete frontmatter.aisle;
				}
				if (patch.aliases !== undefined) frontmatter.aliases = patch.aliases;
				if (patch.url !== undefined) frontmatter.url = patch.url;
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
					if (!patch.derived && current !== null && current !== patch.count) {
						frontmatter.previous = serialiseCount(current);
						frontmatter.previousCounted = frontmatter.counted ?? null;
					}
					if (patch.count === null) {
						delete frontmatter.count;
						delete frontmatter.counted;
					} else {
						frontmatter.count = serialiseCount(patch.count);
						// Alleen een echte telling verzet de datum.
						if (!patch.derived) frontmatter.counted = todayISO();
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
		if (patch.url !== undefined) product.url = patch.url;
		if (patch.check !== undefined) product.check = patch.check;

		if (patch.count !== undefined) {
			if (!patch.derived && product.count !== null && product.count !== patch.count) {
				product.previous = product.count;
				product.previousCounted = product.counted;
			}
			product.count = patch.count;
			if (!patch.derived) {
				product.counted = patch.count === null ? null : todayISO();
			}
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

	/**
	 * Zet elke verwijzing naar een hernoemde winkel om.
	 *
	 * Obsidian werkt een `[[Lidl]]` in de frontmatter zelf bij, maar een kale
	 * `shop: Lidl` uit een oudere notitie niet — en dan geeft `shops.find()`
	 * null en zakt de looproute stilzwijgend terug naar alfabetisch.
	 */
	async renameShop(oldName: string, newName: string): Promise<number> {
		const from = oldName.trim().toLowerCase();
		const to = newName.trim();
		if (from.length === 0 || to.length === 0 || from === to.toLowerCase()) return 0;

		let changed = 0;
		for (const product of this.products) {
			if (product.shop.trim().toLowerCase() !== from) continue;
			await this.update(product, { shop: to });
			changed++;
		}
		return changed;
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
		const safe = safeProductName(name) || "New product";
		const path = normalizePath(`${folder}/${safe}.md`);
		await ensureFolder(this.plugin.app.vault, path);
		const existing = this.plugin.app.vault.getFileByPath(path);
		if (existing) return existing;

		const file = await this.plugin.app.vault.create(path, PRODUCT_BODY);
		await this.plugin.app.fileManager.processFrontMatter(
			file,
			(frontmatter: Record<string, unknown>) => {
				frontmatter.minimum = patch.minimum ?? 0;
				frontmatter.unit = patch.unit ?? "";
				frontmatter.size = patch.size ?? "";
				frontmatter.shop =
					patch.shop && this.plugin.shops.find(patch.shop)
						? toLink(patch.shop)
						: (patch.shop ?? "");
				frontmatter.storage = patch.storage ?? "";
				frontmatter.shelf = patch.shelf ?? "";
				frontmatter.aliases = patch.aliases ?? [];
				frontmatter.url = patch.url ?? "";
				// Alleen schrijven als het iets zegt: leeg betekent "de vraag
				// is nog niet beantwoord", en dat is de afwezigheid van het
				// veld, niet een lege waarde.
				if (patch.amount) frontmatter.amount = patch.amount;
			}
		);
		this.build();
		return file;
	}

	/**
	 * Gooit een productnotitie weg, via Obsidians eigen prullenbak.
	 *
	 * Hier en niet in het productscherm: de index weet wat een product is en
	 * moet daarna toch opnieuw gebouwd worden. Een scherm dat zelf bestanden
	 * weggooit is een scherm dat de index kan laten liggen.
	 */
	async remove(product: Product): Promise<void> {
		await this.plugin.app.fileManager.trashFile(product.file);
		this.build();
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

/**
 * Alleen de ruis van drijvende komma's wegpoetsen, verder niets weggooien.
 *
 * Dit stond op drie decimalen "omdat geen recept preciezer is". Maar `used` is
 * geen receptmaat, het is een saldo: drie keer een derde zak rijst gaf 0,999 en
 * de telling bleef staan — de zak was op en de voorraad wist het niet. De
 * marge waarmee `move()` beslist of er een hele verpakking af mag (`EPSILON`,
 * 1e-9) moet ruimer zijn dan wat hier wordt afgerond, anders eet elke boeking
 * een beetje van het saldo.
 */
function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}

export function todayISO(): string {
	return toISODate(new Date());
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


