import { ItemView, WorkspaceLeaf } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import type { Product } from "../products";
import { listLabel } from "../shopping-list";
import { emptyState } from "./kit";
import { LISTS_VIEW_TYPE, ROUND_VIEW_TYPE, drawBackLink, openHere } from "./nav";
import { StockPanel } from "./stock-panel";

export { ROUND_VIEW_TYPE };

/**
 * Check stock voor alle open lijsten in één ronde.
 *
 * Tellen doe je thuis, één keer langs de kast. Boodschappen doe je per winkel,
 * vaak op verschillende dagen: woensdag de Lidl, vrijdag de AH. Dat zijn twee
 * lijsten, en elke lijst had haar eigen Check stock — dus stond je twee keer
 * voor dezelfde plank, één keer voor de bonen van de Lidl en één keer voor
 * die van de AH.
 *
 * Dit scherm is dezelfde telrij als overal, over alles wat de open lijsten
 * samen vragen. Het schrijft niets wat een lijst niet ook zou schrijven: een
 * telling staat in de productnotitie, en welke lijst het daarna haalt rekent
 * `ShoppingLists.placement` uit. Het label op de rij zegt welke dat is, zodat
 * je bij het tellen al ziet waar het terechtkomt.
 *
 * "Deze keer overslaan" ontbreekt hier met opzet: dat is een keuze over één
 * winkelbezoek, en die maak je in de lijst zelf.
 */
export class RoundView extends ItemView {
	private plugin: PantryPlugin;
	private panel: StockPanel;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
		const lists = plugin.lists;
		this.panel = new StockPanel({
			plugin,
			memory: plugin.ui.round,
			// De productkaart toont "Needed for" uit het hele plan: over
			// lijsten heen is dat de enige index die alles kent.
			needs: plugin.needs,
			candidates: () => plugin.products.all().filter((product) => lists.inRound(product)),
			need: (product: Product) => lists.roundNeed(product),
			buy: (product: Product) => {
				const placed = lists.placement(product);
				return placed.owner ? lists.amount(placed.owner, product) : placed.amount;
			},
			tag: (product: Product) => {
				const placed = lists.placement(product);
				if (placed.owner) return { text: listLabel(placed.owner), kind: "list" };
				if (!placed.wanted) return null;
				// Niemand haalt het: zeg waarom, want "buy 1" zonder lijst
				// is een boodschap die je nergens tegenkomt.
				if (placed.late) return { text: "no shop in time", kind: "late" };
				return {
					text:
						product.shops.length > 0
							? `only at ${product.shops.join(", ")}`
							: "no shop set",
					kind: "late",
				};
			},
			// Wat je koopt is de volgende stap, en die is per lijst.
			filters: ["all", "check"],
			reload: () => lists.refreshAll(),
		});
	}

	getViewType(): string {
		return ROUND_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Check stock";
	}

	getIcon(): string {
		return "clipboard-check";
	}

	onOpen(): Promise<void> {
		guarded("could not load the stock check", async () => {
			await this.plugin.needs.rebuild(new Date());
			await this.plugin.lists.refreshAll();
			this.draw();
			this.restoreScroll();
		});
		// Obsidian verwacht een promise; hier valt niets te wachten.
		return Promise.resolve();
	}

	/** Zie StockView.restoreScroll: twee frames, om dezelfde reden. */
	private restoreScroll(): void {
		const wanted = this.plugin.ui.round.scroll;
		window.requestAnimationFrame(() => {
			if (wanted > 0) this.contentEl.scrollTop = wanted;
			window.requestAnimationFrame(() => {
				this.registerDomEvent(this.contentEl, "scroll", () => {
					this.plugin.ui.round.scroll = this.contentEl.scrollTop;
				});
			});
		});
	}

	onClose(): Promise<void> {
		this.panel.forget();
		return Promise.resolve();
	}

	refresh(): void {
		// Een lijst erbij of eraf verandert de kop; dan alles opnieuw.
		if (this.drawnFor !== this.signature()) {
			this.draw();
			return;
		}
		this.panel.drawList();
	}

	/** Welke lijsten er open staan, om te zien of de kop nog klopt. */
	private drawnFor = "";

	private signature(): string {
		return this.plugin.lists.all().map((list) => listLabel(list)).join("|");
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-stock", "pantry-round");
		this.drawnFor = this.signature();

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		const back = drawBackLink(inner, this);
		back.querySelector(".pantry-back-label")?.setText("Shopping lists");
		back.setAttr("aria-label", "Back to shopping lists");
		back.onclick = () =>
			guarded("could not open your shopping lists", () => openHere(this, LISTS_VIEW_TYPE));

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Check stock" });
		const count = titles.createDiv({ cls: "pantry-head-sub" });
		const actions = top.createDiv({ cls: "pantry-head-actions" });

		const lists = this.plugin.lists.all();
		const body = root.createDiv({ cls: "pantry-body" });
		if (lists.length === 0) {
			count.setText("no open lists");
			emptyState(
				body,
				"No shopping lists",
				"This counts for every open list at once. Start a list first: pick the day, the shops and the meals."
			);
			return;
		}

		// Voor welke lijsten je telt, zodat de labels op de rijen ergens
		// naar verwijzen.
		inner.createDiv({
			cls: "pantry-round-lists",
			text: `For ${lists.map((list) => listLabel(list)).join("  ·  ")}`,
		});
		this.panel.mount(inner, actions, body, count);
	}
}
