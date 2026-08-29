import { TFile, debounce, normalizePath } from "obsidian";
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
import { guarded } from "./guard";
import { parseCount, toBuy, type Count, type Product } from "./products";

export const NO_SHOP = "Anywhere";
export const NO_CATEGORY = "Other";

/** Eén winkel met haar schappen, in de volgorde waarin je erlangs loopt. */
export interface ShopGroup {
	shop: string;
	items: Product[];
	shelves: { shelf: string; items: Product[] }[];
}

/**
 * De boodschappenlijst gegroepeerd per winkel en per schap.
 *
 * De notitie en het boodschappenscherm bouwden dit allebei zelf op \u2014 dezelfde
 * winkelgroepering, dezelfde schapbuckets, dezelfde sortering, twee keer
 * uitgeschreven. Wat er in de notitie stond en wat je op je telefoon zag kon
 * daardoor uit elkaar lopen zonder dat iemand er iets aan veranderd had.
 */
export function groupForShopping(
	plugin: PantryPlugin,
	items: Product[]
): ShopGroup[] {
	const byShop = new Map<string, Product[]>();
	for (const product of items) {
		const key = product.shop || NO_SHOP;
		const bucket = byShop.get(key) ?? [];
		bucket.push(product);
		byShop.set(key, bucket);
	}

	return [...byShop.keys()]
		// Zonder winkel achteraan: dat is de restcategorie, geen naam.
		.sort((a, b) => (a === NO_SHOP ? 1 : b === NO_SHOP ? -1 : a.localeCompare(b)))
		.map((shop) => {
			const own = byShop.get(shop) ?? [];
			const byShelf = new Map<string, Product[]>();
			for (const product of own) {
				const key = product.shelf || NO_CATEGORY;
				const bucket = byShelf.get(key) ?? [];
				bucket.push(product);
				byShelf.set(key, bucket);
			}

			const shelves = [...byShelf.keys()]
				.sort((a, b) => plugin.compareShelves(shop, a, b))
				.map((shelf) => ({
					shelf,
					items: (byShelf.get(shelf) ?? []).sort((a, b) =>
						a.name.localeCompare(b.name)
					),
				}));

			return { shop, items: own, shelves };
		});
}
const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;

/** De naam van het stuk notitie dat Pantry beheert; zie src/notes.ts. */
const REGION = "groceries";

/** Waar de lopende boodschappenronde staat als er niets is ingesteld. */
export const DEFAULT_STATE_PATH = "Pantry/shopping.json";

/** Staat in het bestand, zodat een oudere vorm ooit te herkennen is. */
const STATE_VERSION = 1;

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
	/** De inhoud van onze laatste schrijfactie, om de echo ervan te herkennen. */
	private lastWritten: string | null = null;
	/**
	 * Wat de telling was vóór je een product afvinkte, zodat je een misser kunt
	 * terugdraaien terwijl je nog in de winkel staat.
	 *
	 * Dit leefde alleen in het geheugen. Herstartte je Obsidian halverwege de
	 * boodschappen — of pakte je je telefoon in plaats van je laptop — dan was
	 * je kwijt wat er al in het mandje lag, de telling van vóór elke tik, en al
	 * je ± aanpassingen. Het voorraadeffect van een tik was wel duurzaam; de
	 * context van de ronde niet.
	 *
	 * Nu staat het in een JSON in de vault, zodat Obsidian Sync het meeneemt.
	 * Gesleuteld op het productpad en niet op de naam: een hernoemd product is
	 * hetzelfde product.
	 */
	readonly bought: Map<string, { count: Count | null; check: boolean }> = new Map();
	/** Tweaks from the + / − buttons, applied to both renderings. */
	readonly nudge: Map<string, number> = new Map();

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	path(): string {
		return normalizePath(this.plugin.settings.listNote || "Groceries.md");
	}

	/** Waar de lopende boodschappenronde bewaard wordt. */
	statePath(): string {
		return normalizePath(
			this.plugin.settings.shoppingState || DEFAULT_STATE_PATH
		);
	}

	isStateFile(path: string): boolean {
		return normalizePath(path) === this.statePath();
	}

	/**
	 * Leest de lopende ronde terug.
	 *
	 * Alles wat geen geldig getal of pad is verdwijnt: dit bestand staat in de
	 * vault en kan door sync half aankomen of met de hand aangeraakt worden.
	 */
	async loadState(): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(this.statePath());
		if (!file) return;

		let raw: unknown;
		try {
			raw = JSON.parse(await this.plugin.app.vault.cachedRead(file));
		} catch {
			// Kapotte JSON is geen reden om de ronde te wissen; laat staan wat
			// er is en schrijf hem bij de volgende tik opnieuw.
			return;
		}

		const state = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		this.bought.clear();
		this.nudge.clear();

		const bought = state.bought;
		if (bought && typeof bought === "object") {
			for (const [path, value] of Object.entries(bought as Record<string, unknown>)) {
				const entry = value && typeof value === "object"
					? (value as Record<string, unknown>)
					: {};
				const count = parseCount(entry.count);
				this.bought.set(path, {
					count: entry.count === null ? null : count,
					check: entry.check === true,
				});
			}
		}

		const nudge = state.nudge;
		if (nudge && typeof nudge === "object") {
			for (const [path, value] of Object.entries(nudge as Record<string, unknown>)) {
				const step = Number(value);
				if (Number.isFinite(step) && step !== 0) this.nudge.set(path, step);
			}
		}
	}

	/** Verandert de ± aanpassing van één product, en bewaart de ronde. */
	setNudge(path: string, step: number): void {
		if (step === 0) this.nudge.delete(path);
		else this.nudge.set(path, step);
		this.saveState();
	}

	/**
	 * Schrijft de ronde weg, gedebounced.
	 *
	 * In de winkel tik je tien producten achter elkaar af; één schrijfactie per
	 * tik is tien sync-events op mobiele data.
	 */
	private saveState = debounce(() => {
		guarded("could not save your shopping round", () => this.writeState());
	}, 1500, true);

	/** Schrijft de ronde nu weg, zonder te wachten op de debounce. */
	async flushState(): Promise<void> {
		this.saveState.cancel();
		await this.writeState();
	}

	private async writeState(): Promise<void> {
		const { vault } = this.plugin.app;
		const path = this.statePath();
		const file = vault.getFileByPath(path);

		const empty = this.bought.size === 0 && this.nudge.size === 0;
		// Geen ronde bezig en nog geen bestand: dan ook geen map aanmaken.
		if (empty && !file) return;

		const state = {
			version: STATE_VERSION,
			bought: Object.fromEntries(this.bought),
			nudge: Object.fromEntries(this.nudge),
		};
		const content = `${JSON.stringify(state, null, "\t")}\n`;

		if (!file) {
			await ensureFolder(vault, path);
			this.lastState = content;
			await vault.create(path, content);
			return;
		}
		if ((await vault.cachedRead(file)) === content) return;
		this.lastState = await vault.process(file, () => content);
	}

	/** Herkent de echo van onze eigen schrijfactie; zie wroteExactly. */
	wroteStateExactly(content: string): boolean {
		return this.lastState !== null && content === this.lastState;
	}

	file(): TFile | null {
		return this.plugin.app.vault.getFileByPath(this.path());
	}

	isListNote(path: string): boolean {
		return normalizePath(path) === this.path();
	}

	/**
	 * Is dit precies wat wij net geschreven hebben?
	 *
	 * Op inhoud en niet op tijd: een venster van 800 ms gooide een vinkje weg
	 * dat de gebruiker er net binnen zette, en dekte tegelijk een trage flush
	 * niet. Zie dezelfde afweging in `PlanStore.wroteExactly`.
	 */
	wroteExactly(content: string): boolean {
		return this.lastWritten !== null && content === this.lastWritten;
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

	private lastState: string | null = null;

	async markBought(product: Product): Promise<void> {
		// Ook de check-vlag bewaren: die wordt hieronder gewist, en zonder
		// bewaren kreeg een product uit "Check first" hem nooit meer terug.
		this.bought.set(product.path, { count: product.count, check: product.check });
		this.nudge.delete(product.path);
		this.saveState();
		await this.plugin.products.update(product, { count: "plus", check: false });
		await this.write();
	}

	async undoBought(product: Product): Promise<void> {
		const before = this.bought.get(product.path);
		this.bought.delete(product.path);
		this.saveState();
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
		this.saveState();
		await this.plugin.products.update(product, { count: "plus", check: false });
	}

	private async undoBoughtQuietly(product: Product): Promise<void> {
		const before = this.bought.get(product.path);
		this.bought.delete(product.path);
		this.saveState();
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
			const fresh = this.template();
			this.lastWritten = fresh;
			await vault.create(path, fresh);
			return;
		}

		const current = await vault.cachedRead(file);
		if (!this.mayWriteTo(current, path)) return;
		clearWarning(file);

		const wanted = this.rebuild(current);
		if (current.trim() === wanted.trim()) return;

		// process() in plaats van modify(): dit is precies de notitie die je
		// waarschijnlijk open hebt staan, en een blinde modify gooit weg wat er
		// tussen lezen en schrijven bij kwam.
		this.lastWritten = await vault.process(file, (latest: string) =>
			this.rebuild(latest)
		);
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

		groupForShopping(this.plugin, buy).forEach((group) => {
			lines.push(`## ${group.shop}`);
			lines.push("");

			group.shelves.forEach(({ shelf, items }) => {
				if (group.shelves.length > 1) {
					lines.push(`### ${shelf}`);
					lines.push("");
				}
				items.forEach((product) => lines.push(this.line(product, false)));
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
}
