import { TFile, normalizePath } from "obsidian";
import { startOfWeek } from "./date";
import {
	clearWarning,
	ensureFolder,
	frontmatterValue,
	hasRegion,
	regionMarkers,
	replaceRegion,
	warnOnce,
} from "./notes";
import type PantryPlugin from "./main";
import { toBuy, type Count, type Product } from "./products";

const NO_SHOP = "Anywhere";
const NO_CATEGORY = "Other";
const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;

/** De naam van het stuk notitie dat Pantry beheert; zie src/notes.ts. */
const REGION = "groceries";

/**
 * De vaste regel die bovenaan de lijst staat.
 *
 * Doet dubbel dienst als herkenningspunt: notities van vóór de markers hebben
 * hem óók, en aan die regel is te zien dat de hele inhoud onder de frontmatter
 * ooit door de plugin geschreven is.
 */
const SIGNATURE =
	"*Kept up to date by Pantry. Tick a box and that product counts as full again.*";

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
	readonly bought: Map<string, { count: Count | null; check: boolean }> = new Map();
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
		// Ook de check-vlag bewaren: die wordt hieronder gewist, en zonder
		// bewaren kreeg een product uit "Check first" hem nooit meer terug.
		this.bought.set(product.path, { count: product.count, check: product.check });
		this.nudge.delete(product.path);
		await this.plugin.products.update(product, { count: "plus", check: false });
		await this.write();
	}

	async undoBought(product: Product): Promise<void> {
		const before = this.bought.get(product.path);
		this.bought.delete(product.path);
		await this.plugin.products.update(product, {
			count: before?.count ?? null,
			check: before?.check ?? false,
		});
		await this.write();
	}

	/** Als markBought, maar zonder te schrijven — voor een reeks tikken achter elkaar. */
	private async markBoughtQuietly(product: Product): Promise<void> {
		this.bought.set(product.path, { count: product.count, check: product.check });
		this.nudge.delete(product.path);
		await this.plugin.products.update(product, { count: "plus", check: false });
	}

	private async undoBoughtQuietly(product: Product): Promise<void> {
		const before = this.bought.get(product.path);
		this.bought.delete(product.path);
		await this.plugin.products.update(product, {
			count: before?.count ?? null,
			check: before?.check ?? false,
		});
	}

	/**
	 * Reads ticks a person made in the note itself, then repaints the note.
	 *
	 * Alle tikken worden eerst verwerkt en pas daarna wordt er één keer
	 * geschreven. Schreef elke tik apart, dan werd de notitie vijf keer
	 * herschreven vanuit één momentopname — en een vinkje dat je zette tussen
	 * het lezen en het laatste schrijven werd stil weer uitgevinkt.
	 */
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
				await this.markBoughtQuietly(product);
			} else if (!ticked && inBought && this.bought.has(product.path)) {
				await this.undoBoughtQuietly(product);
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

	/**
	 * Schrijft de lijst in het stuk van de notitie dat Pantry beheert.
	 *
	 * Drie dingen die hier eerder misgingen:
	 *
	 * - **Eigendom.** De hele notitie werd overschreven, op een pad dat de
	 *   gebruiker zelf instelt. Stond er al een eigen lijst in `Groceries.md`,
	 *   dan was die bij de eerste verversing weg — zonder waarschuwing, zonder
	 *   undo. Nu schrijft de plugin alleen tussen haar eigen markers, en raakt
	 *   ze een notitie die niet van haar is niet aan.
	 * - **Wat je er zelf bij zet.** Alles buiten die markers blijft staan: een
	 *   handgeschreven regel, een Dataview-blok, een briefje aan de slager.
	 * - **Een lege index.** Klopt de productmap even niet, dan is er niets te
	 *   melden — en dat is iets anders dan "niets nodig". Er wordt dan niet
	 *   geschreven, zodat je mandje niet verdwijnt terwijl je in de winkel staat.
	 */
	async write(): Promise<void> {
		const { vault } = this.plugin.app;
		const path = this.path();

		// M40: een lege productindex is geen boodschappenlijst van niks.
		if (this.plugin.products.all().length === 0) return;

		const file = vault.getFileByPath(path);
		if (!file) {
			if (this.isEmpty()) return;
			await ensureFolder(vault, path);
			this.lastWrite = Date.now();
			await vault.create(path, this.template());
			return;
		}

		const current = await vault.cachedRead(file);
		if (!this.mayWriteTo(current, path)) return;
		clearWarning(file);

		const wanted = this.rebuild(current);
		if (current.trim() === wanted.trim()) return;

		this.lastWrite = Date.now();
		// process() in plaats van modify(): dit is precies de notitie die je
		// waarschijnlijk open hebt staan, en een blinde modify gooit weg wat er
		// tussen lezen en schrijven bij kwam.
		await vault.process(file, (latest: string) => this.rebuild(latest));
	}

	/**
	 * De notitie zoals hij eruit hoort te zien.
	 *
	 * Notities van vóór de markers krijgen hun hele inhoud vervangen in plaats
	 * van een blok erbij. In die versie was álles onder de frontmatter van de
	 * plugin — het werd bij elke verversing opnieuw geschreven — dus er kan
	 * niets in staan wat bewaard had moeten blijven. Zonder deze stap komt het
	 * blok eronder te staan en heb je de lijst twee keer.
	 *
	 * De handtekeningregel is wat die oude vorm herkenbaar maakt. Wie zelf
	 * `pantry: groceries` in zijn frontmatter zet om de plugin toestemming te
	 * geven, heeft die regel niet, en houdt dus gewoon zijn eigen notitie met
	 * het blok eronder.
	 */
	private rebuild(content: string): string {
		// Kijk naar wat er búíten het blok staat — of naar de hele notitie als
		// er nog geen blok is. Staat de handtekeningregel daar, dan is dat oude
		// output van de plugin zelf.
		//
		// De eerste versie van deze migratie keek alleen of er een blok wás, en
		// dat was precies verkeerd om: zodra er één keer een blok onderaan was
		// geplakt, gold de notitie als in orde en bleef de oude lijst er
		// eeuwig boven staan.
		const at = content.indexOf(regionMarkers(REGION).start);
		const outside = at === -1 ? content : content.slice(0, at);
		if (outside.includes(SIGNATURE)) return this.template();

		return replaceRegion(content, REGION, this.render());
	}

	/**
	 * Is deze notitie van Pantry?
	 *
	 * Ja als hij de markers al draagt, of als hij `pantry: groceries` in zijn
	 * frontmatter heeft — dat zette de plugin er zelf in — of als hij leeg is.
	 * Anders is het iemands eigen notitie op een pad dat toevallig in de
	 * instellingen staat, en daar blijft de plugin vanaf.
	 */
	private mayWriteTo(content: string, path: string): boolean {
		if (content.trim().length === 0) return true;
		if (hasRegion(content, REGION)) return true;
		if (frontmatterValue(content, "pantry") === "groceries") return true;

		warnOnce(
			path,
			`left ${path} alone: it is not a Pantry note. Point "Grocery note" at another file, or add "pantry: groceries" to its frontmatter`
		);
		return false;
	}

	/** De notitie zoals hij er voor het eerst uitziet. */
	private template(): string {
		return [
			"---",
			"pantry: groceries",
			"---",
			"",
			"# Groceries",
			"",
			"*Anything you write outside the block below stays where it is.*",
			"",
			replaceRegion("", REGION, this.render()),
		].join("\n");
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

		lines.push(SIGNATURE);
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
