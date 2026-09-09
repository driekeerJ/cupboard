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
	private shop: ShopStep | null = null;
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

	/**
	 * Een verversing van buiten — een telling die net is weggeschreven, een
	 * wijziging op een ander apparaat — tekent alleen de lijst opnieuw, niet
	 * het hele scherm.
	 *
	 * Dit deed eerst `draw()`, en die begint met `root.empty()`: de scroller
	 * verloor zijn hoogte en stond weer bovenaan. Omdat de metadata-cache
	 * een seconde na een tik bijkomt, sprong de lijst dus een seconde ná elke
	 * tik naar boven — precies als je halverwege het tellen was.
	 */
	refresh(): void {
		guarded("could not refresh your shopping list", async () => {
			const list = this.list();
			if (list) await this.plugin.lists.needsOf(list).rebuildFor(list);
			if (this.path && !list) {
				// De notitie is weg: dat hoort het scherm te zeggen.
				this.draw();
				return;
			}
			if (this.step === "setup" || !list) {
				if (this.setup) this.setup.refresh(list);
				else this.draw();
				return;
			}
			if (this.step === "stock" && this.stock) {
				this.stock.drawList();
				return;
			}
			if (this.step === "shop" && this.shop) {
				this.shop.drawList();
				return;
			}
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
		this.shop = null;
		this.draw();
	}

	private draw(): void {
		const root = this.contentEl;
		// Een volledige hertekening mag je plek niet afpakken.
		const scroll = root.scrollTop;
		root.empty();
		root.addClass("pantry-app", "pantry-list");
		this.stock = null;
		this.shop = null;

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
				needs: lists.needsOf(list),
				candidates: () =>
					this.plugin.products.all().filter((product) => lists.relevant(list, product)),
				need: (product) => lists.need(list, product),
				buy: (product) => lists.amount(list, product),
				note: (product) => {
					const owner = lists.ownerOf(list, product);
					if (owner) return `on ${listLabel(owner)}`;
					// Hier niet te koop: dan zegt "buy 1" iets dat niet kan.
					if (!lists.atShops(list, product)) {
						return product.shops.length > 0
							? `at ${product.shops.join(", ")}`
							: "no shop set";
					}
					return null;
				},
				// Wat je koopt is de volgende stap; hier tel je alleen.
				filters: ["all", "check"],
				skipped: (product) => lists.isSkipped(list, product),
				setSkipped: (product, skipped) => lists.setSkipped(list, product, skipped),
				reload: () => lists.refresh(list),
			});
			this.stock.mount(inner, actions, body, sub);
			if (scroll > 0) root.scrollTop = scroll;
			return;
		}

		this.drawDone(actions, list);
		this.shop = new ShopStep(this.plugin, list);
		this.shop.mount(inner, actions, body, sub);
		if (scroll > 0) root.scrollTop = scroll;
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
