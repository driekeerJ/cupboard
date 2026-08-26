import { ItemView, WorkspaceLeaf } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { PlannerGrid } from "../ui/planner";
import { RecipeList } from "../ui/recipe-list";
import { drawBackLink } from "../ui/nav";

export const PLANNER_VIEW_TYPE = "pantry-planner";

/** Below this width the recipe sidebar is dropped; the + button takes over. */
const NARROW_BREAKPOINT = 640;

export class PlannerView extends ItemView {
	private plugin: PantryPlugin;
	private grid: PlannerGrid | null = null;
	private recipeList: RecipeList | null = null;
	private layoutEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PLANNER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Meal planner";
	}

	getIcon(): string {
		return "utensils-crossed";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("pantry-view");

		// The planner has no header of its own, so the way back gets its own row.
		drawBackLink(container.createDiv({ cls: "pantry-back-row" }), this);

		const layout = container.createDiv({ cls: "pantry-layout" });
		this.layoutEl = layout;

		const sidebar = layout.createDiv({ cls: "pantry-sidebar" });
		this.recipeList = new RecipeList(this.plugin, sidebar, {
			touchDrop: (recipe, date, meal) =>
				guarded(`could not plan ${recipe.name}`, async () => {
					await this.grid?.dropRecipe(recipe.name, date, meal);
				}),
		});
		this.recipeList.render();

		const main = layout.createDiv({ cls: "pantry-main" });
		const grid = new PlannerGrid(this.plugin, main);
		this.grid = grid;
		guarded("could not draw the planner", () => grid.render());

		this.applyWidth();
		this.watchWidth();
	}

	/**
	 * On a phone there is no room for the sidebar next to the week, so it is
	 * hidden and recipes are picked through the + button in each slot instead.
	 */
	private applyWidth(): void {
		const layout = this.layoutEl;
		if (!layout) return;
		const width = layout.clientWidth || this.contentEl.clientWidth;
		layout.toggleClass("is-narrow", width > 0 && width < NARROW_BREAKPOINT);
	}

	private watchWidth(): void {
		if (typeof ResizeObserver === "undefined") return;
		this.resizeObserver = new ResizeObserver(() => this.applyWidth());
		if (this.layoutEl) this.resizeObserver.observe(this.layoutEl);
	}

	refresh(): void {
		guarded("could not draw the planner", async () => {
			await this.grid?.render();
		});
		this.recipeList?.refresh();
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.grid?.destroy();
		this.grid = null;
		this.recipeList = null;
		this.layoutEl = null;
	}
}
