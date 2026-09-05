import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { formatServings } from "../plan";
import { RecipeIndex, type Recipe } from "../recipes";
import {
	SERVINGS_STEP,
	cleanServings,
	emptyRound,
	hasShop,
	isActiveRound,
	recipeIn,
	type Round,
} from "../round";
import { emptyState, keepScroll } from "./kit";
import { drawBackLink, openHere } from "./nav";
import { SHOPPING_VIEW_TYPE } from "./shopping-view";

export const ROUND_VIEW_TYPE = "pantry-round";

/**
 * Het scherm waar je zegt waar deze boodschappenronde voor is.
 *
 * Twee lijsten met vinkjes: de winkels — "de standaard boodschappen van de
 * Lidl", oftewel alles wat daar ligt en een minimum heeft — en de recepten,
 * elk met een portie-stepper. Wat je aanvinkt is de hele invoer; het
 * weekplan doet dan even niet mee. Zie src/round.ts.
 *
 * Een concept tot je op Start drukt, net als het losse-boodschap-formulier:
 * halverwege een selectie hoort de lijst nog niet te veranderen, en weglopen
 * zonder te drukken laat de vorige ronde staan.
 */
export class RoundView extends ItemView {
	private plugin: PantryPlugin;
	private draft: Round = emptyRound();
	private query = "";
	private bodyEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;
	private footEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ROUND_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Shopping round";
	}

	getIcon(): string {
		return "list-checks";
	}

	onOpen(): Promise<void> {
		this.draft = this.copyOf(this.plugin.list.round);
		this.draw();
		return Promise.resolve();
	}

	/**
	 * Een verversing van buiten — het rondebestand is op een ander apparaat
	 * veranderd, of een winkelnotitie erbij — tekent de lijsten opnieuw maar
	 * laat je concept met rust. Alleen als je nog niets aangeraakt hebt, volgt
	 * het concept de ronde die er nu staat.
	 */
	refresh(): void {
		if (!this.touched) this.draft = this.copyOf(this.plugin.list.round);
		this.drawBody();
	}

	private touched = false;

	private copyOf(round: Round | null): Round {
		if (!isActiveRound(round)) return emptyRound();
		return {
			recipes: round.recipes.map((entry) => ({ ...entry })),
			shops: [...round.shops],
		};
	}

	/** Iedereen thuis, in porties — het aantal waar een aangevinkt recept mee begint. */
	private householdServings(): number {
		const total = this.plugin.people
			.all()
			.reduce((sum, member) => sum + (member.portionFactor || 0), 0);
		return cleanServings(total > 0 ? total : 1);
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-round");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const top = inner.createDiv({ cls: "pantry-head-row" });
		const titles = top.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Shopping round" });
		this.subEl = titles.createDiv({ cls: "pantry-head-sub" });

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.footEl = root.createDiv({ cls: "pantry-round-foot" });
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		const restore = keepScroll(body);
		body.empty();

		this.subEl?.setText(
			this.plugin.list.hasRound()
				? `Now: ${this.plugin.list.roundLabel()}`
				: "Following the meal plan"
		);

		body.createDiv({
			cls: "pantry-round-intro",
			text:
				"Tick what this round is for. Stock and Groceries then show only that, until you clear the round. Nothing ticked means the list follows your meal plan.",
		});

		this.drawShops(body);
		this.drawRecipes(body);
		this.drawFoot();
		restore();
	}

	// ---------------------------------------------------------------- shops

	private drawShops(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "Standard groceries" });

		const shops = this.plugin.shops.names();
		const list = section.createDiv({ cls: "pantry-section-body" });
		if (shops.length === 0) {
			emptyState(list, "No shops yet", "Add a shop in Shelves first.");
			return;
		}

		for (const shop of shops) {
			const active = hasShop(this.draft, shop);
			const standard = this.plugin.products
				.all()
				.filter(
					(product) =>
						!product.ignored &&
						product.minimum > 0 &&
						product.shops.some(
							(known) => known.trim().toLowerCase() === shop.trim().toLowerCase()
						)
				).length;

			const row = list.createEl("button", { cls: "pantry-round-row" });
			row.toggleClass("is-active", active);
			row.setAttr("aria-pressed", active ? "true" : "false");
			this.drawTick(row, active);
			const main = row.createDiv({ cls: "pantry-round-main" });
			main.createDiv({ cls: "pantry-round-name", text: shop });
			main.createDiv({
				cls: "pantry-round-meta",
				text:
					standard === 0
						? "no products with a minimum"
						: `${standard} product${standard === 1 ? "" : "s"} with a minimum`,
			});
			row.onclick = () => {
				this.touched = true;
				if (active) {
					this.draft.shops = this.draft.shops.filter(
						(known) => known.trim().toLowerCase() !== shop.trim().toLowerCase()
					);
				} else {
					this.draft.shops.push(shop);
				}
				this.drawBody();
			};
		}
	}

	// -------------------------------------------------------------- recipes

	private drawRecipes(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "Recipes" });
		const chosen = this.draft.recipes.length;
		if (chosen > 0) {
			heading.createSpan({ cls: "pantry-section-count", text: `${chosen}` });
		}

		const search = section.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search recipes", enterkeyhint: "search" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.drawBody();
		});

		const all = this.plugin.recipes.all();
		const list = section.createDiv({ cls: "pantry-section-body" });
		if (all.length === 0) {
			emptyState(list, "No recipes yet", "Put a recipe note in your recipe folder.");
			return;
		}

		// Wat je al koos bovenaan, zodat je op een telefoon niet hoeft te
		// scrollen om te zien wat er in de ronde zit — en om het weg te halen.
		const picked = all.filter((recipe) => recipeIn(this.draft, recipe.path));
		const rest = all.filter(
			(recipe) =>
				!recipeIn(this.draft, recipe.path) &&
				RecipeIndex.matches(recipe, this.query, {})
		);

		picked.forEach((recipe) => this.drawRecipe(list, recipe));
		if (picked.length > 0 && rest.length > 0) {
			list.createDiv({ cls: "pantry-round-divider" });
		}
		rest.forEach((recipe) => this.drawRecipe(list, recipe));

		if (picked.length === 0 && rest.length === 0) {
			emptyState(list, "No matches", "Try another word.");
		}
	}

	private drawRecipe(parent: HTMLElement, recipe: Recipe): void {
		const entry = recipeIn(this.draft, recipe.path);
		const active = entry !== null;

		const wrap = parent.createDiv({ cls: "pantry-round-item" });
		wrap.toggleClass("is-active", active);

		const row = wrap.createEl("button", { cls: "pantry-round-row" });
		row.toggleClass("is-active", active);
		row.setAttr("aria-pressed", active ? "true" : "false");
		this.drawTick(row, active);
		const main = row.createDiv({ cls: "pantry-round-main" });
		main.createDiv({ cls: "pantry-round-name", text: recipe.name });
		row.onclick = () => {
			this.touched = true;
			if (entry) {
				this.draft.recipes = this.draft.recipes.filter(
					(known) => known.path !== recipe.path
				);
			} else {
				this.draft.recipes.push({
					path: recipe.path,
					servings: this.householdServings(),
				});
			}
			this.drawBody();
		};

		if (!entry) return;

		// De stepper naast het recept, niet erin: het recept is één knop, en
		// een knop in een knop tikt op een telefoon allebei tegelijk.
		const stepper = wrap.createDiv({ cls: "pantry-round-servings" });
		const minus = stepper.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(minus, "minus");
		minus.setAttr("aria-label", "Fewer portions");
		minus.onclick = () => this.setServings(entry, entry.servings - SERVINGS_STEP);

		stepper.createDiv({
			cls: "pantry-quantity-value",
			text: `${formatServings(entry.servings)} portions`,
		});

		const plus = stepper.createEl("button", { cls: "pantry-stepper-step" });
		setIcon(plus, "plus");
		plus.setAttr("aria-label", "More portions");
		plus.onclick = () => this.setServings(entry, entry.servings + SERVINGS_STEP);
	}

	private setServings(entry: { servings: number }, value: number): void {
		this.touched = true;
		entry.servings = cleanServings(value);
		this.drawBody();
	}

	private drawTick(row: HTMLElement, active: boolean): void {
		const tick = row.createSpan({ cls: "pantry-tick" });
		tick.toggleClass("is-on", active);
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
	}

	// ----------------------------------------------------------------- foot

	/**
	 * De knoppen onderaan, altijd in beeld.
	 *
	 * Start zet de ronde neer en brengt je naar Boodschappen — daar ging je
	 * heen. Clear haalt de ronde weg en laat het weekplan weer gelden; hij
	 * staat er alleen als er iets te wissen valt.
	 */
	private drawFoot(): void {
		const foot = this.footEl;
		if (!foot) return;
		foot.empty();
		const inner = foot.createDiv({ cls: "pantry-round-foot-inner" });

		const current = this.plugin.list.hasRound();
		if (current) {
			const clear = inner.createEl("button", {
				cls: "pantry-text-button",
				text: "Clear round",
			});
			clear.onclick = () =>
				guarded("could not clear the shopping round", async () => {
					await this.plugin.list.clearRound();
					this.draft = emptyRound();
					this.touched = false;
					this.plugin.refreshViews();
					this.drawBody();
				});
		}

		const ready = isActiveRound(this.draft);
		const start = inner.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: current ? "Update round" : "Start round",
		});
		start.toggleClass("is-disabled", !ready);
		start.disabled = !ready;
		start.onclick = () =>
			guarded("could not start the shopping round", async () => {
				await this.plugin.list.setRound(this.draft);
				this.touched = false;
				this.plugin.refreshViews();
				await openHere(this, SHOPPING_VIEW_TYPE);
			});
	}
}
