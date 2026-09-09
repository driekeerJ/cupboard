import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	type TextComponent,
} from "obsidian";
import type PantryPlugin from "./main";
import { BUILD_STAMP, PANTRY_FORMAT } from "./format";
import { WEEKDAY_NAMES } from "./date";
import { guarded } from "./guard";
import { DEFAULT_SHOPPING_FOLDER } from "./shopping-lists";
import { parseNumber } from "./number";
import { formatServings } from "./plan";
import type {
	HouseholdMember,
	MealType,
	PantrySettings,
	TimerState,
} from "./types";

export const DEFAULT_SETTINGS: PantrySettings = {
	recipeFolder: "Recipes",
	planFolder: "Meal plans",
	productFolder: "Products",
	shoppingFolder: DEFAULT_SHOPPING_FOLDER,
	shopFolder: "Shops",
	weekStartDay: 1,
	horizonDays: 14,
	meals: [
		{ id: "breakfast", name: "Breakfast" },
		{ id: "lunch", name: "Lunch" },
		{ id: "dinner", name: "Dinner" },
	],
	householdFolder: "",
	household: [{ id: "me", name: "Me", portionFactor: 1 }],
	displayFields: [],
	servingsField: "servings",
	setupComplete: false,
	cookFolder: "Cook sessions",
	cookKeepDays: 30,
	cookTimers: {},
};

/**
 * Leest wat er in `data.json` staat en maakt er iets van waar de rest op kan
 * rekenen.
 *
 * `Object.assign({}, DEFAULT_SETTINGS, await loadData())` is riskanter dan het
 * lijkt: een `household` uit een oudere versie waarin `portionFactor` ontbreekt
 * ging er ongecontroleerd in, en `servingsFor` rekende dan met `undefined || 0`
 * — een stille nul midden in de boodschappenberekening. Geneste velden werden
 * nergens gecontroleerd.
 *
 * Per veld: klopt het type, dan die waarde; anders de default. Nooit half.
 */
export function normaliseSettings(raw: unknown): PantrySettings {
	const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

	const text = (key: keyof PantrySettings): string => {
		const value = stored[key];
		return typeof value === "string" && value.trim().length > 0
			? value
			: (DEFAULT_SETTINGS[key] as string);
	};

	const people = asArray(stored.household)
		.map((entry, index) => {
			const person = asRecord(entry);
			const name = typeof person.name === "string" ? person.name.trim() : "";
			if (name.length === 0) return null;
			const factor = Number(person.portionFactor);
			return {
				id: typeof person.id === "string" && person.id ? person.id : `person-${index}`,
				name,
				// Een ontbrekende of onmogelijke factor is één portie, niet nul:
				// wie meeeet telt mee.
				portionFactor: Number.isFinite(factor) && factor > 0 ? factor : 1,
			} satisfies HouseholdMember;
		})
		.filter((person): person is HouseholdMember => person !== null);

	const meals = asArray(stored.meals)
		.map((entry, index) => {
			const meal = asRecord(entry);
			const name = typeof meal.name === "string" ? meal.name.trim() : "";
			if (name.length === 0) return null;
			return {
				id: typeof meal.id === "string" && meal.id ? meal.id : `meal-${index}`,
				name,
			} satisfies MealType;
		})
		.filter((meal): meal is MealType => meal !== null);

	const weekStartDay = Number(stored.weekStartDay);
	const keepDays = Number(stored.cookKeepDays);
	const horizon = Number(stored.horizonDays);

	return {
		recipeFolder: text("recipeFolder"),
		planFolder: text("planFolder"),
		productFolder: text("productFolder"),
		shoppingFolder: text("shoppingFolder") || DEFAULT_SHOPPING_FOLDER,
		shopFolder: text("shopFolder"),
		servingsField: text("servingsField"),
		cookFolder: text("cookFolder"),
		householdFolder: text("householdFolder"),
		weekStartDay:
			Number.isInteger(weekStartDay) && weekStartDay >= 0 && weekStartDay <= 6
				? weekStartDay
				: DEFAULT_SETTINGS.weekStartDay,
		cookKeepDays:
			Number.isFinite(keepDays) && keepDays >= 0
				? Math.round(keepDays)
				: DEFAULT_SETTINGS.cookKeepDays,
		// Minstens één dag: een horizon van nul betekent dat het weekplan
		// nergens meer om vraagt, en dan is de boodschappenlijst stil leeg.
		horizonDays:
			Number.isFinite(horizon) && horizon >= 1
				? Math.round(horizon)
				: DEFAULT_SETTINGS.horizonDays,
		// Een leeg huishouden of geen enkele maaltijd maakt de plugin
		// onbruikbaar, dus dan liever de default terug.
		meals: meals.length > 0 ? meals : DEFAULT_SETTINGS.meals,
		household: people.length > 0 ? people : DEFAULT_SETTINGS.household,
		displayFields: asArray(stored.displayFields)
			.filter((value): value is string => typeof value === "string")
			.map((value) => value.trim())
			.filter(Boolean),
		setupComplete: stored.setupComplete === true,
		cookTimers: asTimers(stored.cookTimers),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Lopende timers per receptpad; alles wat geen geldige timer is verdwijnt. */
function asTimers(value: unknown): PantrySettings["cookTimers"] {
	const out: PantrySettings["cookTimers"] = {};
	for (const [path, timers] of Object.entries(asRecord(value))) {
		const kept: Record<string, TimerState> = {};
		for (const [key, timer] of Object.entries(asRecord(timers))) {
			const one = asRecord(timer);
			const startedAt = Number(one.startedAt);
			const seconds = Number(one.seconds);
			if (!Number.isFinite(startedAt) || !Number.isFinite(seconds)) continue;
			if (seconds <= 0) continue;
			kept[key] = { startedAt, seconds };
		}
		if (Object.keys(kept).length > 0) out[path] = kept;
	}
	return out;
}

/**
 * Past een tekstinstelling pas toe als je klaar bent met typen.
 *
 * Per toetsaanslag opslaan is hier gevaarlijk. Tijdens het intypen van
 * "Meal plans" is `planFolder` even "M", en komt er in dat venster een
 * `plans.save()` langs, dan staat er ineens een map "M" in de vault met een
 * weeknotitie erin. Bij de naamvelden is het minder erg maar even hinderlijk:
 * elke aanslag hertekende de lijst en trok de cursor uit het veld.
 *
 * Blur of Enter, en alleen als de waarde echt veranderd is.
 */
function onCommit(
	text: TextComponent,
	apply: (value: string) => Promise<void>
): void {
	let applied = text.getValue().trim();

	const commit = (): void => {
		const value = text.getValue().trim();
		if (value === applied) return;
		applied = value;
		guarded("could not save your settings", () => apply(value));
	};

	text.inputEl.addEventListener("blur", commit);
	text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key === "Enter") text.inputEl.blur();
	});
}

/** Slug that stays stable once created, so plans keep pointing at the right person. */
export function makeId(name: string, taken: string[]): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "item";
	let candidate = base;
	let n = 2;
	while (taken.includes(candidate)) {
		candidate = `${base}-${n++}`;
	}
	return candidate;
}

export class PantrySettingTab extends PluginSettingTab {
	plugin: PantryPlugin;
	private mealsListEl: HTMLElement | null = null;
	private householdListEl: HTMLElement | null = null;

	constructor(app: App, plugin: PantryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Welke build dit apparaat draait. Obsidian pakt een nieuwe main.js pas
		// op na een volledige herstart, en Sync brengt hem niet vanzelf naar
		// de telefoon; hier zie je in één oogopslag of dit apparaat bij is.
		new Setting(containerEl)
			.setName("Build")
			.setDesc(`Built ${BUILD_STAMP} · note format ${PANTRY_FORMAT}. Every device should show the same build; restart Obsidian fully after updating.`);

		this.renderFolders(containerEl);
		this.renderWeek(containerEl);
		this.renderMeals(containerEl);
		this.renderHousehold(containerEl);
		this.renderRecipeFields(containerEl);
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	/**
	 * Plan notes refer to meals and people by name, so a rename here has to be
	 * carried through to the weeks that were already planned.
	 */
	private async migrateName(
		kind: "meal" | "eater",
		from: string,
		to: string
	): Promise<void> {
		if (from.trim().length === 0 || to.trim().length === 0) return;
		if (from.trim() === to.trim()) return;

		const notes = await this.plugin.plans.renameEverywhere(kind, from, to);
		if (notes === 0) return;

		new Notice(
			`Pantry renamed "${from.trim()}" to "${to.trim()}" in ${notes} plan note${
				notes === 1 ? "" : "s"
			}.`
		);
		this.plugin.refreshViews();
	}

	/** Captures the value on focus and migrates plan notes once editing ends. */
	private trackRename(
		input: HTMLInputElement,
		kind: "meal" | "eater",
		current: () => string
	): void {
		let before = current();
		input.addEventListener("focus", () => {
			before = current();
		});
		input.addEventListener("blur", () => {
			const after = current();
			guarded("could not rename that everywhere", () =>
				this.migrateName(kind, before, after)
			);
			before = after;
		});
	}

	private renderFolders(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Setup")
			.setDesc("Walk through the folders, week start, meals and household again.")
			.addButton((button) =>
				button.setButtonText("Run setup").onClick(() => {
					this.plugin.runSetup();
				})
			);

		new Setting(containerEl).setName("Folders").setHeading();

		new Setting(containerEl)
			.setName("Recipe folder")
			.setDesc("Every note in this folder is treated as a recipe.")
			.addText((text) => {
				text
					.setPlaceholder("Recipes")
					.setValue(this.plugin.settings.recipeFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.recipeFolder = value.trim();
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Shops folder")
			.setDesc(
				"One note per shop. The bullet list inside it is the order you walk past the shelves."
			)
			.addText((text) => {
				text
					.setPlaceholder("Shops")
					.setValue(this.plugin.settings.shopFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.shopFolder = value.trim();
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Shopping lists folder")
			.setDesc(
				"One note per shopping list: what it is for, what is in the basket, and the list itself. Tick a box in the note or in the view, either works."
			)
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SHOPPING_FOLDER)
					.setValue(this.plugin.settings.shoppingFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.shoppingFolder = value.trim() || DEFAULT_SHOPPING_FOLDER;
					await this.save();
					await this.plugin.lists.refreshAll();
					this.plugin.refreshViews();
				});
			});

		new Setting(containerEl)
			.setName("Meal plan folder")
			.setDesc("Weekly plan notes are created here, one note per week.")
			.addText((text) => {
				text
					.setPlaceholder("Meal plans")
					.setValue(this.plugin.settings.planFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.planFolder = value.trim();
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Cook session folder")
			.setDesc(
				"Every time you cook, Pantry writes a note here: the ingredients scaled for that meal, the steps, and your ticks."
			)
			.addText((text) => {
				text
					.setPlaceholder("Cook sessions")
					.setValue(this.plugin.settings.cookFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.cookFolder = value.trim();
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Keep finished cook sessions and shopping lists for")
			.setDesc(
				"Days. Older cook sessions and finished shopping lists (in the Done folder) go to the trash when Obsidian starts. Notes you wrote yourself in those folders are left alone. 0 keeps everything."
			)
			.addText((text) => {
				text
					.setPlaceholder("30")
					.setValue(`${this.plugin.settings.cookKeepDays}`);
				onCommit(text, async (value) => {
					const days = Number(value.trim());
					this.plugin.settings.cookKeepDays =
					Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0;
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Plan ahead for")
			.setDesc(
				"Days. How far forward the grocery list looks, counting from today. It reads across week notes, so a plan that runs into next week is included."
			)
			.addText((text) => {
				text
					.setPlaceholder("14")
					.setValue(`${this.plugin.settings.horizonDays}`);
				onCommit(text, async (value) => {
					const days = Number(value.trim());
					this.plugin.settings.horizonDays =
						Number.isFinite(days) && days >= 1
							? Math.floor(days)
							: DEFAULT_SETTINGS.horizonDays;
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Product folder")
			.setDesc(
				"Your base list: one note per product, holding the amount you always want in stock."
			)
			.addText((text) => {
				text
					.setPlaceholder("Products")
					.setValue(this.plugin.settings.productFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.productFolder = value.trim();
					await this.save();
					this.plugin.products.build();
					this.plugin.refreshViews();
				});
			});
	}

	private renderWeek(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Week").setHeading();

		new Setting(containerEl)
			.setName("Start of the week")
			.setDesc("The day your planning week begins on.")
			.addDropdown((dropdown) => {
				WEEKDAY_NAMES.forEach((name, index) => {
					dropdown.addOption(`${index}`, name);
				});
				dropdown
					.setValue(`${this.plugin.settings.weekStartDay}`)
					.onChange(async (value) => {
						this.plugin.settings.weekStartDay = Number(value);
						await this.save();
						this.plugin.refreshViews();
					});
			});
	}

	/* ---------------------------------------------------------------- *
	 * Meals
	 * ---------------------------------------------------------------- */

	private renderMeals(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Meals")
			.setDesc("The rows of your planner. Name them however you like.")
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add meal")
					.setCta()
					.onClick(async () => {
						const meals = this.plugin.settings.meals;
						meals.push({
							id: makeId("meal", meals.map((m) => m.id)),
							name: "",
						});
						await this.save();
						this.drawMeals(true);
					})
			);

		this.mealsListEl = containerEl.createDiv({ cls: "pantry-settings-list" });
		this.drawMeals(false);
	}

	/** Redraws only the meal rows, so the settings pane never scrolls away. */
	private drawMeals(focusLast: boolean): void {
		const list = this.mealsListEl;
		if (!list) return;
		list.empty();

		const meals = this.plugin.settings.meals;
		if (meals.length === 0) {
			list.createDiv({
				cls: "pantry-settings-hint",
				text: "No meals yet. Add one to start planning.",
			});
			return;
		}

		let lastInput: HTMLInputElement | null = null;

		meals.forEach((meal: MealType, index: number) => {
			const setting = new Setting(list).setClass("pantry-row");
			setting.addText((text) => {
				lastInput = text.inputEl;
				text.setPlaceholder("Meal name").setValue(meal.name);
				onCommit(text, async (value) => {
					meal.name = value;
					await this.save();
					this.plugin.refreshViews();
				});
				this.trackRename(text.inputEl, "meal", () => meal.name);
			});
			setting.addExtraButton((button) =>
				button
					.setIcon("chevron-up")
					.setTooltip("Move up")
					.setDisabled(index === 0)
					.onClick(async () => {
						if (index === 0) return;
						meals.splice(index - 1, 0, ...meals.splice(index, 1));
						await this.save();
						this.plugin.refreshViews();
						this.drawMeals(false);
					})
			);
			setting.addExtraButton((button) =>
				button
					.setIcon("chevron-down")
					.setTooltip("Move down")
					.setDisabled(index === meals.length - 1)
					.onClick(async () => {
						if (index === meals.length - 1) return;
						meals.splice(index + 1, 0, ...meals.splice(index, 1));
						await this.save();
						this.plugin.refreshViews();
						this.drawMeals(false);
					})
			);
			setting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove")
					.onClick(async () => {
						meals.splice(index, 1);
						await this.save();
						this.plugin.refreshViews();
						this.drawMeals(false);
					})
			);
		});

		if (focusLast && lastInput) (lastInput as HTMLInputElement).focus();
	}

	/* ---------------------------------------------------------------- *
	 * Household
	 * ---------------------------------------------------------------- */

	private renderHousehold(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Household")
			.setDesc(
				"Everyone who eats along. The portion factor lets a child count as part of an adult portion \u2014 0.5 means half a portion."
			)
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add person")
					.setCta()
					.setDisabled(this.plugin.people.usingNotes())
					.onClick(async () => {
						const household = this.plugin.settings.household;
						household.push({
							id: makeId("person", household.map((m) => m.id)),
							name: "",
							portionFactor: 1,
						});
						await this.save();
						this.drawHousehold(true);
					})
			);

		new Setting(containerEl)
			.setName("Household folder")
			.setDesc(
				"One note per person, with portionFactor in the frontmatter. Leave empty to keep the list below \u2014 which lives in the plugin\u2019s own data file and disappears with it."
			)
			.addText((text) => {
				text
					.setPlaceholder("Household")
					.setValue(this.plugin.settings.householdFolder);
				onCommit(text, async (value) => {
					this.plugin.settings.householdFolder = value.trim();
					await this.save();
					this.plugin.people.build();
					this.plugin.refreshViews();
					this.drawHousehold(false);
				});
			});

		this.householdListEl = containerEl.createDiv({ cls: "pantry-settings-list" });
		this.drawHousehold(false);
	}

	/** Redraws only the household rows, so the settings pane never scrolls away. */
	private drawHousehold(focusLast: boolean): void {
		const list = this.householdListEl;
		if (!list) return;
		list.empty();

		// Zodra er notities zijn bepalen die het gezin, en is deze lijst niet
		// meer dan een oude kopie. Hem dan tonen alsof je hem kunt bewerken is
		// erger dan hem niet tonen: je verandert iets en er gebeurt niets.
		if (this.plugin.people.usingNotes()) {
			const names = this.plugin.people
				.all()
				.map((member) =>
					member.portionFactor === 1
						? member.name
						: `${member.name} (\u00d7${formatServings(member.portionFactor)})`
				);
			list.createDiv({
				cls: "pantry-settings-hint",
				text: `Read from your notes in ${this.plugin.people.folder()}: ${names.join(", ")}. Edit a note to change a name or portion factor.`,
			});
			return;
		}

		const household = this.plugin.settings.household;
		if (this.plugin.settings.householdFolder.trim().length > 0) {
			new Setting(list)
				.setName("Move household to notes")
				.setDesc(
					"Writes one note per person into the folder above. Nothing is overwritten, and the list below stays as it is."
				)
				.addButton((button) =>
					button.setButtonText("Move").onClick(() => {
						guarded("could not write your household notes", async () => {
							const written = await this.plugin.people.moveToNotes();
							new Notice(
								written === 0
									? "Pantry found nothing to move."
									: `Pantry wrote ${written} note${written === 1 ? "" : "s"}.`
							);
							this.plugin.refreshViews();
							this.drawHousehold(false);
						});
					})
				);
		}

		if (household.length === 0) {
			list.createDiv({
				cls: "pantry-settings-hint",
				text: "No one added yet. Add at least one person so Pantry can work out servings.",
			});
			return;
		}

		let lastInput: HTMLInputElement | null = null;

		household.forEach((member: HouseholdMember, index: number) => {
			const setting = new Setting(list).setClass("pantry-row");
			setting.addText((text) => {
				lastInput = text.inputEl;
				text.setPlaceholder("Name").setValue(member.name);
				onCommit(text, async (value) => {
					member.name = value;
					await this.save();
					this.plugin.refreshViews();
				});
				this.trackRename(text.inputEl, "eater", () => member.name);
			});
			setting.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.step = "0.05";
				text.inputEl.min = "0";
				text.inputEl.addClass("pantry-factor-input");
				text.inputEl.setAttr("aria-label", "Portion factor");
				text.setPlaceholder("1").setValue(`${member.portionFactor}`);
				onCommit(text, async (value) => {
					const parsed = parseNumber(value);
					// Leegmaken zette de factor op 0 en dan telde die persoon
					// voor niemand mee; één portie is het eerlijke antwoord.
					member.portionFactor = parsed !== null && parsed > 0 ? parsed : 1;
					text.setValue(`${member.portionFactor}`);
					await this.save();
					this.plugin.refreshViews();
				});
			});
			setting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove")
					.onClick(async () => {
						household.splice(index, 1);
						await this.save();
						this.plugin.refreshViews();
						this.drawHousehold(false);
					})
			);
		});

		if (focusLast && lastInput) (lastInput as HTMLInputElement).focus();
	}

	/* ---------------------------------------------------------------- *
	 * Recipe fields
	 * ---------------------------------------------------------------- */

	private renderRecipeFields(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Recipe fields").setHeading();

		new Setting(containerEl)
			.setName("Servings field")
			.setDesc(
				"Frontmatter field holding the number of servings a recipe is written for."
			)
			.addText((text) => {
				text
					.setPlaceholder("servings")
					.setValue(this.plugin.settings.servingsField);
				onCommit(text, async (value) => {
					this.plugin.settings.servingsField = value.trim() || "servings";
					await this.save();
				});
			});

		new Setting(containerEl)
			.setName("Fields shown on recipe cards")
			.setDesc("Comma separated frontmatter fields, for example: duration, type")
			.addText((text) => {
				text
					.setPlaceholder("duration, type")
					.setValue(this.plugin.settings.displayFields.join(", "));
				onCommit(text, async (value) => {
					this.plugin.settings.displayFields = value
					.split(",")
					.map((field) => field.trim())
					.filter((field) => field.length > 0);
					await this.save();
					this.plugin.refreshViews();
				});
			});
	}
}
