import { TFile } from "obsidian";
import type PantryPlugin from "./main";
import { parseNumber } from "./products";
import type { CookSession, TimerState } from "./types";

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

function emptySession(): CookSession {
	return { ingredients: [], steps: [], timers: {}, updatedAt: 0 };
}

/**
 * Cooking state lives in the plugin's own data, keyed by recipe path, so it
 * survives the app closing. Timers store the moment they were started rather
 * than a countdown, which is the only way a timer can be correct after the
 * app has been asleep.
 */
export class CookStore {
	private plugin: PantryPlugin;

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	session(path: string): CookSession {
		const stored = this.plugin.settings.cook[path];
		if (!stored) return emptySession();
		const session: CookSession = {
			ingredients: stored.ingredients ?? [],
			steps: stored.steps ?? [],
			timers: stored.timers ?? {},
			updatedAt: stored.updatedAt ?? 0,
		};
		// `servings` is optioneel; met exactOptionalPropertyTypes is het zetten
		// van een expliciete `undefined` iets anders dan het weglaten.
		if (stored.servings !== undefined) session.servings = stored.servings;
		return session;
	}

	async write(path: string, session: CookSession): Promise<void> {
		this.plugin.settings.cook[path] = { ...session, updatedAt: Date.now() };
		await this.plugin.saveSettings();
	}

	async clear(path: string): Promise<void> {
		delete this.plugin.settings.cook[path];
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
		const total = this.plugin.settings.household.reduce(
			(sum, member) => sum + (member.portionFactor || 0),
			0
		);
		return total > 0 ? total : 1;
	}
}
