import { Modal } from "obsidian";
import type PantryPlugin from "../main";
import type { Recipe } from "../recipes";
import { RecipeList } from "./recipe-list";

/**
 * Picker used where there is no sidebar to drag from — on a phone that is
 * everywhere. It hosts the real recipe list, so search, filters and chips
 * behave exactly as they do in the sidebar.
 */
export class AddRecipeModal extends Modal {
	private plugin: PantryPlugin;
	private onPick: (recipe: Recipe) => void;
	private list: RecipeList | null = null;

	constructor(plugin: PantryPlugin, onPick: (recipe: Recipe) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onPick = onPick;
	}

	onOpen(): void {
		this.modalEl.addClass("pantry-pick-modal");
		this.contentEl.empty();

		this.list = new RecipeList(this.plugin, this.contentEl.createDiv(), {
			autoFocus: true,
			onPick: (recipe) => {
				this.close();
				this.onPick(recipe);
			},
		});
		this.list.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.list = null;
	}
}
