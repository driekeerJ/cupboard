import { ItemView, Notice, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { formatListDate, listLabel, type ShoppingList } from "../shopping-list";
import { segment } from "./kit";
import { LISTS_VIEW_TYPE, LIST_VIEW_TYPE, drawBackLink, openHere } from "./nav";
import { SetupStep } from "./list-setup";
import { ShopStep } from "./list-shop";
import { StockPanel } from "./stock-panel";
import type { ListStep } from "./view-memory";

export { LIST_VIEW_TYPE };

interface ListViewState {
	/** Vaultpad van de lijstnotitie; null is een lijst die nog gemaakt wordt. */
	path: string | null;
	step: ListStep;
}

const STEPS: { value: ListStep; label: string }[] = [
	{ value: "setup", label: "Set up" },
	{ value: "stock", label: "Check stock" },
	{ value: "shop", label: "Shop" },
];

/**
 * Eén boodschappenlijst, in drie stappen: waar hij voor is, wat er in huis is,
 * en wat je dan haalt. De stappen staan bovenin als een schakelaar, want je
 * gaat heen en weer — halverwege de winkel blijkt de voorraad anders dan je
 * dacht, en dan tel je even opnieuw.
 *
 * Het scherm staat op een pad; het pad staat in de view state, zodat Obsidian
 * het tabblad na een herstart op dezelfde lijst terugzet.
 */
export class ListView extends ItemView {
	private plugin: PantryPlugin;
	private path: string | null = null;
	private step: ListStep = "setup";
	private stock: StockPanel | null = null;
	/** Het concept van de setup-stap; overleeft een hertekening, niet een andere lijst. */
	private setup: SetupStep | null = null;
	private setupFor: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return LIST_VIEW_TYPE;
	}

	getDisplayText(): string {
		const list = this.list();
		return list ? listLabel(list) : "New shopping list";
	}

	getIcon(): string {
		return "shopping-cart";
	}

	getState(): Record<string, unknown> {
		return { path: this.path, step: this.step };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const incoming = state as Partial<ListViewState> | null;
		this.path = typeof incoming?.path === "string" ? incoming.path : null;
		const memory = this.path ? this.plugin.ui.list(this.path) : null;
		const step = incoming?.step;
		this.step =
			step === "setup" || step === "stock" || step === "shop"
				? step
				: (memory?.step ?? "setup");
		if (!this.path) this.step = "setup";
		if (memory) memory.step = this.step;
		if (this.setupFor !== this.path) this.setup = null;
		await super.setState(state, result);
		this.draw();
	}

	onOpen(): Promise<void> {
		this.draw();
		return Promise.resolve();
	}

	refresh(): void {
		guarded("could not refresh your shopping list", async () => {
			const list = this.list();
			if (list) await this.plugin.lists.needsOf(list).rebuildFor(list);
			this.setup?.refresh(list);
			this.draw();
		});
	}

	list(): ShoppingList | null {
		return this.path ? this.plugin.lists.byPath(this.path) : null;
	}

	/** Na het aanmaken: het scherm gaat op de nieuwe lijst staan. */
	async showList(list: ShoppingList, step: ListStep): Promise<void> {
		await this.leaf.setViewState({
			type: LIST_VIEW_TYPE,
			active: true,
			state: { path: list.path, step },
		});
	}

	goTo(step: ListStep): void {
		if (!this.path && step !== "setup") return;
		if (this.path) this.plugin.ui.list(this.path).step = step;
		this.step = step;
		this.stock = null;
		this.draw();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-list");

		const list = this.list();
		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		const back = drawBackLink(inner, this);
		back.querySelector(".pantry-back-label")?.setText("Shopping lists");
		back.setAttr("aria-label", "Back to shopping lists");
		back.onclick = () =>
			guarded("could not open your shopping lists", () => openHere(this, LISTS_VIEW_TYPE));

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", {
			cls: "pantry-head-title",
			text: list ? listLabel(list) : "New shopping list",
		});
		const sub = titles.createDiv({ cls: "pantry-head-sub" });
		const actions = top.createDiv({ cls: "pantry-head-actions" });

		if (this.path && !list) {
			// Het pad staat nog in het tabblad, de notitie is weg: klaar of
			// weggegooid op een ander apparaat.
			sub.setText("This list is gone.");
			root.createDiv({ cls: "pantry-body" });
			return;
		}

		const steps = segment<ListStep>(inner, STEPS, this.step, (step) => this.goTo(step));
		steps.addClass("pantry-steps");
		if (!list) {
			steps.querySelectorAll(".pantry-segment-item").forEach((chip, at) => {
				if (at > 0) chip.addClass("is-disabled");
			});
		}

		const body = root.createDiv({ cls: "pantry-body" });

		if (this.step === "setup" || !list) {
			sub.setText(list ? this.summary(list) : "Pick a day, the shops and the meals.");
			if (!this.setup || this.setupFor !== this.path) {
				this.setup = new SetupStep(this, this.plugin, list);
				this.setupFor = this.path;
			}
			this.setup.draw(body);
			return;
		}

		if (this.step === "stock") {
			const lists = this.plugin.lists;
			this.stock = new StockPanel({
				plugin: this.plugin,
				memory: this.plugin.ui.list(list.path).stock,
				candidates: () =>
					this.plugin.products.all().filter((product) => lists.relevant(list, product)),
				need: (product) => lists.need(list, product),
				buy: (product) => lists.amount(list, product),
				note: (product) => {
					const owner = lists.ownerOf(list, product);
					return owner ? `on ${listLabel(owner)}` : null;
				},
				reload: () => lists.refresh(list),
			});
			this.stock.mount(inner, actions, body, sub);
			return;
		}

		this.drawDone(actions, list);
		new ShopStep(this.plugin, list).mount(inner, actions, body, sub);
	}

	private summary(list: ShoppingList): string {
		const parts = [formatListDate(list.date)];
		if (list.arrival) parts.push(`in the house ${list.arrival.when} ${list.arrival.meal}`);
		const meals = list.meals.length;
		parts.push(meals === 0 ? "no meals" : `${meals} meal${meals === 1 ? "" : "s"}`);
		return parts.join("  ·  ");
	}

	/** Klaar: de lijst gaat weg, het boodschappenmoment blijft in het plan. */
	private drawDone(actions: HTMLElement, list: ShoppingList): void {
		const done = actions.createEl("button", {
			cls: "pantry-text-button pantry-done-button",
		});
		setIcon(done.createSpan({ cls: "pantry-done-icon" }), "check");
		done.createSpan({ text: "Done" });
		done.setAttr("aria-label", "Finish this shopping list");
		done.onclick = () =>
			guarded("could not finish the list", async () => {
				await this.plugin.lists.finish(list);
				this.plugin.ui.forgetList(list.path);
				new Notice(`${listLabel(list)} is done.`);
				this.plugin.refreshViews();
				await openHere(this, LISTS_VIEW_TYPE);
			});
	}
}
