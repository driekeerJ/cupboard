import { setIcon } from "obsidian";
import { guarded } from "../guard";
import { DRAG_MIME } from "./drag";
import { enableTouchDrag } from "./touch-drag";
import type PantryPlugin from "../main";
import {
	countActiveFilters,
	DEFAULT_SORT,
	NAME_FIELD,
	RecipeIndex,
	sortFields,
	sortRecipes,
	toValues,
	type Recipe,
	type RecipeFilter,
	type RecipeSort,
} from "../recipes";

export interface RecipeListOptions {
	/** Picking mode: a card hands the recipe back instead of opening its note. */
	onPick?: (recipe: Recipe) => void;
	/** Put the cursor in the search box as soon as the list appears. */
	autoFocus?: boolean;
	/**
	 * Where a press-and-hold drag from this list should land. Needed because
	 * touch devices get no HTML5 drag and drop; on an iPad the sidebar is wide
	 * enough to be visible, so dragging from it has to work there too.
	 */
	touchDrop?: (recipe: Recipe, date: string, meal: string) => void;
}

/**
 * The recipe sidebar: a search box, a filter popover built from whatever
 * frontmatter fields the recipes happen to have, and the resulting cards.
 * The same component backs the picker behind the + button, so search and
 * filters work identically in both places.
 */
export class RecipeList {
	private plugin: PantryPlugin;
	private root: HTMLElement;
	private options: RecipeListOptions;

	/**
	 * De receptenlijst zoals hij bij deze tekenronde was.
	 *
	 * `recipes.all()` leest de map opnieuw uit de metadata-cache; het filter-,
	 * sorteer- en resultatenpaneel vroegen er ieder apart om — vijf keer per
	 * refresh, en `refresh()` hangt aan elke vaultwijziging. Eén keer lezen per
	 * tekenronde is ook consistenter: de drie panelen kunnen niet meer een
	 * verschillende lijst zien.
	 */
	private all: Recipe[] = [];
	private query = "";
	private filter: RecipeFilter = {};
	private filterOpen = false;
	private sort: RecipeSort = { ...DEFAULT_SORT };
	private sortOpen = false;

	private searchEl: HTMLInputElement | null = null;
	private filterButtonEl: HTMLElement | null = null;
	private filterPanelEl: HTMLElement | null = null;
	private sortButtonEl: HTMLElement | null = null;
	private sortPanelEl: HTMLElement | null = null;
	private chipsEl: HTMLElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	constructor(
		plugin: PantryPlugin,
		root: HTMLElement,
		options: RecipeListOptions = {}
	) {
		this.plugin = plugin;
		this.root = root;
		this.options = options;
	}

	/** Builds the static chrome once; the results are redrawn on every change. */
	render(): void {
		this.reread();
		this.root.empty();
		this.root.addClass("pantry-recipes");

		const header = this.root.createDiv({ cls: "pantry-recipes-header" });
		header.createEl("h3", { cls: "pantry-sidebar-title", text: "Recipes" });
		this.countEl = header.createSpan({ cls: "pantry-recipes-count" });

		const searchRow = this.root.createDiv({ cls: "pantry-search-row" });

		const searchWrap = searchRow.createDiv({ cls: "pantry-search" });
		const searchIcon = searchWrap.createSpan({ cls: "pantry-search-icon" });
		setIcon(searchIcon, "search");
		this.searchEl = searchWrap.createEl("input", {
			cls: "pantry-search-input",
			attr: { type: "text", placeholder: "Search recipes", "aria-label": "Search recipes" },
		});
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl?.value ?? "";
			this.drawResults();
		});

		this.filterButtonEl = searchRow.createEl("button", {
			cls: "pantry-icon-button pantry-filter-button",
			attr: { "aria-label": "Filter recipes" },
		});
		setIcon(this.filterButtonEl, "list-filter");
		this.filterButtonEl.onclick = () => {
			this.filterOpen = !this.filterOpen;
			// Two open panels would push the cards off the screen.
			if (this.filterOpen) this.sortOpen = false;
			this.drawFilterPanel();
			this.drawSortPanel();
		};

		this.sortButtonEl = searchRow.createEl("button", {
			cls: "pantry-icon-button pantry-sort-button",
			attr: { "aria-label": "Sort recipes" },
		});
		setIcon(this.sortButtonEl, "arrow-up-narrow-wide");
		this.sortButtonEl.onclick = () => {
			this.sortOpen = !this.sortOpen;
			if (this.sortOpen) this.filterOpen = false;
			this.drawFilterPanel();
			this.drawSortPanel();
		};

		this.filterPanelEl = this.root.createDiv({ cls: "pantry-filter-panel" });
		this.sortPanelEl = this.root.createDiv({
			cls: "pantry-filter-panel pantry-sort-panel",
		});
		this.chipsEl = this.root.createDiv({ cls: "pantry-chips" });
		this.resultsEl = this.root.createDiv({ cls: "pantry-recipe-cards" });

		this.drawFilterPanel();
		this.drawSortPanel();
		this.drawResults();

		if (this.options.autoFocus) {
			// Deferred: the modal is not focusable until it has been laid out.
			window.setTimeout(() => this.searchEl?.focus(), 0);
		}
	}

	/** Re-reads the vault; called when notes or settings change. */
	/** Herleest de recepten; één keer per tekenronde. */
	private reread(): void {
		this.all = this.plugin.recipes.all();
	}

	refresh(): void {
		this.reread();
		this.pruneFilter();
		this.pruneSort();
		this.drawFilterPanel();
		this.drawSortPanel();
		this.drawResults();
	}

	/** Falls back to the title when the field sorted on has left the vault. */
	private pruneSort(): void {
		if (this.sort.field === NAME_FIELD) return;
		const fields = sortFields(this.all);
		if (!fields.includes(this.sort.field)) this.sort = { ...DEFAULT_SORT };
	}

	/** Drops filter values that no recipe has any more, so chips can't go stale. */
	private pruneFilter(): void {
		const available = RecipeIndex.fieldValues(this.all);
		for (const field of Object.keys(this.filter)) {
			const values = available.get(field);
			if (!values) {
				delete this.filter[field];
				continue;
			}
			const kept = (this.filter[field] ?? []).filter((value) =>
				values.includes(value)
			);
			if (kept.length === 0) delete this.filter[field];
			else this.filter[field] = kept;
		}
	}

	private toggleValue(field: string, value: string): void {
		const current = this.filter[field] ?? [];
		const next = current.includes(value)
			? current.filter((item) => item !== value)
			: [...current, value];
		if (next.length === 0) delete this.filter[field];
		else this.filter[field] = next;

		this.drawFilterPanel();
		this.drawResults();
	}

	private drawFilterPanel(): void {
		const panel = this.filterPanelEl;
		const button = this.filterButtonEl;
		if (!panel || !button) return;

		const active = countActiveFilters(this.filter);
		button.toggleClass("is-active", active > 0);
		button.setAttr(
			"aria-label",
			active > 0 ? `Filter recipes (${active} active)` : "Filter recipes"
		);

		panel.empty();
		panel.toggleClass("is-open", this.filterOpen);
		if (!this.filterOpen) return;

		const fields = RecipeIndex.fieldValues(this.all);
		if (fields.size === 0) {
			panel.createDiv({
				cls: "pantry-settings-hint",
				text: "No frontmatter fields found in your recipes yet.",
			});
			return;
		}

		fields.forEach((values, field) => {
			const group = panel.createDiv({ cls: "pantry-filter-group" });
			group.createDiv({ cls: "pantry-filter-field", text: field });
			const options = group.createDiv({ cls: "pantry-filter-values" });
			values.forEach((value) => {
				const selected = (this.filter[field] ?? []).includes(value);
				const option = options.createEl("button", {
					cls: "pantry-filter-value",
					text: value,
				});
				option.toggleClass("is-selected", selected);
				option.setAttr("aria-pressed", `${selected}`);
				option.onclick = () => this.toggleValue(field, value);
			});
		});

		const footer = panel.createDiv({ cls: "pantry-filter-footer" });
		const clear = footer.createEl("button", {
			cls: "pantry-text-button",
			text: "Clear all",
		});
		clear.onclick = () => {
			this.filter = {};
			this.drawFilterPanel();
			this.drawResults();
		};
	}

	/** Tapping the field already sorted on flips the direction. */
	private pickSort(field: string): void {
		this.sort =
			this.sort.field === field
				? { field, direction: this.sort.direction === "asc" ? "desc" : "asc" }
				: { field, direction: "asc" };
		this.drawSortPanel();
		this.drawResults();
	}

	private drawSortPanel(): void {
		const panel = this.sortPanelEl;
		const button = this.sortButtonEl;
		if (!panel || !button) return;

		const isDefault =
			this.sort.field === DEFAULT_SORT.field &&
			this.sort.direction === DEFAULT_SORT.direction;
		button.toggleClass("is-active", !isDefault);
		button.setAttr(
			"aria-label",
			isDefault
				? "Sort recipes"
				: `Sort recipes (${this.sort.field}, ${
						this.sort.direction === "asc" ? "ascending" : "descending"
				  })`
		);

		panel.empty();
		panel.toggleClass("is-open", this.sortOpen);
		if (!this.sortOpen) return;

		const group = panel.createDiv({ cls: "pantry-filter-group" });
		group.createDiv({ cls: "pantry-filter-field", text: "Sort by" });
		const options = group.createDiv({ cls: "pantry-filter-values" });

		sortFields(this.all).forEach((field) => {
			const selected = this.sort.field === field;
			const option = options.createEl("button", {
				cls: "pantry-filter-value pantry-sort-value",
			});
			option.createSpan({ text: field });
			if (selected) {
				const arrow = option.createSpan({ cls: "pantry-sort-arrow" });
				setIcon(arrow, this.sort.direction === "asc" ? "arrow-up" : "arrow-down");
			}
			option.toggleClass("is-selected", selected);
			option.setAttr("aria-pressed", `${selected}`);
			option.onclick = () => this.pickSort(field);
		});

		const footer = panel.createDiv({ cls: "pantry-filter-footer" });
		const reset = footer.createEl("button", {
			cls: "pantry-text-button",
			text: "Reset",
		});
		reset.onclick = () => {
			this.sort = { ...DEFAULT_SORT };
			this.drawSortPanel();
			this.drawResults();
		};
	}

	private drawChips(): void {
		const chips = this.chipsEl;
		if (!chips) return;
		chips.empty();

		const entries = Object.entries(this.filter).flatMap(([field, values]) =>
			values.map((value) => ({ field, value }))
		);
		chips.toggleClass("is-empty", entries.length === 0);

		entries.forEach(({ field, value }) => {
			const chip = chips.createEl("button", { cls: "pantry-chip" });
			chip.createSpan({ cls: "pantry-chip-field", text: field });
			chip.createSpan({ cls: "pantry-chip-value", text: value });
			const cross = chip.createSpan({ cls: "pantry-chip-remove" });
			setIcon(cross, "x");
			chip.setAttr("aria-label", `Remove filter ${field}: ${value}`);
			chip.onclick = () => this.toggleValue(field, value);
		});
	}

	private drawResults(): void {
		this.drawChips();

		const results = this.resultsEl;
		if (!results) return;
		results.empty();

		const all = this.all;
		const visible = sortRecipes(
			all.filter((recipe) => RecipeIndex.matches(recipe, this.query, this.filter)),
			this.sort
		);

		if (this.countEl) {
			this.countEl.setText(
				visible.length === all.length
					? `${all.length}`
					: `${visible.length} / ${all.length}`
			);
		}

		if (all.length === 0) {
			results.createDiv({
				cls: "pantry-empty-state",
				text: `No recipes found. Check the recipe folder in the Pantry settings — it is set to "${this.plugin.settings.recipeFolder}".`,
			});
			return;
		}

		if (visible.length === 0) {
			results.createDiv({
				cls: "pantry-empty-state",
				text: "No recipes match your search and filters.",
			});
			return;
		}

		visible.forEach((recipe) => this.drawCard(results, recipe));
	}

	private drawCard(parent: HTMLElement, recipe: Recipe): void {
		const card = parent.createDiv({ cls: "pantry-recipe-card" });
		card.dataset.path = recipe.path;
		card.createDiv({ cls: "pantry-recipe-name", text: recipe.name });

		const fields = this.plugin.settings.displayFields;
		if (fields.length > 0) {
			const meta = card.createDiv({ cls: "pantry-recipe-meta" });
			fields.forEach((field) => {
				const values = toValues(recipe.frontmatter[field]);
				if (values.length === 0) return;
				meta.createSpan({
					cls: "pantry-recipe-field",
					text: values.join(", "),
					attr: { "aria-label": field },
				});
			});
		}

		const pick = this.options.onPick;
		if (pick) {
			card.addClass("is-pickable");
			card.onclick = () => pick(recipe);
			return;
		}

		card.setAttr("draggable", "true");
		card.addEventListener("dragstart", (event: DragEvent) => {
			event.dataTransfer?.setData(
				DRAG_MIME,
				JSON.stringify({ kind: "recipe", name: recipe.name })
			);
			// Must include "move", otherwise the grid's dropEffect is rejected.
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", () => card.removeClass("is-dragging"));

		const touchDrop = this.options.touchDrop;
		if (touchDrop) {
			enableTouchDrag(card, {
				payload: () => ({ kind: "recipe", name: recipe.name }),
				label: () => recipe.name,
				drop: (_unused, date, meal) => touchDrop(recipe, date, meal),
			});
		}

		card.onclick = (event: MouseEvent) => {
			const file = this.plugin.app.vault.getFileByPath(recipe.path);
			if (!file) return;
			guarded(`could not open ${recipe.name}`, () =>
				this.plugin.app.workspace
					.getLeaf(event.metaKey || event.ctrlKey ? "tab" : false)
					.openFile(file)
			);
		};
	}
}
