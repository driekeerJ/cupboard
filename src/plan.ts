import { TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type PantryPlugin from "./main";
import { Refusal } from "./guard";
import { FORMAT_KEY, PANTRY_FORMAT, isNewer, newerMessage } from "./format";
import { addDays, startOfWeek, toISODate, weekId } from "./date";
import { markdownIn } from "./folder";
import { capturePreviewScroll, viewsFor, writeThroughEditor } from "./plan-note-write";
import { ensureFolder, linkTarget, toLink } from "./notes";
import { asText } from "./text";
import type {
	MealStatus,
	MealType,
	PlannedDay,
	PlannedRecipe,
	ShoppingStop,
	WeekPlan,
} from "./types";

const BLOCK_LANGUAGE = "meal-plan";

/** Eerlijk zijn over wat er met hand-edits in dit blok gebeurt. */
const PLAN_BLOCK_NOTE =
	"# Pantry herschrijft dit blok bij elke wijziging. Eigen velden en opmerkingen hierin gaan verloren.";
/** Matches a fenced ```meal-plan block, capturing its body. */
const BLOCK_PATTERN = /^```meal-plan[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

export { linkTarget, toLink } from "./notes";

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The block is hand-editable, so anything but the two known words is dropped. */
function parseStatus(value: unknown): { status?: MealStatus } {
	const word = asText(value).trim().toLowerCase();
	if (word === "eaten" || word === "skipped") return { status: word };
	return {};
}

/**
 * Wat een tik van de voorraad haalde.
 *
 * De sleutel is een wikilink (`[[Rijst]]`) sinds die vorm leesbaar is; oudere
 * blokken hebben er een kaal pad staan en die blijven werken — `consume.ts`
 * zoekt allebei op. De waarde mag "0.33 pak" zijn; die eenheid staat er voor
 * de lezer en wordt bij het inlezen genegeerd.
 */
function parseUsed(value: unknown): { used?: Record<string, number> } {
	const record = asRecord(value);
	const used: Record<string, number> = {};
	for (const [key, raw] of Object.entries(record)) {
		const amount = Number.parseFloat(asText(raw).replace(",", "."));
		if (Number.isFinite(amount) && amount > 0) used[key] = amount;
	}
	return Object.keys(used).length > 0 ? { used } : {};
}

/** Reads and writes the ```meal-plan block that holds one week of planning. */
export class PlanStore {
	private plugin: PantryPlugin;
	/** De inhoud van onze laatste schrijfactie, om de echo ervan te herkennen. */
	private lastWritten: string | null = null;

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Is dit precies wat wij net geschreven hebben?
	 *
	 * Eerst was dit een tijdvenster van 600 ms, en dat was aan twee kanten mis:
	 * een wijziging die sync binnen dat venster binnenbracht werd weggegooid,
	 * en de vertraagde flush van `writeThroughEditor` duurt juist langer dan
	 * 600 ms. Een vergelijking op inhoud heeft geen van beide problemen — hij
	 * herkent onze eigen echo precies, en niets anders.
	 */
	wroteExactly(content: string): boolean {
		return this.lastWritten !== null && content === this.lastWritten;
	}

	/** True voor elke notitie in de planmap. */
	isPlanNote(path: string): boolean {
		const folder = normalizePath(this.plugin.settings.planFolder || "Meal plans");
		return normalizePath(path).startsWith(`${folder}/`);
	}

	notePath(weekStart: Date): string {
		const folder = normalizePath(this.plugin.settings.planFolder || "Meal plans");
		return normalizePath(`${folder}/${weekId(weekStart)}.md`);
	}

	noteFile(weekStart: Date): TFile | null {
		return this.plugin.app.vault.getFileByPath(this.notePath(weekStart));
	}

	/**
	 * Elke weeknotitie die `span` dagen vanaf `start` raakt, van vroeg naar
	 * laat. Boodschappen doen loopt niet met de weekgrens mee, dus wie over
	 * een periode rekent leest zoveel notities als die periode raakt.
	 */
	async covering(start: Date, span: number): Promise<WeekPlan[]> {
		const { weekStartDay } = this.plugin.settings;
		const seen = new Set<string>();
		const plans: WeekPlan[] = [];

		for (let offset = 0; offset < Math.max(1, span); offset += 1) {
			const weekStart = startOfWeek(addDays(start, offset), weekStartDay);
			const key = toISODate(weekStart);
			if (seen.has(key)) continue;
			seen.add(key);
			plans.push(await this.load(weekStart));
		}

		return plans;
	}

	static emptyPlan(weekStart: Date): WeekPlan {
		return { weekStart: toISODate(weekStart), days: [] };
	}

	async load(weekStart: Date): Promise<WeekPlan> {
		const file = this.noteFile(weekStart);
		if (!file) return PlanStore.emptyPlan(weekStart);

		// Staat de notitie open in source mode, dan schreef `update()` alleen in
		// de editorbuffer en loopt de schijf achter. `cachedRead` geeft dan de
		// oude versie. Dezelfde route als bij schrijven dus, en pas daarna de
		// schijf.
		const content =
			this.readFromEditor(file) ?? (await this.plugin.app.vault.cachedRead(file));
		return this.planFrom(content, weekStart);
	}

	/**
	 * Het plan zoals het in deze notitietekst staat.
	 *
	 * Geen blok is een lege week — een notitie die iemand zelf begon en waar
	 * Pantry het blok nog aan toe moet voegen. Een blok dat er wél is maar niet
	 * te lezen valt (YAML-fout, opening zonder sluiting) is iets anders: dan
	 * weten we niet wat er gepland is. Dat plan is leeg én gemarkeerd, en
	 * `update()` weigert erop te schrijven. Anders wist de eerstvolgende
	 * maaltijd die je erbij sleept stilletjes de hele week.
	 */
	private planFrom(content: string, weekStart: Date): WeekPlan {
		const match = BLOCK_PATTERN.exec(content);
		if (!match) {
			if (content.includes(`\`\`\`${BLOCK_LANGUAGE}`)) {
				return {
					...PlanStore.emptyPlan(weekStart),
					unreadable: "the meal-plan block has no closing fence",
				};
			}
			return PlanStore.emptyPlan(weekStart);
		}
		return this.normalise(PlanStore.parse(match[1] ?? "", weekStart));
	}

	/**
	 * Upgrades plans written by earlier versions, which stored internal ids.
	 * Anything that still resolves to a configured meal or person is rewritten
	 * to its readable name; unknown values are left untouched.
	 */
	normalise(plan: WeekPlan): WeekPlan {
		const { meals } = this.plugin.settings;
		const household = this.plugin.people.all();
		for (const day of plan.days) {
			for (const slot of day.meals) {
				const meal = meals.find((item) => isMeal(slot.meal, item));
				if (meal) slot.meal = mealLabel(meal);
				for (const entry of slot.recipes) {
					entry.eaters = entry.eaters.map((stored) => {
						const member = household.find((person) =>
							isEater(stored, person.name, person.id)
						);
						return member ? member.name.trim() || member.id : stored;
					});
				}
			}
		}
		return plan;
	}

	/**
	 * Defensive: the block is hand-editable, so anything may show up in it.
	 *
	 * Een YAML-fout geeft een leeg plan dat als onleesbaar gemarkeerd is —
	 * niet stilletjes leeg, want leeg zou bij de volgende schrijfactie de
	 * waarheid worden.
	 */
	static parse(body: string, weekStart: Date): WeekPlan {
		let raw: unknown;
		try {
			raw = parseYaml(body);
		} catch (error) {
			const reason = error instanceof Error ? error.message.split("\n")[0] ?? "" : "";
			return {
				...PlanStore.emptyPlan(weekStart),
				unreadable: `the meal-plan block is not valid YAML${reason ? ` (${reason})` : ""}`,
			};
		}

		const record = asRecord(raw);
		if (isNewer(record[FORMAT_KEY])) {
			return { ...PlanStore.emptyPlan(weekStart), unreadable: newerMessage(record[FORMAT_KEY]) };
		}
		const days: PlannedDay[] = asArray(record.days).map((rawDay) => {
			const day = asRecord(rawDay);
			const note = asText(day.note).trim();
			const shopping = parseShopping(day.shopping);
			return {
				date: asText(day.date),
				...(note.length > 0 ? { note } : {}),
				...(shopping.length > 0 ? { shopping } : {}),
				meals: asArray(day.meals).map((rawMeal) => {
					const meal = asRecord(rawMeal);
					return {
						meal: asText(meal.meal),
						recipes: asArray(meal.recipes).map((rawRecipe) => {
							const entry = asRecord(rawRecipe);
							const eaters = asArray(entry.eaters).map(asText).filter(Boolean);
							const guests = Number(entry.guests ?? 0);
							return {
								recipe: asText(entry.recipe),
								eaters,
								guests: Number.isFinite(guests) ? guests : 0,
								...parseStatus(entry.status),
								...parseUsed(entry.used),
							} satisfies PlannedRecipe;
						}),
					};
				}),
			};
		});

		return {
			weekStart: asText(record.weekStart) || toISODate(weekStart),
			days: days.filter((day) => day.date.length > 0),
		};
	}

	/** Only the fields that carry meaning, so the block stays readable by hand. */
	private cleanRecipe(entry: PlannedRecipe): Record<string, unknown> {
		const clean: Record<string, unknown> = {
			recipe: entry.recipe,
			eaters: entry.eaters,
			guests: entry.guests,
		};
		if (entry.status) clean.status = entry.status;
		if (entry.used && Object.keys(entry.used).length > 0) {
			clean.used = this.describeUsed(entry.used);
		}
		return clean;
	}

	/**
	 * `Products/Rijst.md: 0.33` zegt een mens niets — een derde van wát? En het
	 * is een kaal pad in een code fence, dus Obsidian werkt het bij hernoemen
	 * niet bij: daarna gaf `byPath` null en kwam de rijst er bij het uitvinken
	 * nooit meer bij, zonder dat iets dat meldde.
	 *
	 * `[[Rijst]]: 0.33 pak` is te lezen en te volgen.
	 */
	private describeUsed(used: Record<string, number>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [key, amount] of Object.entries(used)) {
			const rounded = `${Math.round(amount * 1000) / 1000}`;
			const product =
				this.plugin.products.byPath(key) ?? this.plugin.products.match(key);
			if (!product) {
				// Onbekend product: laat de sleutel staan zoals hij is, zodat er
				// niets verdwijnt wat later weer op te zoeken valt.
				out[key] = rounded;
				continue;
			}
			out[toLink(product.name)] = product.unit
				? `${rounded} ${product.unit}`
				: rounded;
		}
		return out;
	}

	serialise(plan: WeekPlan): string {
		const clean = {
			[FORMAT_KEY]: PANTRY_FORMAT,
			weekStart: plan.weekStart,
			days: plan.days
				.map((day) => ({
					date: day.date,
					...(day.note && day.note.trim().length > 0
						? { note: day.note.trim() }
						: {}),
					...(day.shopping && day.shopping.length > 0
						? { shopping: day.shopping.map(cleanStop) }
						: {}),
					meals: day.meals
						.map((meal) => ({
							meal: meal.meal,
							recipes: meal.recipes.map((entry) => this.cleanRecipe(entry)),
						}))
						.filter((meal) => meal.recipes.length > 0),
				}))
				// A day with nothing planned but a note or a shopping stop still
				// has something to say.
				.filter(
					(day) =>
						day.meals.length > 0 ||
						day.note !== undefined ||
						day.shopping !== undefined
				)
				.sort((a, b) => a.date.localeCompare(b.date)),
		};
		// Dit blok wordt van nul opgebouwd: lege dagen vallen weg, de dagen
		// worden gesorteerd en onbekende sleutels overleven het niet. Dat is
		// verdedigbaar \u2014 het is gegenereerde inhoud \u2014 maar niet als je het
		// pas merkt nadat je eigen opmerking verdwenen is. Dus staat het er nu
		// bij, in het blok zelf, waar de lezer is.
		return `${PLAN_BLOCK_NOTE}\n${stringifyYaml(clean).trimEnd()}`;
	}

	private blockFor(plan: WeekPlan): string {
		return `\`\`\`${BLOCK_LANGUAGE}\n${this.serialise(plan)}\n\`\`\``;
	}

	/**
	 * Past één wijziging toe op het plan zoals het **nu in de notitie staat**,
	 * en geeft het plan terug zoals het geschreven is.
	 *
	 * Dit is de enige manier om een weekplan te schrijven. Er was een
	 * `save(plan)` die een compleet plan uit het geheugen wegschreef, en die
	 * kostte op 2026-09-09 een week: de planner op de telefoon had de notitie
	 * geladen vóórdat Sync de versie van de Mac bracht, toonde dus een lege
	 * week, en "maaltijd toevoegen" schreef die lege week plus één maaltijd
	 * over alles heen — inclusief het boodschappenmoment van de lijst. Een
	 * geheugenkopie is per definitie oud; de notitie is de waarheid, en een
	 * wijziging is een wijziging **daarop**.
	 *
	 * De wijziging wordt binnen `vault.process` toegepast, dus op de inhoud
	 * die Obsidian op dat moment heeft, en het resultaat vervangt alleen het
	 * blok. `change` moet synchroon zijn en mag opnieuw aangeroepen worden op
	 * een ander plan-object dan de aanroeper in beeld heeft — zoek een
	 * maaltijd dus op datum, maaltijd en positie, niet op objectidentiteit.
	 *
	 * Is de notitie niet te lezen (`unreadable`), dan wordt er niets
	 * geschreven en gooit dit een fout: liever een melding dan een week kwijt.
	 */
	async update(weekStart: Date, change: (plan: WeekPlan) => void): Promise<WeekPlan> {
		const { vault } = this.plugin.app;
		const path = this.notePath(weekStart);

		const existing = vault.getFileByPath(path);
		if (!existing) {
			const plan = PlanStore.emptyPlan(weekStart);
			change(plan);
			await ensureFolder(vault, path);
			const fresh = PlanStore.template(weekStart, this.blockFor(plan));
			this.lastWritten = fresh;
			await vault.create(path, fresh);
			return plan;
		}

		// Prefer the editor when the note is open: rewriting the whole file
		// replaces the editor's document, which drops the cursor at the end and
		// scrolls the note to the bottom under the user. De editor flusht pas
		// seconden later naar schijf; onthoud nu al wat er straks in het
		// modify-event zal staan. En lees dan ook uít de editor: de schijf
		// loopt op dat moment achter.
		const inEditor = this.readFromEditor(existing);
		if (inEditor !== null) {
			const plan = this.planFrom(inEditor, weekStart);
			this.refuseIfUnreadable(plan, existing);
			change(plan);
			const throughEditor = writeThroughEditor(
				this.plugin.app,
				existing,
				this.blockFor(plan),
				BLOCK_PATTERN
			);
			if (throughEditor !== null) {
				this.lastWritten = throughEditor;
				return plan;
			}
			// Geen blok in de editor: dan voegt process() het hieronder toe.
		}

		const restoreScroll = capturePreviewScroll(this.plugin.app, existing);
		let result: WeekPlan | null = null;
		let written: string | null = null;
		const outcome = await vault.process(existing, (content: string) => {
			const plan = this.planFrom(content, weekStart);
			if (plan.unreadable) return content;
			change(plan);
			result = plan;
			const block = this.blockFor(plan);
			if (BLOCK_PATTERN.test(content)) {
				// De functievorm, want `block` bevat vrije tekst: de dagnotitie
				// typ je zelf. Als vervangingspatroon zou `$&` het complete
				// oude blok midden in het nieuwe plakken en `$1` de oude YAML.
				written = content.replace(BLOCK_PATTERN, () => block);
			} else {
				written = `${content.trimEnd()}\n\n${block}\n`;
			}
			return written;
		});
		restoreScroll();

		if (result === null || written === null) {
			this.refuseIfUnreadable(this.planFrom(outcome, weekStart), existing);
			throw new Error(`Pantry could not update ${path}`);
		}
		this.lastWritten = written;
		return result;
	}

	private refuseIfUnreadable(plan: WeekPlan, file: TFile): void {
		if (!plan.unreadable) return;
		throw new Refusal(`Pantry did not save ${file.basename}: ${plan.unreadable}.`);
	}

	/** De inhoud zoals de open editor hem kent, of null als hij niet openstaat. */
	private readFromEditor(file: TFile): string | null {
		for (const view of viewsFor(this.plugin.app, file)) {
			if (view.getMode() !== "source") continue;
			return view.editor.getValue();
		}
		return null;
	}

	/** Every plan note in the plan folder. */
	private planFiles(): TFile[] {
		const folder = normalizePath(this.plugin.settings.planFolder || "Meal plans");
		return markdownIn(this.plugin.app.vault, folder);
	}

	/**
	 * Rewrites a meal or eater name across every existing plan note, so renaming
	 * someone in the settings never orphans the weeks you already planned.
	 */
	/**
	 * Werkt de receptverwijzingen in alle weekplannen bij na een hernoeming.
	 *
	 * `toLink()` schrijft een nette wikilink, maar hij staat binnen een
	 * ```meal-plan-fence en **Obsidian indexeert geen links in code blocks**.
	 * Hernoem je een recept, dan werkt Obsidian deze verwijzing dus niet bij:
	 * `cook.file()` vindt daarna niets, `NeedIndex` slaat de maaltijd over, en
	 * die stopt stilletjes met bijdragen aan je boodschappenlijst. Geen melding,
	 * geen spoor.
	 */
	async renameRecipe(oldName: string, newName: string): Promise<number> {
		const from = oldName.trim().toLowerCase();
		const to = newName.trim();
		if (from.length === 0 || to.length === 0 || from === to.toLowerCase()) return 0;

		return this.rewriteAll((plan) => {
			let touched = false;
			for (const day of plan.days) {
				for (const meal of day.meals) {
					for (const entry of meal.recipes) {
						if (linkTarget(entry.recipe).toLowerCase() !== from) continue;
						entry.recipe = toLink(to);
						touched = true;
					}
				}
			}
			return touched;
		});
	}

	async renameEverywhere(
		kind: "meal" | "eater",
		oldName: string,
		newName: string
	): Promise<number> {
		const from = oldName.trim();
		const to = newName.trim();
		if (from.length === 0 || to.length === 0 || from === to) return 0;

		const matches = (value: string) =>
			value.trim().toLowerCase() === from.toLowerCase();

		return this.rewriteAll((plan) => {
			let touched = false;
			for (const day of plan.days) {
				for (const meal of day.meals) {
					if (kind === "meal" && matches(meal.meal)) {
						meal.meal = to;
						touched = true;
						continue;
					}
					if (kind !== "eater") continue;
					for (const entry of meal.recipes) {
						const next = entry.eaters.map((eater) =>
							matches(eater) ? to : eater
						);
						if (next.some((value, index) => value !== entry.eaters[index])) {
							entry.eaters = next;
							touched = true;
						}
					}
				}
			}
			return touched;
		});
	}

	/**
	 * Eén wijziging over alle weeknotities, elk binnen zijn eigen
	 * `vault.process`: gelezen en herschreven in dezelfde stap, zodat er geen
	 * versie tussen zit die intussen van een ander apparaat kwam. Een notitie
	 * zonder blok, of met een onleesbaar blok, blijft met rust — daar valt
	 * niets in te hernoemen zonder de rest te vernielen.
	 */
	private async rewriteAll(change: (plan: WeekPlan) => boolean): Promise<number> {
		let changedNotes = 0;
		for (const file of this.planFiles()) {
			let touched = false;
			const written = await this.plugin.app.vault.process(file, (current: string) => {
				const match = BLOCK_PATTERN.exec(current);
				if (!match) return current;
				const plan = PlanStore.parse(match[1] ?? "", new Date());
				if (plan.unreadable || !change(plan)) return current;
				touched = true;
				// Functievorm: zie `update()`. Een dagnotitie met `$&` erin zou
				// het oude blok midden in het nieuwe plakken.
				return current.replace(BLOCK_PATTERN, () => this.blockFor(plan));
			});
			if (!touched) continue;
			this.lastWritten = written;
			changedNotes++;
		}
		return changedNotes;
	}

	private static template(weekStart: Date, block: string): string {
		const end = addDays(weekStart, 6);
		return [
			"---",
			`week: ${weekId(weekStart)}`,
			`weekStart: ${toISODate(weekStart)}`,
			`weekEnd: ${toISODate(end)}`,
			"---",
			"",
			`# ${weekId(weekStart).replace("-W", " · week ")}`,
			"",
			block,
			"",
			"## Notes",
			"",
			"",
		].join("\n");
	}

}

/* ------------------------------------------------------------------ *
 * Plan helpers — kept pure so they are easy to reason about.
 * ------------------------------------------------------------------ */

function sameLabel(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** What a meal is called in the note. Falls back to its id if left unnamed. */
export function mealLabel(meal: MealType): string {
	return meal.name.trim() || meal.id;
}

/** Accepts the meal name and, for plans written by older versions, its id. */
export function isMeal(stored: string, meal: MealType): boolean {
	return sameLabel(stored, mealLabel(meal)) || sameLabel(stored, meal.id);
}

export function recipesAt(
	plan: WeekPlan,
	date: string,
	meal: MealType
): PlannedRecipe[] {
	return (
		plan.days
			.find((day) => day.date === date)
			?.meals.find((entry) => isMeal(entry.meal, meal))?.recipes ?? []
	);
}

/** What the calendar says about this day, "" when nothing was written. */
export function noteAt(plan: WeekPlan, date: string): string {
	return plan.days.find((day) => day.date === date)?.note ?? "";
}

/** Stores the day note. Empty text removes it rather than saving a blank line. */
export function setNote(plan: WeekPlan, date: string, text: string): void {
	const value = text.trim();
	let day = plan.days.find((item) => item.date === date);
	if (!day) {
		if (value.length === 0) return;
		day = { date, meals: [] };
		plan.days.push(day);
	}
	if (value.length === 0) delete day.note;
	else day.note = value;
}

/**
 * Leest de boodschappenmomenten van een dag uit het blok.
 *
 * In de notitie staat het als `- shop: AH` met daaronder `before: Lunch` of
 * `after: Dinner`, want dat is te lezen zonder de plugin erbij. Intern wordt
 * het één maaltijdnaam plus een kant.
 */
function parseShopping(raw: unknown): ShoppingStop[] {
	return asArray(raw)
		.map((item) => {
			const record = asRecord(item);
			const shop = asText(record.shop).trim();
			if (shop.length === 0) return null;
			const after = asText(record.after).trim();
			const before = asText(record.before).trim();
			if (after.length > 0) return { shop, meal: after, when: "after" as const };
			if (before.length > 0) {
				return { shop, meal: before, when: "before" as const };
			}
			return { shop };
		})
		.filter((stop): stop is ShoppingStop => stop !== null);
}

function cleanStop(stop: ShoppingStop): Record<string, unknown> {
	const clean: Record<string, unknown> = { shop: stop.shop };
	const meal = (stop.meal ?? "").trim();
	if (meal.length > 0) clean[stop.when === "after" ? "after" : "before"] = meal;
	return clean;
}

/** De boodschappenmomenten van deze dag, in de volgorde waarin ze staan. */
export function shoppingAt(plan: WeekPlan, date: string): ShoppingStop[] {
	return plan.days.find((day) => day.date === date)?.shopping ?? [];
}

/** Vervangt de boodschappenmomenten van een dag; leeg haalt de sleutel weg. */
export function setShopping(
	plan: WeekPlan,
	date: string,
	stops: ShoppingStop[]
): void {
	let day = plan.days.find((item) => item.date === date);
	if (!day) {
		if (stops.length === 0) return;
		day = { date, meals: [] };
		plan.days.push(day);
	}
	if (stops.length === 0) delete day.shopping;
	else day.shopping = stops;
}

export function addRecipe(
	plan: WeekPlan,
	date: string,
	meal: MealType,
	entry: PlannedRecipe,
	index?: number
): void {
	let day = plan.days.find((item) => item.date === date);
	if (!day) {
		day = { date, meals: [] };
		plan.days.push(day);
	}
	let slot = day.meals.find((item) => isMeal(item.meal, meal));
	if (!slot) {
		slot = { meal: mealLabel(meal), recipes: [] };
		day.meals.push(slot);
	} else {
		// Heal plans that still carry an id or an older spelling.
		slot.meal = mealLabel(meal);
	}
	const at = index === undefined ? slot.recipes.length : index;
	slot.recipes.splice(at, 0, entry);
}

export function removeRecipe(
	plan: WeekPlan,
	date: string,
	meal: MealType,
	index: number
): PlannedRecipe | null {
	const day = plan.days.find((item) => item.date === date);
	const slot = day?.meals.find((item) => isMeal(item.meal, meal));
	if (!slot || index < 0 || index >= slot.recipes.length) return null;
	const [removed] = slot.recipes.splice(index, 1);
	return removed ?? null;
}

/**
 * Household factors plus guests, each guest counting as one full portion.
 * Names that no longer exist in the household still count as a full portion,
 * so an old plan keeps telling the truth about what was cooked back then.
 */
export function servingsFor(plugin: PantryPlugin, entry: PlannedRecipe): number {
	const fromHousehold = entry.eaters.reduce((total, stored) => {
		const member = plugin.settings.household.find(
			(person) => sameLabel(stored, person.name) || sameLabel(stored, person.id)
		);
		return total + (member ? member.portionFactor || 0 : 1);
	}, 0);
	return fromHousehold + Math.max(0, entry.guests || 0);
}

/** True when this stored eater refers to the given household member. */
export function isEater(stored: string, name: string, id: string): boolean {
	return sameLabel(stored, name) || sameLabel(stored, id);
}

export function formatServings(value: number): string {
	return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/0+$/, "");
}

/**
 * Een maaltijd in het plan aanwijzen zonder objectidentiteit: `update()`
 * geeft de wijziging een vers gelezen plan, dus het object dat het scherm
 * vasthoudt is daar nooit in te vinden. Datum, maaltijd en positie wijzen
 * hem aan; het recept is de controle dat het nog steeds dezelfde is — is
 * de positie intussen verschoven (een ander apparaat haalde er een weg),
 * dan wint het recept in dezelfde maaltijd.
 */
export interface EntryRef {
	date: string;
	meal: string;
	index: number;
	/** Receptnaam zonder haakjes, zie `linkTarget`. */
	recipe: string;
}

export function refOf(
	date: string,
	meal: MealType | string,
	index: number,
	entry: PlannedRecipe
): EntryRef {
	return {
		date,
		meal: typeof meal === "string" ? meal : mealLabel(meal),
		index,
		recipe: linkTarget(entry.recipe),
	};
}

export function entryAt(plan: WeekPlan, ref: EntryRef): PlannedRecipe | null {
	const slot = plan.days
		.find((day) => day.date === ref.date)
		?.meals.find((meal) => sameLabel(meal.meal, ref.meal));
	if (!slot) return null;
	const wanted = ref.recipe.toLowerCase();
	const atIndex = slot.recipes[ref.index];
	if (atIndex && linkTarget(atIndex.recipe).toLowerCase() === wanted) return atIndex;
	return slot.recipes.find((entry) => linkTarget(entry.recipe).toLowerCase() === wanted) ?? null;
}
