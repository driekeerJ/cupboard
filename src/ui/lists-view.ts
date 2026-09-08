import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { formatListDate, isOverdue, listLabel, type ShoppingList } from "../shopping-list";
import { emptyState } from "./kit";
import { LISTS_VIEW_TYPE, LIST_VIEW_TYPE, drawBackLink, openHere } from "./nav";

export { LISTS_VIEW_TYPE };

/**
 * Alle boodschappenlijsten die nog lopen, de eerste boodschappen bovenaan.
 *
 * Eén rij per lijst met wat er nog te doen is, en één knop voor een nieuwe.
 * Een lijst met een datum die al voorbij is, vraagt om een antwoord — gedaan
 * en vergeten af te sluiten, of toch niet gegaan — en staat daarom rood.
 */
export class ListsView extends ItemView {
	private plugin: PantryPlugin;
	private bodyEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return LISTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Shopping lists";
	}

	getIcon(): string {
		return "shopping-cart";
	}

	onOpen(): Promise<void> {
		this.draw();
		return Promise.resolve();
	}

	refresh(): void {
		this.drawBody();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-lists");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Shopping lists" });
		this.subEl = titles.createDiv({ cls: "pantry-head-sub" });

		const actions = top.createDiv({ cls: "pantry-head-actions" });
		const add = actions.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: "New list",
		});
		add.setAttr("aria-label", "Start a new shopping list");
		add.onclick = () =>
			guarded("could not start a shopping list", () =>
				openHere(this, LIST_VIEW_TYPE, { path: null, step: "setup" })
			);

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const lists = this.plugin.lists.all();
		const late = lists.filter((list) => isOverdue(list)).length;
		const parts = [lists.length === 0 ? "none open" : `${lists.length} open`];
		if (late > 0) parts.push(`${late} past ${late === 1 ? "its" : "their"} date`);
		this.subEl?.setText(parts.join("  ·  "));

		if (lists.length === 0) {
			emptyState(
				body,
				"No shopping lists",
				"Start one for the next time you go: pick the day, the shops and the meals."
			);
			return;
		}

		const section = body.createDiv({ cls: "pantry-section" });
		const rows = section.createDiv({ cls: "pantry-section-body" });
		lists.forEach((list) => this.drawRow(rows, list));
	}

	private drawRow(parent: HTMLElement, list: ShoppingList): void {
		const overdue = isOverdue(list);
		const wrap = parent.createDiv({ cls: "pantry-list-item" });
		wrap.toggleClass("is-overdue", overdue);

		const row = wrap.createEl("button", { cls: "pantry-list-row" });
		const icon = row.createSpan({ cls: "pantry-list-icon" });
		setIcon(icon, overdue ? "alert-triangle" : "shopping-cart");

		const main = row.createDiv({ cls: "pantry-list-main" });
		main.createDiv({ cls: "pantry-list-name", text: listLabel(list) });
		main.createDiv({ cls: "pantry-list-meta", text: this.meta(list, overdue) });

		const chevron = row.createSpan({ cls: "pantry-list-chevron" });
		setIcon(chevron, "chevron-right");

		row.onclick = () =>
			guarded("could not open the list", () =>
				openHere(this, LIST_VIEW_TYPE, {
					path: list.path,
					step: this.plugin.ui.list(list.path).step,
				})
			);

		// De notitie zelf, voor wie liever in markdown afvinkt.
		const file = this.plugin.app.vault.getFileByPath(list.path);
		if (!file) return;
		const open = wrap.createEl("button", {
			cls: "pantry-icon-button pantry-list-note",
			attr: { "aria-label": `Open ${file.basename}` },
		});
		setIcon(open, "file-text");
		open.onclick = (event: MouseEvent) => {
			event.stopPropagation();
			guarded(`could not open ${file.basename}`, () =>
				this.plugin.app.workspace.getLeaf(false).openFile(file)
			);
		};
	}

	private meta(list: ShoppingList, overdue: boolean): string {
		const { buy, unsure } = this.plugin.lists.buckets(list);
		const open = buy.length + unsure.length + list.extras.length;
		const done = list.basket.size;
		const parts: string[] = [];
		if (overdue) parts.push(`past its date (${formatListDate(list.date)})`);
		parts.push(open === 0 ? "nothing left to buy" : `${open} to buy`);
		if (done > 0) parts.push(`${done} in the basket`);
		const meals = list.meals.length;
		if (meals > 0) parts.push(`${meals} meal${meals === 1 ? "" : "s"}`);
		return parts.join("  ·  ");
	}
}
