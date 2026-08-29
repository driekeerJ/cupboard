import { TFile } from "obsidian";
import type PantryPlugin from "./main";
import { groupIngredientsByStep } from "./cook-groups";
import {
	COOK_MARK,
	COOK_MARK_VALUE,
	parseCookSession,
	renderSession,
	replaceCookRegion,
	sessionPath,
	setServings,
	setTick,
	type CookNote,
	type SessionInput,
} from "./cook-session";
import { toISODate } from "./date";
import { scaleIngredient } from "./ingredients";
import { ensureFolder, frontmatterValue } from "./notes";
import { parseNumber } from "./products";
import type { TimerState } from "./types";

const INGREDIENT_HEADINGS = [
	"ingredients", "ingredient", "ingrediënten", "ingredienten", "boodschappen",
];
const METHOD_HEADINGS = [
	"method", "instructions", "directions", "preparation", "steps",
	"bereiding", "bereidingswijze", "werkwijze", "stappen",
];

/** Synoniemen voor het portieveld, geprobeerd na de ingestelde veldnaam. */
const SERVINGS_KEYS = [
	"servings", "porties", "personen", "aantal personen",
	"serves", "portions", "yield",
];

/** Een timer die meer dan een dag geleden afliep is geen kookactie meer. */
const TIMER_KEEP_MS = 24 * 60 * 60 * 1000;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export interface RecipeBody {
	ingredients: string[];
	steps: string[];
}

/**
 * Pulls the two lists a cook needs out of a recipe note. Headings are matched
 * loosely so notes written in Dutch or with slightly different wording still
 * work.
 */
export function parseRecipeBody(markdown: string): RecipeBody {
	const body = markdown.replace(FRONTMATTER, "");
	const lines = body.split(/\r?\n/);

	const ingredients: string[] = [];
	const steps: string[] = [];
	let collecting: string[] | null = null;
	/** Het kopniveau waarop de huidige sectie begon. */
	let startLevel = 0;

	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim().toLowerCase().replace(/[:*_]+/g, "");
			if (INGREDIENT_HEADINGS.includes(title)) {
				collecting = ingredients;
				startLevel = level;
			} else if (METHOD_HEADINGS.includes(title)) {
				collecting = steps;
				startLevel = level;
			} else if (collecting && level <= startLevel) {
				// Pas een kop van hetzelfde of een hoger niveau sluit de sectie.
				// "### Voor de saus" onder "## Ingrediënten" is een
				// onderverdeling; die afkappen liet halve recepten stil
				// verdwijnen uit de boodschappenlijst én uit de voorraadaftrek.
				collecting = null;
			}
			continue;
		}

		if (!collecting) continue;
		const item = LIST_ITEM.exec(line);
		if (item && item[1].trim().length > 0) collecting.push(item[1].trim());
	}

	return { ingredients, steps };
}

export interface DurationMatch {
	/** Index in the step text where the duration starts. */
	start: number;
	end: number;
	seconds: number;
	label: string;
}

const DURATION = new RegExp(
	"(?:(\\d+(?:[.,]\\d+)?)|\\b(an?|one|een))\\s*" +
		"(seconds?|secs?|seconden|seconde|minutes?|mins?|minuten|minuut|hours?|hrs?|uur|uren)\\b",
	"gi"
);

function unitSeconds(unit: string): number {
	const key = unit.toLowerCase();
	if (key.startsWith("s")) return 1;
	if (key.startsWith("h") || key.startsWith("u")) return 3600;
	return 60;
}

/** Every "20 minutes" or "a minute" in a step, so each can get its own timer. */
export function findDurations(text: string): DurationMatch[] {
	const found: DurationMatch[] = [];
	DURATION.lastIndex = 0;

	let match = DURATION.exec(text);
	while (match) {
		const amount = match[1] ? Number(match[1].replace(",", ".")) : 1;
		const seconds = Math.round(amount * unitSeconds(match[3]));
		if (seconds > 0) {
			found.push({
				start: match.index,
				end: match.index + match[0].length,
				seconds,
				label: match[0],
			});
		}
		match = DURATION.exec(text);
	}

	return found;
}

export function timerKey(step: number, duration: number): string {
	return `${step}:${duration}`;
}

/** mm:ss, or h:mm:ss once an hour is involved. A negative value shows as -mm:ss. */
export function formatClock(seconds: number): string {
	const negative = seconds < 0;
	const total = Math.abs(Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = total % 60;
	const body =
		hours > 0
			? `${hours}:${`${minutes}`.padStart(2, "0")}:${`${rest}`.padStart(2, "0")}`
			: `${minutes}:${`${rest}`.padStart(2, "0")}`;
	return negative ? `-${body}` : body;
}

/** Seconds left; negative once the timer has run past its end. */
export function remaining(timer: TimerState, now: number): number {
	return timer.seconds - (now - timer.startedAt) / 1000;
}

/**
 * Cooking state lives in a note of its own — one per time you cook, not one
 * per recipe. Timers are the exception: those store the moment they were
 * started rather than a countdown, which is the only way a timer can be
 * correct after the app has been asleep, and a timestamp has no business in a
 * note you read with wet hands.
 */
export class CookStore {
	private plugin: PantryPlugin;

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	private get vault() {
		return this.plugin.app.vault;
	}

	/** True als deze notitie een kooksessie van Pantry is. */
	isSession(content: string): boolean {
		return frontmatterValue(content, COOK_MARK) === COOK_MARK_VALUE;
	}

	/**
	 * De notitie voor deze keer koken: die van vandaag als hij er al is, en
	 * anders een nieuwe.
	 *
	 * Hetzelfde recept twee keer op één dag krijgt " 2" achter de naam. Dat is
	 * zeldzaam genoeg om lelijk te mogen zijn, en de sessie van vanmiddag
	 * overschrijven is erger.
	 */
	async openSession(recipe: TFile, servings: number): Promise<TFile | null> {
		const today = toISODate(new Date());
		const folder = this.plugin.settings.cookFolder;

		const first = sessionPath(folder, today, recipe.basename);
		const existing = this.vault.getFileByPath(first);
		if (existing) return existing;

		const input = await this.build(recipe, servings, today);
		if (!input) return null;

		await ensureFolder(this.vault, first);
		return this.vault.create(first, renderSession(input)).catch(async () => {
			// Bestaat hij toch al (race, of een map die net verscheen), dan is
			// die van nu goed genoeg; anders een nummer erachter.
			const again = this.vault.getFileByPath(first);
			if (again) return again;
			for (let n = 2; n < 20; n += 1) {
				const path = sessionPath(folder, today, `${recipe.basename} ${n}`);
				if (!this.vault.getFileByPath(path)) {
					return this.vault.create(path, renderSession(input));
				}
			}
			return null;
		});
	}

	/** Het recept, de porties en de stappen, klaar om weg te schrijven. */
	async build(
		recipe: TFile,
		servings: number,
		date: string
	): Promise<SessionInput | null> {
		const content = await this.vault.cachedRead(recipe);
		const body = parseRecipeBody(content);
		const base = this.baseServings(recipe);
		const factor = base && base > 0 ? servings / base : 1;

		const scaled = body.ingredients.map(
			(line) => scaleIngredient(line, factor).text
		);
		const grouped = groupIngredientsByStep(body.ingredients, body.steps);

		const groups: SessionInput["groups"] = grouped
			? grouped.map((group) => ({
					label: group.step === null ? "Rest" : `Step ${group.step + 1}`,
					lines: group.indexes.map((index) => scaled[index] ?? ""),
			  }))
			: [{ label: "Ingredients", lines: scaled }];

		return {
			recipe: recipe.basename,
			date,
			servings,
			groups,
			steps: body.steps,
		};
	}

	/** De sessie zoals hij nu in zijn notitie staat. */
	async read(session: TFile): Promise<CookNote> {
		return parseCookSession(await this.vault.cachedRead(session));
	}

	/** Eén vinkje omzetten, op regelnummer. */
	async tick(session: TFile, line: number, done: boolean): Promise<void> {
		await this.vault.process(session, (content) => setTick(content, line, done));
	}

	/**
	 * Ander aantal porties: de ingrediëntenlijst wordt opnieuw gerekend uit het
	 * recept. Handmatige wijzigingen in díe lijst gaan daarbij verloren — dat
	 * is de afspraak, want herrekenen is precies wat je vraagt. Alles onder het
	 * beheerde stuk, je notities, blijft staan.
	 */
	async rescale(session: TFile, servings: number): Promise<void> {
		const before = await this.read(session);
		const recipe = before.recipe ? this.file(before.recipe) : null;
		if (!recipe) return;

		const input = await this.build(recipe, servings, toISODate(new Date()));
		if (!input) return;

		const ticked = {
			ingredient: new Set(
				before.ingredients.filter((line) => line.done).map((line) => line.index)
			),
			step: new Set(before.steps.filter((line) => line.done).map((line) => line.index)),
		};

		// Alles in één `process`: tussen twee schrijfacties door is de
		// gelezen inhoud niet meer per se de inhoud op schijf.
		await this.vault.process(session, (content) => {
			let next = setServings(replaceCookRegion(content, input), servings);
			const parsed = parseCookSession(next);
			for (const line of [...parsed.ingredients, ...parsed.steps]) {
				if (ticked[line.kind].has(line.index)) next = setTick(next, line.line, true);
			}
			return next;
		});
	}

	/** De sessie terugzetten naar het recept zoals het nu is. */
	async restart(session: TFile, servings: number): Promise<void> {
		const note = await this.read(session);
		const recipe = note.recipe ? this.file(note.recipe) : null;
		if (!recipe) return;
		const input = await this.build(recipe, servings, toISODate(new Date()));
		if (!input) return;
		this.clearTimers(session.path);
		await this.plugin.saveSettings();
		await this.vault.process(session, (content) =>
			setServings(replaceCookRegion(content, input), servings)
		);
	}

	timers(path: string): Record<string, TimerState> {
		return this.plugin.settings.cookTimers[path] ?? {};
	}

	async setTimer(path: string, key: string, timer: TimerState | null): Promise<void> {
		const all = { ...this.timers(path) };
		if (timer) all[key] = timer;
		else delete all[key];
		if (Object.keys(all).length === 0) delete this.plugin.settings.cookTimers[path];
		else this.plugin.settings.cookTimers[path] = all;
		await this.plugin.saveSettings();
	}

	clearTimers(path: string): void {
		delete this.plugin.settings.cookTimers[path];
	}

	/**
	 * Verhuist de timers mee als de sessienotitie hernoemd wordt.
	 *
	 * De sleutel is een vaultpad. Zonder dit bleef er een wees achter en zag
	 * de hernoemde sessie zijn eigen lopende timer niet meer staan.
	 */
	async renameSession(oldPath: string, newPath: string): Promise<void> {
		const timers = this.plugin.settings.cookTimers[oldPath];
		if (!timers) return;
		delete this.plugin.settings.cookTimers[oldPath];
		this.plugin.settings.cookTimers[newPath] = timers;
		await this.plugin.saveSettings();
	}

	/**
	 * Gooit timers weg die nergens meer bij horen.
	 *
	 * `cookTimers` staat in `data.json` en werd wel gevuld, nooit geleegd:
	 * een sessie die je zelf weggooide of hernoemde liet zijn timers staan en
	 * het bestand groeide ongemerkt door. Weg is hier: de notitie bestaat niet
	 * meer, of de timer is al meer dan een dag afgelopen — dan is het geen
	 * lopende kookactie meer maar een restje.
	 */
	pruneTimers(): boolean {
		const all = this.plugin.settings.cookTimers;
		const stale = Date.now() - TIMER_KEEP_MS;
		let changed = false;

		for (const path of Object.keys(all)) {
			if (!this.plugin.app.vault.getFileByPath(path)) {
				delete all[path];
				changed = true;
				continue;
			}
			const timers = all[path] ?? {};
			for (const [key, timer] of Object.entries(timers)) {
				if (timer.startedAt + timer.seconds * 1000 > stale) continue;
				delete timers[key];
				changed = true;
			}
			if (Object.keys(timers).length === 0) {
				delete all[path];
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * Ruimt kooksessies op die ouder zijn dan de ingestelde termijn.
	 *
	 * Alleen notities met `pantry: cook` in de frontmatter, en via Obsidians
	 * eigen prullenbak: wat je zelf in die map hebt gezet blijft staan, en wat
	 * de plugin weggooit is terug te halen.
	 */
	async sweep(): Promise<void> {
		const days = this.plugin.settings.cookKeepDays;
		if (!days || days <= 0) {
			if (this.pruneTimers()) await this.plugin.saveSettings();
			return;
		}

		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const folder = this.vault.getFolderByPath(this.plugin.settings.cookFolder);
		if (!folder) return;

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			if (child.stat.mtime > cutoff) continue;
			const content = await this.vault.cachedRead(child);
			if (!this.isSession(content)) continue;
			this.clearTimers(child.path);
			await this.plugin.app.fileManager.trashFile(child);
		}
		this.pruneTimers();
		await this.plugin.saveSettings();
	}

	/** The recipe note behind a link target or a path. */
	file(nameOrPath: string): TFile | null {
		const direct = this.plugin.app.vault.getFileByPath(nameOrPath);
		if (direct) return direct;
		return this.plugin.app.metadataCache.getFirstLinkpathDest(nameOrPath, "");
	}

	/**
	 * Servings the recipe itself is written for, if it says so.
	 *
	 * Sleutels lopen uiteen: `porties`, `Servings`, `personen`. Een gemiste
	 * sleutel valt stil terug op factor 1 en schaalt daarmee de hele
	 * boodschappenlijst verkeerd — een fout zonder foutmelding. Daarom eerst de
	 * ingestelde veldnaam, dan de bekende synoniemen, alles hoofdletterloos.
	 */
	baseServings(file: TFile): number | null {
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

		const byLowerKey = new Map<string, unknown>();
		for (const [key, value] of Object.entries(frontmatter)) {
			byLowerKey.set(key.trim().toLowerCase(), value);
		}

		for (const key of [this.plugin.settings.servingsField, ...SERVINGS_KEYS]) {
			const value = parseNumber(byLowerKey.get(key.trim().toLowerCase()));
			if (value !== null && value > 0) return value;
		}
		return null;
	}

	/** Default when nothing planned says otherwise: one portion per person. */
	householdServings(): number {
		const total = this.plugin.people.all().reduce(
			(sum, member) => sum + (member.portionFactor || 0),
			0
		);
		return total > 0 ? total : 1;
	}
}
