import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PantryPlugin from "./main";
import { WEEKDAY_NAMES } from "./date";
import { guarded } from "./guard";
import type { HouseholdMember, MealType, PantrySettings } from "./types";

export const DEFAULT_SETTINGS: PantrySettings = {
	recipeFolder: "Recipes",
	planFolder: "Meal plans",
	productFolder: "Products",
	listNote: "Groceries.md",
	shopFolder: "Shops",
	weekStartDay: 1,
	meals: [
		{ id: "breakfast", name: "Breakfast" },
		{ id: "lunch", name: "Lunch" },
		{ id: "dinner", name: "Dinner" },
	],
	household: [{ id: "me", name: "Me", portionFactor: 1 }],
	displayFields: [],
	servingsField: "servings",
	setupComplete: false,
	cook: {},
};

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
			.addText((text) =>
				text
					.setPlaceholder("Recipes")
					.setValue(this.plugin.settings.recipeFolder)
					.onChange(async (value) => {
						this.plugin.settings.recipeFolder = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Shops folder")
			.setDesc(
				"One note per shop. The bullet list inside it is the order you walk past the shelves."
			)
			.addText((text) =>
				text
					.setPlaceholder("Shops")
					.setValue(this.plugin.settings.shopFolder)
					.onChange(async (value) => {
						this.plugin.settings.shopFolder = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Grocery list note")
			.setDesc(
				"Pantry keeps this note in step with your stock. It is a mirror: tick a box here or in the view, either works."
			)
			.addText((text) =>
				text
					.setPlaceholder("Groceries.md")
					.setValue(this.plugin.settings.listNote)
					.onChange(async (value) => {
						this.plugin.settings.listNote = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Meal plan folder")
			.setDesc("Weekly plan notes are created here, one note per week.")
			.addText((text) =>
				text
					.setPlaceholder("Meal plans")
					.setValue(this.plugin.settings.planFolder)
					.onChange(async (value) => {
						this.plugin.settings.planFolder = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Product folder")
			.setDesc(
				"Your base list: one note per product, holding the amount you always want in stock."
			)
			.addText((text) =>
				text
					.setPlaceholder("Products")
					.setValue(this.plugin.settings.productFolder)
					.onChange(async (value) => {
						this.plugin.settings.productFolder = value.trim();
						await this.save();
						this.plugin.products.build();
						this.plugin.refreshViews();
					})
			);
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
				text
					.setPlaceholder("Meal name")
					.setValue(meal.name)
					.onChange(async (value) => {
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
						meals.splice(index - 1, 0, meals.splice(index, 1)[0]);
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
						meals.splice(index + 1, 0, meals.splice(index, 1)[0]);
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

		this.householdListEl = containerEl.createDiv({ cls: "pantry-settings-list" });
		this.drawHousehold(false);
	}

	/** Redraws only the household rows, so the settings pane never scrolls away. */
	private drawHousehold(focusLast: boolean): void {
		const list = this.householdListEl;
		if (!list) return;
		list.empty();

		const household = this.plugin.settings.household;
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
				text
					.setPlaceholder("Name")
					.setValue(member.name)
					.onChange(async (value) => {
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
				text
					.setPlaceholder("1")
					.setValue(`${member.portionFactor}`)
					.onChange(async (value) => {
						const parsed = Number(value);
						member.portionFactor = Number.isFinite(parsed) ? parsed : 1;
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
			.addText((text) =>
				text
					.setPlaceholder("servings")
					.setValue(this.plugin.settings.servingsField)
					.onChange(async (value) => {
						this.plugin.settings.servingsField = value.trim() || "servings";
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Fields shown on recipe cards")
			.setDesc("Comma separated frontmatter fields, for example: duration, type")
			.addText((text) =>
				text
					.setPlaceholder("duration, type")
					.setValue(this.plugin.settings.displayFields.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.displayFields = value
							.split(",")
							.map((field) => field.trim())
							.filter((field) => field.length > 0);
						await this.save();
						this.plugin.refreshViews();
					})
			);
	}
}
