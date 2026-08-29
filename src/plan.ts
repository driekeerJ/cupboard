import {
	MarkdownView,
	Notice,
	TFile,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import type PantryPlugin from "./main";
import { addDays, toISODate, weekId } from "./date";
import { markdownIn } from "./folder";
import { ensureFolder } from "./notes";
import type {
	MealStatus,
	MealType,
	PlannedDay,
	PlannedRecipe,
	WeekPlan,
} from "./types";

const BLOCK_LANGUAGE = "meal-plan";
/** Matches a fenced ```meal-plan block, capturing its body. */
const BLOCK_PATTERN = /^```meal-plan[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

/** Turns "[[Chickpea stew|stew]]" into "Chickpea stew". */
export function linkTarget(value: string): string {
	const match = /^\[\[([^\]|#]+)/.exec(value.trim());
	return (match ? match[1] : value).trim();
}

export function toLink(name: string): string {
	return `[[${name}]]`;
}

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
	const word = `${value ?? ""}`.trim().toLowerCase();
	if (word === "eaten" || word === "skipped") return { status: word };
	return {};
}

/** What a tick took off stock, keyed by product path. Junk entries are ignored. */
function parseUsed(value: unknown): { used?: Record<string, number> } {
	const record = asRecord(value);
	const used: Record<string, number> = {};
	for (const [path, raw] of Object.entries(record)) {
		const amount = Number(`${raw}`.replace(",", "."));
		if (Number.isFinite(amount) && amount > 0) used[path] = amount;
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

	static emptyPlan(weekStart: Date): WeekPlan {
		return { weekStart: toISODate(weekStart), days: [] };
	}

	async load(weekStart: Date): Promise<WeekPlan> {
		const file = this.noteFile(weekStart);
		if (!file) return PlanStore.emptyPlan(weekStart);

		// Staat de notitie open in source mode, dan schreef `save()` alleen in
		// de editorbuffer en loopt de schijf achter. `cachedRead` geeft dan de
		// oude versie, en de eerstvolgende `mutate()` schrijft die terug — de
		// maaltijd die je net had gesleept is dan weg. Dezelfde route als bij
		// schrijven dus, en pas daarna de schijf.
		const content =
			this.readFromEditor(file) ?? (await this.plugin.app.vault.cachedRead(file));
		const match = BLOCK_PATTERN.exec(content);
		if (!match) return PlanStore.emptyPlan(weekStart);

		return this.normalise(PlanStore.parse(match[1], weekStart));
	}

	/**
	 * Upgrades plans written by earlier versions, which stored internal ids.
	 * Anything that still resolves to a configured meal or person is rewritten
	 * to its readable name; unknown values are left untouched.
	 */
	normalise(plan: WeekPlan): WeekPlan {
		const { meals, household } = this.plugin.settings;
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

	/** Defensive: the block is hand-editable, so anything may show up in it. */
	static parse(body: string, weekStart: Date): WeekPlan {
		let raw: unknown;
		try {
			raw = parseYaml(body);
		} catch {
			return PlanStore.emptyPlan(weekStart);
		}

		const record = asRecord(raw);
		const days: PlannedDay[] = asArray(record.days).map((rawDay) => {
			const day = asRecord(rawDay);
			const note = `${day.note ?? ""}`.trim();
			return {
				date: `${day.date ?? ""}`,
				...(note.length > 0 ? { note } : {}),
				meals: asArray(day.meals).map((rawMeal) => {
					const meal = asRecord(rawMeal);
					return {
						meal: `${meal.meal ?? ""}`,
						recipes: asArray(meal.recipes).map((rawRecipe) => {
							const entry = asRecord(rawRecipe);
							const eaters = asArray(entry.eaters).map((id) => `${id}`);
							const guests = Number(entry.guests ?? 0);
							return {
								recipe: `${entry.recipe ?? ""}`,
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
			weekStart: `${record.weekStart ?? toISODate(weekStart)}`,
			days: days.filter((day) => day.date.length > 0),
		};
	}

	/** Only the fields that carry meaning, so the block stays readable by hand. */
	private static cleanRecipe(entry: PlannedRecipe): Record<string, unknown> {
		const clean: Record<string, unknown> = {
			recipe: entry.recipe,
			eaters: entry.eaters,
			guests: entry.guests,
		};
		if (entry.status) clean.status = entry.status;
		if (entry.used && Object.keys(entry.used).length > 0) clean.used = entry.used;
		return clean;
	}

	static serialise(plan: WeekPlan): string {
		const clean = {
			weekStart: plan.weekStart,
			days: plan.days
				.map((day) => ({
					date: day.date,
					...(day.note && day.note.trim().length > 0
						? { note: day.note.trim() }
						: {}),
					meals: day.meals
						.map((meal) => ({
							meal: meal.meal,
							recipes: meal.recipes.map((entry) =>
								PlanStore.cleanRecipe(entry)
							),
						}))
						.filter((meal) => meal.recipes.length > 0),
				}))
				// A day with nothing planned but a note still has something to say.
				.filter((day) => day.meals.length > 0 || day.note !== undefined)
				.sort((a, b) => a.date.localeCompare(b.date)),
		};
		return stringifyYaml(clean).trimEnd();
	}

	async save(weekStart: Date, plan: WeekPlan): Promise<void> {
		const { vault } = this.plugin.app;
		const path = this.notePath(weekStart);
		const block = `\`\`\`${BLOCK_LANGUAGE}\n${PlanStore.serialise(plan)}\n\`\`\``;

		const existing = vault.getFileByPath(path);
		if (!existing) {
			await ensureFolder(vault, path);
			const fresh = PlanStore.template(weekStart, block);
			this.lastWritten = fresh;
			await vault.create(path, fresh);
			return;
		}

		// Prefer the editor when the note is open: rewriting the whole file
		// replaces the editor's document, which drops the cursor at the end and
		// scrolls the note to the bottom under the user.
		if (this.writeThroughEditor(existing, block)) return;

		const restoreScroll = this.capturePreviewScroll(existing);
		let refused = false;
		this.lastWritten = await vault.process(existing, (content: string) => {
			if (BLOCK_PATTERN.test(content)) {
				// De functievorm, want `block` bevat vrije tekst: de dagnotitie
				// typ je zelf. Als vervangingspatroon zou `$&` het complete
				// oude blok midden in het nieuwe plakken en `$1` de oude YAML.
				return content.replace(BLOCK_PATTERN, () => block);
			}
			// Een opening zonder sluiting: dan matcht het patroon niet en zou er
			// een tweede blok onderaan komen. De opslag daarna matcht van de
			// oude opening tot de nieuwe sluiting en eet alles ertussen op,
			// inclusief wat de gebruiker daar zelf geschreven heeft.
			if (content.includes(`\`\`\`${BLOCK_LANGUAGE}`)) {
				refused = true;
				return content;
			}
			return `${content.trimEnd()}\n\n${block}\n`;
		});
		restoreScroll();

		if (refused) {
			console.error(`Pantry: unclosed meal-plan block in ${path}`);
			new Notice(
				`Pantry did not save: the meal-plan block in ${existing.basename} has no closing fence. Fix it in the note and try again.`
			);
		}
	}

	/** Every open markdown view currently showing this file. */
	/** De inhoud zoals de open editor hem kent, of null als hij niet openstaat. */
	private readFromEditor(file: TFile): string | null {
		for (const view of this.viewsFor(file)) {
			if (view.getMode() !== "source") continue;
			return view.editor.getValue();
		}
		return null;
	}

	private viewsFor(file: TFile): MarkdownView[] {
		return this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter(
				(view): view is MarkdownView =>
					view instanceof MarkdownView && view.file === file
			);
	}

	/**
	 * Replaces just the block through the editor, so the surrounding text, the
	 * cursor and the scroll position all stay exactly where they were.
	 * Returns false when the note is not open for editing.
	 */
	private writeThroughEditor(file: TFile, block: string): boolean {
		for (const view of this.viewsFor(file)) {
			if (view.getMode() !== "source") continue;

			const editor = view.editor;
			const content = editor.getValue();
			const match = BLOCK_PATTERN.exec(content);
			if (!match) continue;
			if (match[0] === block) return true;

			const scroll = editor.getScrollInfo();
			editor.replaceRange(
				block,
				editor.offsetToPos(match.index),
				editor.offsetToPos(match.index + match[0].length)
			);
			// De editor flusht pas seconden later naar schijf; onthoud nu al wat
			// er straks in het modify-event zal staan.
			this.lastWritten = editor.getValue();

			// Live Preview tears the rendered block down and builds it again, so
			// the position is put back once more after that has settled.
			const restore = (): void => editor.scrollTo(scroll.left, scroll.top);
			restore();
			window.requestAnimationFrame(restore);
			return true;
		}
		return false;
	}

	/**
	 * Reading view re-renders the block after a write and can lose its place, so
	 * the scroll offset is put back once the new content has been laid out.
	 */
	private capturePreviewScroll(file: TFile): () => void {
		const views = this.viewsFor(file).filter(
			(view) => view.getMode() === "preview"
		);
		if (views.length === 0) return () => undefined;

		const offsets = views.map((view) => view.currentMode.getScroll());
		return () => {
			const apply = (): void =>
				views.forEach((view, index) =>
					view.currentMode.applyScroll(offsets[index])
				);
			apply();
			window.setTimeout(apply, 120);
		};
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

		let changedNotes = 0;
		for (const file of this.planFiles()) {
			const content = await this.plugin.app.vault.read(file);
			const match = BLOCK_PATTERN.exec(content);
			if (!match) continue;

			const plan = PlanStore.parse(match[1], new Date());
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

			if (!touched) continue;

			const block = `\`\`\`${BLOCK_LANGUAGE}\n${PlanStore.serialise(plan)}\n\`\`\``;
			this.lastWritten = await this.plugin.app.vault.process(file, (current: string) =>
				// Functievorm: zie `save()`. Een dagnotitie met `$&` erin zou het
				// oude blok midden in het nieuwe plakken.
				current.replace(BLOCK_PATTERN, () => block)
			);
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
