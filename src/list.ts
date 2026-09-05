import { TFile, debounce, normalizePath } from "obsidian";
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
import {
	assignShop,
	compareMoments,
	type Assignment,
	type Moment,
} from "./arrival";
import {
	DEFAULT_EXTRA_AMOUNT,
	extraLabel,
	newExtraId,
	parseExtras,
	type Extra,
} from "./extras";

export const NO_SHOP = "Anywhere";
export const NO_CATEGORY = "Other";

/** Eén winkel met haar schappen, in de volgorde waarin je erlangs loopt. */
export interface ShopGroup {
	shop: string;
	items: Product[];
	/**
	 * Losse boodschappen voor deze winkel — dingen die geen product zijn.
	 * Ze lopen mee in dezelfde schappen als de producten, want in de winkel
	 * is een pak batterijen net zo goed iets dat op een schap ligt.
	 */
	extras: Extra[];
	shelves: { shelf: string; items: Product[]; extras: Extra[] }[];
}

/**
 * De boodschappenlijst gegroepeerd per winkel en per schap.
 *
 * De notitie en het boodschappenscherm bouwden dit allebei zelf op \u2014 dezelfde
 * winkelgroepering, dezelfde schapbuckets, dezelfde sortering, twee keer
 * uitgeschreven. Wat er in de notitie stond en wat je op je telefoon zag kon
 * daardoor uit elkaar lopen zonder dat iemand er iets aan veranderd had.
 */
export function assignmentFor(plugin: PantryPlugin, product: Product): Assignment {
	return assignShop(
		product.shops,
		plugin.needs.momentFor(product),
		plugin.needs.arrivals()
	);
}

/**
 * Waarom dit product niet in zijn eigen winkel ligt, in één regel — of null
 * als er niets bijzonders aan de hand is.
 *
 * Zonder deze regel is het onverklaarbaar: je zet een product bewust op AH en
 * treft het bij de Lidl aan. De reden hoort naast het product te staan, niet
 * in een handleiding.
 */
export function assignmentNote(assignment: Assignment): string | null {
	if (assignment.late) return `${assignment.shop} arrives too late`;
	if (assignment.movedFrom) return `needed before ${assignment.movedFrom} arrives`;
	return null;
}

/**
 * De producten die dit maaltijdvak vraagt en die je er niet op tijd voor in
 * huis krijgt.
 *
 * Drie dingen moeten waar zijn: het recept vraagt erom, je hebt het niet al
 * staan, en geen van de winkels waar het te krijgen is komt op tijd langs. Dat
 * eerste is waarom een snuf zout hier nooit opduikt, en dat tweede is waarom
 * "ik heb het al" een geldige oplossing is — je telt het en de melding gaat weg.
 *
 * Het moment is dát van dit vak, niet het vroegste moment van het product:
 * kikkererwten die woensdag én volgende week dinsdag nodig zijn, zijn alleen
 * woensdag een probleem.
 */
export function lateProducts(
	plugin: PantryPlugin,
	date: string,
	meal: number
): { product: Product; shop: string }[] {
	const moment = { date, meal };
	const arrivals = plugin.needs.arrivals();
	const late: { product: Product; shop: string }[] = [];

	for (const product of plugin.needs.productsAt(date, meal)) {
		const amount = plugin.list.amount(product);
		// null is "nooit geteld": dan weet je niet of je het hebt, en dat is
		// geen reden om te zwijgen.
		if (amount !== null && amount <= 0) continue;
		const assignment = assignShop(product.shops, moment, arrivals);
		if (assignment.late) late.push({ product, shop: assignment.shop });
	}

	return late.sort((a, b) => a.product.name.localeCompare(b.product.name));
}

/**
 * Eén emmer per winkel of per schap: de naam zoals hij getoond wordt, en wat
 * erin ligt. Gesleuteld op kleine letters, want "Koeling" en "koeling" zijn
 * hetzelfde schap — en twee kopjes voor één schap is precies het soort ruis
 * waar je met een kar in je hand overheen leest.
 */
interface Bucket {
	name: string;
	items: Product[];
	extras: Extra[];
}

function bucketOf(map: Map<string, Bucket>, name: string): Bucket {
	const key = name.toLowerCase();
	const found = map.get(key);
	if (found) return found;
	const fresh: Bucket = { name, items: [], extras: [] };
	map.set(key, fresh);
	return fresh;
}

export function groupForShopping(
	plugin: PantryPlugin,
	items: Product[],
	extras: readonly Extra[] = []
): ShopGroup[] {
	const byShop = new Map<string, Bucket>();

	for (const product of items) {
		// Niet `product.shop`, maar waar het gekocht móét worden: een winkel
		// die pas na de maaltijd levert waarvoor je het nodig hebt, is geen
		// winkel waar je dit kunt halen.
		const shop = assignmentFor(plugin, product).shop || NO_SHOP;
		bucketOf(byShop, shop).items.push(product);
	}

	// Een losse boodschap kent de aankomstlogica niet: hij ligt waar jij zegt
	// dat hij ligt, en anders nergens. Daarom hier geen `assignShop`.
	for (const extra of extras) {
		bucketOf(byShop, extra.shop.trim() || NO_SHOP).extras.push(extra);
	}

	// Op volgorde van binnenkomst: de winkel waar je vandaag heen loopt hoort
	// bovenaan te staan, niet de winkel die toevallig met een A begint. Een
	// winkel zonder moment in het plan is "altijd beschikbaar" en gaat vóór de
	// bezorgingen; zonder winkel is de restcategorie en staat achteraan.
	const arrivals = plugin.needs.arrivals();
	const rank = (shop: string): Moment | null =>
		arrivals.get(shop.trim().toLowerCase()) ?? null;

	return [...byShop.values()]
		.sort((a, b) => {
			if (a.name === NO_SHOP) return 1;
			if (b.name === NO_SHOP) return -1;
			const left = rank(a.name);
			const right = rank(b.name);
			if (left && right) {
				const order = compareMoments(left, right);
				if (order !== 0) return order;
			} else if (left || right) {
				return left ? 1 : -1;
			}
			return a.name.localeCompare(b.name);
		})
		.map((shop) => {
			const byShelf = new Map<string, Bucket>();
			for (const product of shop.items) {
				bucketOf(byShelf, product.shelf || NO_CATEGORY).items.push(product);
			}
			for (const extra of shop.extras) {
				bucketOf(byShelf, extra.shelf.trim() || NO_CATEGORY).extras.push(extra);
			}

			const shelves = [...byShelf.values()]
				.sort((a, b) => plugin.compareShelves(shop.name, a.name, b.name))
				.map((shelf) => ({
					shelf: shelf.name,
					items: [...shelf.items].sort((a, b) =>
						a.name.localeCompare(b.name)
					),
					extras: [...shelf.extras].sort((a, b) =>
						a.name.localeCompare(b.name)
					),
				}));

			return {
				shop: shop.name,
				items: shop.items,
				extras: shop.extras,
				shelves,
			};
		});
}

const BOUGHT_HEADING = "## In the basket";
const CHECK_HEADING = "## Check first";

const TICK = /^\s*-\s\[([ xX])\]\s*\[\[([^\]|#]+)/;

/**
 * Elk vinkvakje, met of zonder wikilink erachter.
 *
 * Losse boodschappen wijzen nergens heen — er is geen notitie om naar te
 * linken — dus `TICK` ziet ze niet. Deze wel, en wat er dan staat wordt
 * vergeleken met de losse regels die we kennen; iets anders raken we niet aan.
 */
const ANY_TICK = /^\s*-\s\[([ xX])\]\s*(.+?)\s*$/;

/** Minstens één, altijd heel: een halve zak batterijen bestaat niet. */
function cleanAmount(value: number): number {
	const amount = Math.round(Number(value));
	return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_EXTRA_AMOUNT;
}

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
	/**
	 * Losse boodschappen: wat je erbij bedenkt en wat geen product is.
	 *
	 * Ze horen bij deze ronde, net als het mandje, en verdwijnen zodra je ze
	 * afvinkt. Zie src/extras.ts voor waarom ze hier wonen en niet als notitie.
	 */
	readonly extras: Extra[] = [];

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
		this.extras.length = 0;

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

		this.extras.push(...parseExtras(state.extras));
	}

	// ------------------------------------------------------- losse boodschappen

	extraById(id: string): Extra | null {
		return this.extras.find((extra) => extra.id === id) ?? null;
	}

	/**
	 * Zet een los regeltje op de lijst.
	 *
	 * Meteen wegschrijven en niet gedebounced: dit is één bewuste handeling
	 * met iets erin dat alleen jij wist. Sluit Obsidian een seconde later af,
	 * dan is precies dat kwijt — en anders dan een tik op een product is er
	 * geen productnotitie die het alsnog onthoudt.
	 */
	async addExtra(draft: Omit<Extra, "id">): Promise<Extra | null> {
		const name = draft.name.trim();
		if (name.length === 0) return null;

		const extra: Extra = {
			id: newExtraId(),
			name,
			amount: cleanAmount(draft.amount),
			shop: draft.shop.trim(),
			shelf: draft.shelf.trim(),
		};
		this.extras.push(extra);
		await this.flushState();
		await this.write();
		return extra;
	}

	async updateExtra(
		id: string,
		patch: Partial<Omit<Extra, "id">>
	): Promise<void> {
		const extra = this.extraById(id);
		if (!extra) return;

		if (patch.name !== undefined) {
			const name = patch.name.trim();
			if (name.length > 0) extra.name = name;
		}
		if (patch.amount !== undefined) extra.amount = cleanAmount(patch.amount);
		if (patch.shop !== undefined) extra.shop = patch.shop.trim();
		if (patch.shelf !== undefined) extra.shelf = patch.shelf.trim();

		await this.flushState();
		await this.write();
	}

	/**
	 * Afvinken is wissen: een los regeltje heeft geen voorraad om naar terug
	 * te vallen, dus er valt niets te bewaren en niets op te ruimen.
	 */
	async removeExtra(id: string): Promise<void> {
		const at = this.extras.findIndex((extra) => extra.id === id);
		if (at === -1) return;
		this.extras.splice(at, 1);
		await this.flushState();
		await this.write();
	}

	/** Dezelfde regel terugvinden vanuit de notitie; zie syncFromNote. */
	private matchExtra(text: string): Extra | null {
		const name = text.replace(/\s*·\s*\d+(\s.*)?$/, "").trim().toLowerCase();
		if (name.length === 0) return null;
		return (
			this.extras.find((extra) => extra.name.toLowerCase() === name) ?? null
		);
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

		const empty =
			this.bought.size === 0 &&
			this.nudge.size === 0 &&
			this.extras.length === 0;
		// Geen ronde bezig en nog geen bestand: dan ook geen map aanmaken.
		if (empty && !file) return;

		const state = {
			version: STATE_VERSION,
			bought: Object.fromEntries(this.bought),
			nudge: Object.fromEntries(this.nudge),
			extras: this.extras,
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
			// `pantry: ignore`: bestaat alleen zodat recepten ernaar kunnen
			// wijzen. Nooit op de lijst, wat er ook in `minimum` staat.
			if (product.ignored) return;
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
		const tickedExtras: string[] = [];

		for (const line of content.split(/\r?\n/)) {
			if (line.startsWith("## ")) {
				inBought = line.trim() === BOUGHT_HEADING;
				continue;
			}
			const box = ANY_TICK.exec(line);
			if (!box) continue;
			const ticked = (box[1] ?? "").toLowerCase() === "x";

			const match = TICK.exec(line);
			if (match) {
				const product = this.resolve((match[2] ?? "").trim());
				if (!product) continue;

				if (ticked && !inBought && !this.bought.has(product.path)) {
					await this.markBoughtQuietly(product);
				} else if (!ticked && inBought && this.bought.has(product.path)) {
					await this.undoBoughtQuietly(product);
				}
				continue;
			}

			// Geen wikilink: dan is het een losse boodschap, of het is niet van
			// ons. Alleen een naam die we herkennen telt, en alleen een vinkje
			// — een los regeltje afvinken is het wissen ervan.
			if (!ticked) continue;
			const extra = this.matchExtra((box[2] ?? "").trim());
			if (extra) tickedExtras.push(extra.id);
		}

		// Pas na de lus, want wissen tijdens het lezen laat `matchExtra` naar
		// een lijst kijken die halverwege verandert.
		if (tickedExtras.length > 0) {
			for (const id of tickedExtras) {
				const at = this.extras.findIndex((extra) => extra.id === id);
				if (at !== -1) this.extras.splice(at, 1);
			}
			await this.flushState();
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
		return (
			buy.length === 0 &&
			unsure.length === 0 &&
			this.bought.size === 0 &&
			this.extras.length === 0
		);
	}

	async refresh(): Promise<void> {
		await this.plugin.needs.rebuild(new Date());
		await this.write();
	}

	private render(): string {
		const { buy, unsure } = this.buckets();
		const lines: string[] = [];

		lines.push(SIGNATURE);
		lines.push("");

		if (this.isEmpty()) {
			lines.push("Nothing needed.");
			lines.push("");
			return lines.join("\n");
		}

		groupForShopping(this.plugin, buy, this.extras).forEach((group) => {
			lines.push(`## ${group.shop}`);
			lines.push("");

			group.shelves.forEach(({ shelf, items, extras }) => {
				if (group.shelves.length > 1) {
					lines.push(`### ${shelf}`);
					lines.push("");
				}
				items.forEach((product) => lines.push(this.line(product, false)));
				// Losse boodschappen onder de producten van hetzelfde schap:
				// je loopt er in één keer langs, en dat het geen product is
				// merk je aan het ontbreken van de link.
				extras.forEach((extra) => lines.push(`- [ ] ${extraLabel(extra)}`));
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
		const note = assignmentNote(assignmentFor(this.plugin, product));
		const why = note ? ` — ${note}` : "";
		return `- [${box}] [[${product.name}]] · ${text}${why}`;
	}
}
