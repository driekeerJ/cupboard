import { Notice, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { addDays, atMidnight, toISODate } from "../date";
import { mealLabel } from "../plan";
import { linkTarget } from "../links";
import {
	emptyDraft,
	formatListDate,
	hasMeal,
	hasShop,
	isValidDraft,
	listLabel,
	mealKey,
	sameName,
	type Arrival,
	type ListDraft,
	type MealRef,
	type ShoppingList,
} from "../shopping-list";
import { dedupe } from "../text";
import { emptyState, keepScroll, segment } from "./kit";
import { LISTS_VIEW_TYPE, openHere } from "./nav";
import type { ListView } from "./list-view";

/** Een geplande maaltijd zoals hij in de kieslijst staat. */
interface PlannedChoice {
	ref: MealRef;
	/** De lijst die hem al heeft, als dat een andere is. */
	takenBy: ShoppingList | null;
}

interface PlannedDayChoice {
	date: string;
	meals: { meal: string; choices: PlannedChoice[] }[];
}

/**
 * De eerste stap: waar deze lijst voor is.
 *
 * Drie vragen, in de volgorde waarin je ze jezelf stelt: wanneer ga ik,
 * waarheen, en welke maaltijden neem ik mee. De maaltijden komen uit het
 * weekplan; een maaltijd die al op een andere lijst staat is grijs, want
 * twee lijsten voor dezelfde maaltijd is twee keer dezelfde boodschappen.
 *
 * Een concept tot je op Create of Save drukt: halverwege een keuze hoort de
 * lijst nog niet te veranderen, en weglopen laat de vorige keuzes staan.
 */
export class SetupStep {
	private view: ListView;
	private plugin: PantryPlugin;
	private list: ShoppingList | null;
	private draft: ListDraft;
	private days: PlannedDayChoice[] = [];
	private loaded = false;
	private touched = false;
	private bodyEl: HTMLElement | null = null;

	constructor(view: ListView, plugin: PantryPlugin, list: ShoppingList | null) {
		this.view = view;
		this.plugin = plugin;
		this.list = list;
		this.draft = list ? SetupStep.copyOf(list) : emptyDraft(toISODate(new Date()));
	}

	private static copyOf(list: ShoppingList): ListDraft {
		return {
			date: list.date,
			arrival: list.arrival ? { ...list.arrival } : null,
			shops: [...list.shops],
			meals: list.meals.map((ref) => ({ ...ref })),
		};
	}

	/** Een verversing van buiten laat een aangeraakt concept met rust. */
	refresh(list: ShoppingList | null): void {
		this.list = list;
		if (!this.touched && list) this.draft = SetupStep.copyOf(list);
		guarded("could not read your meal plan", () => this.load());
	}

	draw(body: HTMLElement): void {
		this.bodyEl = body;
		this.drawBody();
		if (!this.loaded) guarded("could not read your meal plan", () => this.load());
	}

	/**
	 * De geplande maaltijden binnen de horizon, vanaf vandaag. Wat al gegeten
	 * of overgeslagen is staat er niet in: daar valt niets meer voor te halen.
	 */
	private async load(): Promise<void> {
		const start = atMidnight(new Date());
		const span = Math.max(1, this.plugin.settings.horizonDays);
		const first = toISODate(start);
		const last = toISODate(addDays(start, span - 1));
		const claimed = this.plugin.lists.claimedMeals();
		const own = this.list?.path ?? null;

		const days: PlannedDayChoice[] = [];
		for (const plan of await this.plugin.plans.covering(start, span)) {
			for (const day of plan.days) {
				if (day.date < first || day.date > last) continue;
				const meals: PlannedDayChoice["meals"] = [];
				for (const meal of day.meals) {
					const choices: PlannedChoice[] = [];
					for (const entry of meal.recipes) {
						if (entry.status) continue;
						const ref: MealRef = {
							date: day.date,
							meal: meal.meal,
							recipe: linkTarget(entry.recipe),
						};
						const owner = claimed.get(mealKey(ref)) ?? null;
						choices.push({ ref, takenBy: owner && owner.path !== own ? owner : null });
					}
					if (choices.length > 0) meals.push({ meal: meal.meal, choices });
				}
				if (meals.length > 0) days.push({ date: day.date, meals });
			}
		}
		this.days = days.sort((a, b) => a.date.localeCompare(b.date));
		this.loaded = true;
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		const restore = keepScroll(body);
		body.empty();

		this.drawWhen(body);
		this.drawShops(body);
		this.drawMeals(body);
		this.drawFoot(body);
		restore();
	}

	// ------------------------------------------------------------- wanneer

	private drawWhen(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "When" });

		const list = section.createDiv({ cls: "pantry-section-body pantry-setup-when" });
		const row = list.createDiv({ cls: "pantry-setup-row" });
		row.createDiv({ cls: "pantry-setup-label", text: "Shopping on" });
		const date = row.createEl("input", {
			cls: "pantry-field-input pantry-date-input",
			attr: { type: "date" },
		});
		date.value = this.draft.date;
		date.addEventListener("change", () => {
			if (date.value.length === 0) return;
			this.touched = true;
			this.draft.date = date.value;
			this.drawBody();
		});

		// Vanaf wanneer het in huis is: de rest van het plan rekent hiermee.
		// Een bezorging na het avondeten is er voor het ontbijt, niet voor dat
		// avondeten — daarom een maaltijd en geen klok.
		const arrive = list.createDiv({ cls: "pantry-setup-row" });
		arrive.createDiv({ cls: "pantry-setup-label", text: "In the house from" });
		const options: { value: string; label: string }[] = [
			{ value: "", label: "Start of day" },
			...this.plugin.settings.meals.map((meal) => ({
				value: `after ${mealLabel(meal)}`,
				label: `After ${mealLabel(meal).toLowerCase()}`,
			})),
		];
		const current = this.draft.arrival
			? `${this.draft.arrival.when} ${this.draft.arrival.meal}`
			: "";
		segment(arrive, options, current, (value) => {
			this.touched = true;
			this.draft.arrival = SetupStep.arrivalFrom(value);
			this.drawBody();
		});
	}

	private static arrivalFrom(value: string): Arrival | null {
		const match = /^(before|after)\s+(.+)$/.exec(value);
		if (!match) return null;
		return { meal: match[2] ?? "", when: match[1] === "after" ? "after" : "before" };
	}

	// ------------------------------------------------------------- winkels

	private shopNames(): string[] {
		return dedupe([
			...this.plugin.shops.names(),
			...this.plugin.products.values("shop"),
		]);
	}

	private drawShops(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "Shops" });
		if (this.draft.shops.length > 0) {
			heading.createSpan({ cls: "pantry-section-count", text: `${this.draft.shops.length}` });
		}

		const shops = this.shopNames();
		const list = section.createDiv({ cls: "pantry-section-body" });
		if (shops.length === 0) {
			emptyState(list, "No shops yet", "Add a shop in Shelves first.");
			return;
		}

		for (const shop of shops) {
			const active = hasShop(this.draft.shops, shop);
			const standard = this.plugin.products
				.all()
				.filter(
					(product) =>
						!product.ignored &&
						product.minimum > 0 &&
						product.shops.some((known) => sameName(known, shop))
				).length;

			const row = list.createEl("button", { cls: "pantry-pick-row" });
			row.toggleClass("is-active", active);
			row.setAttr("aria-pressed", active ? "true" : "false");
			SetupStep.drawTick(row, active);
			const main = row.createDiv({ cls: "pantry-pick-main" });
			main.createDiv({ cls: "pantry-pick-name", text: shop });
			main.createDiv({
				cls: "pantry-pick-meta",
				text:
					standard === 0
						? "no products with a minimum"
						: `${standard} product${standard === 1 ? "" : "s"} with a minimum`,
			});
			row.onclick = () => {
				this.touched = true;
				if (active) {
					this.draft.shops = this.draft.shops.filter((known) => !sameName(known, shop));
				} else {
					this.draft.shops.push(shop);
				}
				this.drawBody();
			};
		}
	}

	// ---------------------------------------------------------- maaltijden

	private drawMeals(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "Meals" });
		if (this.draft.meals.length > 0) {
			heading.createSpan({ cls: "pantry-section-count", text: `${this.draft.meals.length}` });
		}

		const list = section.createDiv({ cls: "pantry-section-body" });
		if (!this.loaded) {
			list.createDiv({ cls: "pantry-pick-intro", text: "Reading your meal plan…" });
			return;
		}
		if (this.days.length === 0) {
			emptyState(
				list,
				"Nothing planned",
				`No meals in the next ${this.plugin.settings.horizonDays} days. Plan some first, or take just the shops.`
			);
			return;
		}

		for (const day of this.days) this.drawDay(list, day);
	}

	private drawDay(parent: HTMLElement, day: PlannedDayChoice): void {
		const free = day.meals.flatMap((meal) => meal.choices).filter((choice) => !choice.takenBy);
		const chosen = free.filter((choice) => hasMeal(this.draft.meals, choice.ref));
		const whole = free.length > 0 && chosen.length === free.length;

		// De hele dag in één tik: dat is de vraag die je jezelf stelt —
		// "haal ik voor morgen?" — en niet "haal ik voor het ontbijt van morgen?".
		const head = parent.createEl("button", { cls: "pantry-pick-row pantry-pick-day" });
		head.toggleClass("is-active", whole);
		head.setAttr("aria-pressed", whole ? "true" : "false");
		head.disabled = free.length === 0;
		SetupStep.drawTick(head, whole);
		const main = head.createDiv({ cls: "pantry-pick-main" });
		main.createDiv({ cls: "pantry-pick-name", text: formatListDate(day.date) });
		main.createDiv({
			cls: "pantry-pick-meta",
			text: free.length === 0 ? "all on other lists" : "whole day",
		});
		head.onclick = () => {
			this.touched = true;
			if (whole) {
				this.draft.meals = this.draft.meals.filter(
					(ref) => !free.some((choice) => mealKey(choice.ref) === mealKey(ref))
				);
			} else {
				for (const choice of free) {
					if (!hasMeal(this.draft.meals, choice.ref)) this.draft.meals.push({ ...choice.ref });
				}
			}
			this.drawBody();
		};

		for (const meal of day.meals) {
			for (const choice of meal.choices) this.drawChoice(parent, meal.meal, choice);
		}
	}

	private drawChoice(parent: HTMLElement, meal: string, choice: PlannedChoice): void {
		const active = !choice.takenBy && hasMeal(this.draft.meals, choice.ref);
		const row = parent.createEl("button", { cls: "pantry-pick-row pantry-pick-meal" });
		row.toggleClass("is-active", active);
		row.toggleClass("is-taken", choice.takenBy !== null);
		row.disabled = choice.takenBy !== null;
		row.setAttr("aria-pressed", active ? "true" : "false");
		SetupStep.drawTick(row, active);
		const main = row.createDiv({ cls: "pantry-pick-main" });
		main.createDiv({ cls: "pantry-pick-name", text: choice.ref.recipe });
		main.createDiv({
			cls: "pantry-pick-meta",
			text: choice.takenBy ? `${meal} · on ${listLabel(choice.takenBy)}` : meal,
		});
		row.onclick = () => {
			if (choice.takenBy) return;
			this.touched = true;
			if (active) {
				const key = mealKey(choice.ref);
				this.draft.meals = this.draft.meals.filter((ref) => mealKey(ref) !== key);
			} else {
				this.draft.meals.push({ ...choice.ref });
			}
			this.drawBody();
		};
	}

	private static drawTick(row: HTMLElement, active: boolean): void {
		const tick = row.createSpan({ cls: "pantry-tick" });
		tick.toggleClass("is-on", active);
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
	}

	// ----------------------------------------------------------------- foot

	/**
	 * De knoppen onderaan, altijd in beeld. Create maakt de lijst en brengt je
	 * naar de voorraadcheck — daar ging je heen. Delete gooit een lijst weg
	 * die je toch niet gaat lopen, mét het boodschappenmoment in het plan.
	 */
	private drawFoot(parent: HTMLElement): void {
		const foot = parent.createDiv({ cls: "pantry-pick-foot" });
		const inner = foot.createDiv({ cls: "pantry-pick-foot-inner" });

		const existing = this.list;
		if (existing) {
			const remove = inner.createEl("button", {
				cls: "pantry-text-button pantry-danger-button",
				text: "Delete list",
			});
			remove.onclick = () =>
				guarded("could not delete the list", async () => {
					await this.plugin.lists.discard(existing);
					this.plugin.ui.forgetList(existing.path);
					this.plugin.refreshViews();
					await openHere(this.view, LISTS_VIEW_TYPE);
				});
		}

		const ready = isValidDraft(this.draft);
		const save = inner.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: existing ? "Save changes" : "Create list",
		});
		save.toggleClass("is-disabled", !ready);
		save.disabled = !ready;
		save.onclick = () =>
			guarded("could not save the list", () => this.save());
	}

	private async save(): Promise<void> {
		if (!isValidDraft(this.draft)) {
			new Notice("Pick at least one shop or one meal.");
			return;
		}
		const existing = this.list;
		if (existing) {
			const was = existing.path;
			await this.plugin.lists.update(existing, this.draft);
			if (existing.path !== was) this.plugin.ui.moveList(was, existing.path);
			this.touched = false;
			this.plugin.refreshViews();
			await this.view.showList(existing, "stock");
			return;
		}
		const created = await this.plugin.lists.create(this.draft);
		if (!created) {
			new Notice("Pick at least one shop or one meal.");
			return;
		}
		this.touched = false;
		this.plugin.refreshViews();
		await this.view.showList(created, "stock");
	}
}
