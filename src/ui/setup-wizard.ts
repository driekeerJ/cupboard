import { Modal, Notice, setIcon, TFolder } from "obsidian";
import type PantryPlugin from "../main";
import { WEEKDAY_NAMES } from "../date";
import { makeId } from "../settings";
import type { HouseholdMember, MealType, PantrySettings } from "../types";

interface WizardStep {
	title: string;
	intro: string;
	draw: (body: HTMLElement) => void;
}

/**
 * First-run walkthrough. Everything it asks can also be changed later in the
 * settings; the wizard just means nobody has to find those settings first.
 */
export class SetupWizard extends Modal {
	private plugin: PantryPlugin;
	private draft: PantrySettings;
	private step = 0;

	private bodyEl: HTMLElement | null = null;
	private dotsEl: HTMLElement | null = null;
	private backEl: HTMLButtonElement | null = null;
	private nextEl: HTMLButtonElement | null = null;
	private titleTextEl: HTMLElement | null = null;
	private introEl: HTMLElement | null = null;

	constructor(plugin: PantryPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.draft = structuredClone(plugin.settings);
		if (this.draft.household.length === 0) {
			this.draft.household.push({ id: "me", name: "", portionFactor: 1 });
		}
	}

	private get steps(): WizardStep[] {
		return [
			{
				title: "Where your recipes live",
				intro:
					"Pick the folder that holds your recipe notes. Every note inside it, including subfolders, is treated as a recipe.",
				draw: (body) => this.drawFolders(body),
			},
			{
				title: "When your week starts",
				intro:
					"Planning weeks do not have to start on a Monday. Choose whatever matches how you shop and cook.",
				draw: (body) => this.drawWeek(body),
			},
			{
				title: "The meals you plan",
				intro:
					"These become the rows of your planner. Name them however you like and put them in the order you eat them.",
				draw: (body) => this.drawMeals(body),
			},
			{
				title: "Who eats along",
				intro:
					"Add everyone in your household. The portion factor lets a child count as part of an adult portion — 0.5 means half a portion.",
				draw: (body) => this.drawHousehold(body),
			},
		];
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("pantry-wizard-modal");
		contentEl.empty();
		contentEl.addClass("pantry-wizard");

		const header = contentEl.createDiv({ cls: "pantry-wizard-header" });
		header.createDiv({ cls: "pantry-wizard-eyebrow", text: "Pantry setup" });
		this.titleTextEl = header.createEl("h2", { cls: "pantry-wizard-title" });
		this.introEl = header.createEl("p", { cls: "pantry-wizard-intro" });

		this.bodyEl = contentEl.createDiv({ cls: "pantry-wizard-body" });

		const footer = contentEl.createDiv({ cls: "pantry-wizard-footer" });
		this.dotsEl = footer.createDiv({ cls: "pantry-wizard-dots" });

		const actions = footer.createDiv({ cls: "pantry-wizard-actions" });
		const skip = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Skip",
		});
		skip.onclick = () => void this.finish(false);

		this.backEl = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Back",
		});
		this.backEl.onclick = () => this.go(this.step - 1);

		this.nextEl = actions.createEl("button", { cls: "mod-cta", text: "Next" });
		this.nextEl.onclick = () => {
			if (this.step < this.steps.length - 1) this.go(this.step + 1);
			else void this.finish(true);
		};

		this.go(0);
	}

	private go(step: number): void {
		const steps = this.steps;
		this.step = Math.max(0, Math.min(steps.length - 1, step));
		const current = steps[this.step];

		this.titleTextEl?.setText(current.title);
		this.introEl?.setText(current.intro);

		if (this.bodyEl) {
			this.bodyEl.empty();
			current.draw(this.bodyEl);
		}

		if (this.dotsEl) {
			this.dotsEl.empty();
			steps.forEach((_, index) => {
				const dot = this.dotsEl!.createSpan({ cls: "pantry-wizard-dot" });
				dot.toggleClass("is-current", index === this.step);
				dot.toggleClass("is-done", index < this.step);
			});
		}

		if (this.backEl) this.backEl.toggleClass("is-hidden", this.step === 0);
		if (this.nextEl) {
			this.nextEl.setText(
				this.step === steps.length - 1 ? "Start planning" : "Next"
			);
		}
	}

	private async finish(apply: boolean): Promise<void> {
		if (apply) {
			this.draft.meals = this.draft.meals.filter(
				(meal) => meal.name.trim().length > 0
			);
			this.draft.household = this.draft.household.filter(
				(member) => member.name.trim().length > 0
			);
			this.plugin.settings = { ...this.draft, setupComplete: true };
		} else {
			this.plugin.settings.setupComplete = true;
		}

		await this.plugin.saveSettings();
		this.plugin.refreshViews();
		this.close();

		if (apply) {
			new Notice("Pantry is ready. Drag a recipe onto the week to get started.");
			void this.plugin.activatePlanner();
		}
	}

	/* ---------------------------------------------------------------- *
	 * Steps
	 * ---------------------------------------------------------------- */

	private folderNames(): string[] {
		const folders: string[] = [];
		// Vault.getAllLoadedFiles covers folders as well as notes.
		this.app.vault.getAllLoadedFiles().forEach((file) => {
			if (file instanceof TFolder && file.path !== "/") folders.push(file.path);
		});
		return folders.sort((a, b) => a.localeCompare(b));
	}

	private drawFolders(body: HTMLElement): void {
		const options = this.folderNames();

		this.folderField(
			body,
			"Recipe folder",
			"Recipes",
			options,
			this.draft.recipeFolder,
			(value) => {
				this.draft.recipeFolder = value;
			}
		);

		this.folderField(
			body,
			"Meal plan folder",
			"Meal plans",
			options,
			this.draft.planFolder,
			(value) => {
				this.draft.planFolder = value;
			}
		);

		body.createDiv({
			cls: "pantry-wizard-note",
			text: "Both folders are created for you if they do not exist yet.",
		});
	}

	private folderField(
		body: HTMLElement,
		label: string,
		placeholder: string,
		options: string[],
		value: string,
		onChange: (value: string) => void
	): void {
		const field = body.createDiv({ cls: "pantry-field" });
		const listId = `pantry-folders-${label.replace(/\s+/g, "-").toLowerCase()}`;
		field.createEl("label", {
			cls: "pantry-field-label",
			text: label,
			attr: { for: `${listId}-input` },
		});

		const input = field.createEl("input", {
			cls: "pantry-field-input",
			attr: {
				id: `${listId}-input`,
				type: "text",
				placeholder,
				list: listId,
			},
		});
		input.value = value;
		input.addEventListener("input", () => onChange(input.value.trim()));

		const datalist = field.createEl("datalist", { attr: { id: listId } });
		options.forEach((option) =>
			datalist.createEl("option", { attr: { value: option } })
		);
	}

	private drawWeek(body: HTMLElement): void {
		const grid = body.createDiv({ cls: "pantry-weekday-picker" });
		WEEKDAY_NAMES.forEach((name, index) => {
			const option = grid.createEl("button", {
				cls: "pantry-weekday",
				text: name,
			});
			option.toggleClass("is-selected", this.draft.weekStartDay === index);
			option.onclick = () => {
				this.draft.weekStartDay = index;
				this.go(this.step);
			};
		});
	}

	private drawMeals(body: HTMLElement): void {
		const list = body.createDiv({ cls: "pantry-wizard-list" });
		const meals = this.draft.meals;

		meals.forEach((meal: MealType, index: number) => {
			const row = list.createDiv({ cls: "pantry-wizard-row" });

			const input = row.createEl("input", {
				cls: "pantry-field-input",
				attr: { type: "text", placeholder: "Meal name", "aria-label": "Meal name" },
			});
			input.value = meal.name;
			input.addEventListener("input", () => {
				meal.name = input.value;
			});

			this.iconButton(row, "chevron-up", "Move up", index === 0, () => {
				meals.splice(index - 1, 0, meals.splice(index, 1)[0]);
				this.go(this.step);
			});
			this.iconButton(
				row,
				"chevron-down",
				"Move down",
				index === meals.length - 1,
				() => {
					meals.splice(index + 1, 0, meals.splice(index, 1)[0]);
					this.go(this.step);
				}
			);
			this.iconButton(row, "trash-2", "Remove", false, () => {
				meals.splice(index, 1);
				this.go(this.step);
			});
		});

		this.addButton(body, "Add meal", () => {
			meals.push({ id: makeId("meal", meals.map((item) => item.id)), name: "" });
			this.go(this.step);
		});
	}

	private drawHousehold(body: HTMLElement): void {
		const list = body.createDiv({ cls: "pantry-wizard-list" });
		const household = this.draft.household;

		household.forEach((member: HouseholdMember, index: number) => {
			const row = list.createDiv({ cls: "pantry-wizard-row" });

			const name = row.createEl("input", {
				cls: "pantry-field-input",
				attr: { type: "text", placeholder: "Name", "aria-label": "Name" },
			});
			name.value = member.name;
			name.addEventListener("input", () => {
				member.name = name.value;
			});

			const factor = row.createEl("input", {
				cls: "pantry-field-input pantry-factor-input",
				attr: {
					type: "text",
					inputmode: "decimal",
					placeholder: "1",
					"aria-label": "Portion factor",
				},
			});
			factor.value = `${member.portionFactor}`;
			factor.addEventListener("input", () => {
				const parsed = Number(factor.value.trim().replace(",", "."));
				factor.toggleClass("is-invalid", !Number.isFinite(parsed) || parsed < 0);
				if (Number.isFinite(parsed) && parsed >= 0) member.portionFactor = parsed;
			});

			this.iconButton(row, "trash-2", "Remove", false, () => {
				household.splice(index, 1);
				this.go(this.step);
			});
		});

		this.addButton(body, "Add person", () => {
			household.push({
				id: makeId("person", household.map((item) => item.id)),
				name: "",
				portionFactor: 1,
			});
			this.go(this.step);
		});
	}

	/* ---------------------------------------------------------------- *
	 * Small builders
	 * ---------------------------------------------------------------- */

	private iconButton(
		row: HTMLElement,
		icon: string,
		label: string,
		disabled: boolean,
		onClick: () => void
	): void {
		const button = row.createEl("button", {
			cls: "pantry-icon-button",
			attr: { "aria-label": label },
		});
		setIcon(button, icon);
		button.disabled = disabled;
		button.onclick = onClick;
	}

	private addButton(body: HTMLElement, label: string, onClick: () => void): void {
		const button = body.createEl("button", {
			cls: "pantry-text-button pantry-add-button",
			text: label,
		});
		button.onclick = onClick;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
