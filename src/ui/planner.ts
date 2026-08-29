import { Notice, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import {
	addDays,
	formatDayHeader,
	formatRange,
	isSameDay,
	startOfWeek,
	toISODate,
	weekId,
} from "../date";
import {
	addRecipe,
	formatServings,
	isMeal,
	linkTarget,
	mealLabel,
	noteAt,
	PlanStore,
	recipesAt,
	removeRecipe,
	servingsFor,
	setNote,
	toLink,
} from "../plan";
import type { MealStatus, MealType, PlannedRecipe, WeekPlan } from "../types";
import {
	consumptionOf,
	returnToStock,
	takeFromStock,
	type StockChange,
} from "../consume";
import { AddRecipeModal } from "./add-recipe-modal";
import { DRAG_MIME, readPayload, type DragPayload } from "./drag";
import { EatersPopover } from "./eaters-popover";
import { enableTouchDrag } from "./touch-drag";

/** Hand-picked hues so meal rows stay legible and pleasant in both themes. */
const MEAL_HUES = [152, 8, 38, 205, 268, 330, 186, 96];

/** Shown beside the day-note row and as its placeholder in the day list. */
const DAY_NOTE_LABEL = "Notes";

/** Resolves a meal label coming from a drag payload back to a configured meal. */
function findMeal(meals: MealType[], label: string): MealType | null {
	return meals.find((meal) => isMeal(label, meal)) ?? null;
}

/**
 * Renders the week grid. Owned by both the dedicated view and the `meal-plan`
 * code block, so the two always look and behave the same.
 */
export interface PlannerOptions {
	/** Embedded in a note: no week navigation, tighter chrome. */
	embedded?: boolean;
	/**
	 * Plan to draw immediately, skipping the file read. The code block already
	 * holds the data, and reading it again would leave the block empty for a
	 * frame — which collapses the note and drops the reader at the bottom.
	 */
	initialPlan?: WeekPlan;
}

/** Below this width the week grid becomes a day-under-day list. */
const NARROW_BREAKPOINT = 640;

export class PlannerGrid {
	private plugin: PantryPlugin;
	private root: HTMLElement;
	private options: PlannerOptions;
	private weekStart: Date;
	private plan: WeekPlan;
	private scrollerEl: HTMLElement | null = null;
	private gridEl: HTMLElement | null = null;
	/** Phones and narrow panes get the day list instead of the week grid. */
	private narrow = false;
	private resizeObserver: ResizeObserver | null = null;
	/** Index of the render that is in flight, so stale loads never win. */
	private renderToken = 0;
	/** Consumed by the first render; see PlannerOptions.initialPlan. */
	private pending: WeekPlan | null = null;

	constructor(
		plugin: PantryPlugin,
		root: HTMLElement,
		anchor: Date = new Date(),
		options: PlannerOptions = {}
	) {
		this.plugin = plugin;
		this.root = root;
		this.options = options;
		this.weekStart = startOfWeek(anchor, plugin.settings.weekStartDay);
		this.plan = PlanStore.emptyPlan(this.weekStart);
		this.pending = options.initialPlan ?? null;
	}

	async render(): Promise<void> {
		// Re-derive in case the start-of-week setting changed since last render.
		this.weekStart = startOfWeek(this.weekStart, this.plugin.settings.weekStartDay);

		// Een lopende opslag van een dagnotitie hoort bij het plan dat straks
		// vervangen wordt; laten staan zou hem in de verkeerde week landen.
		this.clearNoteTimer();
		EatersPopover.closeAny();

		const token = ++this.renderToken;
		if (this.pending) {
			// Draw straight away, so the note never briefly loses this block.
			this.plan = this.pending;
			this.pending = null;
		} else {
			const plan = await this.plugin.plans.load(this.weekStart);
			if (token !== this.renderToken) return;
			this.plan = plan;
		}

		this.root.empty();
		this.root.addClass("pantry-planner");
		this.root.toggleClass("is-embedded", this.options.embedded === true);

		this.narrow = this.measureNarrow();
		this.root.toggleClass("is-narrow", this.narrow);
		this.renderToolbar();

		this.scrollerEl = this.root.createDiv({ cls: "pantry-grid-scroll" });
		this.drawBody();
		this.watchWidth();
	}

	/** Stops the width watcher; call when the host view or block goes away. */
	destroy(): void {
		this.clearNoteTimer();
		EatersPopover.closeAny();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.root.detach();
	}

	/** The element holding this planner, for moving it between hosts. */
	element(): HTMLElement {
		return this.root;
	}

	/**
	 * True when the given block source is exactly what this planner would write.
	 * Used to recognise a re-render caused by our own save, so the live DOM can
	 * be reused instead of rebuilt.
	 */
	matches(source: string): boolean {
		return this.plugin.plans.serialise(this.plan).trim() === source.trim();
	}

	/** Moves this planner into a new host, e.g. a freshly rebuilt code block. */
	attachTo(host: HTMLElement): void {
		host.appendChild(this.root);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.narrow = this.measureNarrow();
		this.root.toggleClass("is-narrow", this.narrow);
		this.watchWidth();
	}

	/** Takes the planner out of its host without throwing it away. */
	detach(): void {
		this.clearNoteTimer();
		EatersPopover.closeAny();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.root.detach();
	}

	/**
	 * Measured on the container, never on the root: the root carries
	 * `.pantry-planner`, so its own min-width would decide the answer and the
	 * layout could never shrink out of the wide grid.
	 */
	private measureNarrow(): boolean {
		const width =
			this.root.parentElement?.clientWidth ||
			this.root.clientWidth ||
			window.innerWidth;
		return width > 0 && width < NARROW_BREAKPOINT;
	}

	/**
	 * The layout follows the available width, not the device: a narrow pane on a
	 * desktop gets the same day list a phone does.
	 */
	private watchWidth(): void {
		if (this.resizeObserver) return;
		if (typeof ResizeObserver === "undefined") return;
		this.resizeObserver = new ResizeObserver(() => {
			const narrow = this.measureNarrow();
			if (narrow === this.narrow) return;
			this.narrow = narrow;
			this.root.toggleClass("is-narrow", narrow);
			EatersPopover.closeAny();
			this.drawBody();
		});
		this.resizeObserver.observe(this.root.parentElement ?? this.root);
	}

	/** (Re)builds the grid container itself, which differs per layout. */
	private drawBody(): void {
		// Het veld waar de timer bij hoort wordt hieronder opnieuw opgebouwd.
		this.clearNoteTimer();
		const scroller = this.scrollerEl;
		if (!scroller) return;
		scroller.empty();
		this.gridEl = scroller.createDiv({
			cls: this.narrow ? "pantry-daylist" : "pantry-grid",
		});
		this.drawGrid();
	}

	private async goTo(date: Date): Promise<void> {
		this.weekStart = startOfWeek(date, this.plugin.settings.weekStartDay);
		await this.render();
	}

	/** Saves the plan as it stands, after something edited it in place. */
	private async persist(): Promise<void> {
		await this.mutate(() => undefined);
	}

	/**
	 * Writes the plan without redrawing the grid. Used by the day note: a redraw
	 * would rebuild the field under the cursor and swallow what is being typed.
	 */
	private async saveQuietly(): Promise<void> {
		try {
			await this.plugin.plans.save(this.weekStart, this.plan);
		} catch (error) {
			console.error("Pantry: could not save the meal plan", error);
			new Notice("Pantry could not save your meal plan. See the console for details.");
		}
	}

	/**
	 * De lopende opslagtimer van een dagnotitie.
	 *
	 * Als klasseveld en niet als closure, want die timer overleefde elke
	 * hertekening. Draai je de telefoon terwijl je typt, dan herbouwt
	 * `drawBody()` het rooster inclusief het veld — en 800 ms later schreef de
	 * closure van het losgekoppelde veld de oude tekst alsnog weg. Vuurde hij
	 * ná een `render()` die een andere week had geladen, dan landde de notitie
	 * in het plan van die andere week, onder een datum die daar niet in staat;
	 * `serialise` bewaarde die dag netjes en je zag hem nooit meer terug.
	 *
	 * En het derde: een uitgeschakelde plugin hoort niet meer te schrijven.
	 */
	private noteTimer = 0;

	private clearNoteTimer(): void {
		if (this.noteTimer !== 0) window.clearTimeout(this.noteTimer);
		this.noteTimer = 0;
	}

	/** Applies a change, writes it to the week note and redraws just the grid. */
	private async mutate(change: (plan: WeekPlan) => void): Promise<void> {
		change(this.plan);
		this.drawGrid();
		try {
			await this.plugin.plans.save(this.weekStart, this.plan);
		} catch (error) {
			console.error("Pantry: could not save the meal plan", error);
			new Notice("Pantry could not save your meal plan. See the console for details.");
			// Het rooster is al getekend met de wijziging erin, maar op schijf
			// staat hij niet. Opnieuw laden, zodat het scherm de waarheid toont
			// in plaats van iets wat bij de volgende render toch verdwijnt.
			await this.render();
		}
	}

	private renderToolbar(): void {
		const bar = this.root.createDiv({ cls: "pantry-toolbar" });

		const titles = bar.createDiv({ cls: "pantry-toolbar-titles" });
		titles.createEl("h2", {
			cls: "pantry-title",
			text: `Week ${weekId(this.weekStart).split("-W")[1]}`,
		});
		titles.createSpan({
			cls: "pantry-subtitle",
			text: formatRange(this.weekStart),
		});

		const nav = bar.createDiv({ cls: "pantry-nav" });
		if (this.options.embedded) return;

		const openNote = nav.createEl("button", {
			cls: "pantry-icon-button",
			attr: { "aria-label": "Open this week's note" },
		});
		setIcon(openNote, "file-text");
		openNote.onclick = () =>
			guarded("could not open this week's note", () => this.openWeekNote());

		const previous = nav.createEl("button", {
			cls: "pantry-icon-button",
			attr: { "aria-label": "Previous week" },
		});
		setIcon(previous, "chevron-left");
		previous.onclick = () =>
			guarded("could not load that week", () =>
				this.goTo(addDays(this.weekStart, -7))
			);

		const today = nav.createEl("button", {
			cls: "pantry-text-button",
			text: "Today",
		});
		today.onclick = () =>
			guarded("could not load this week", () => this.goTo(new Date()));

		const next = nav.createEl("button", {
			cls: "pantry-icon-button",
			attr: { "aria-label": "Next week" },
		});
		setIcon(next, "chevron-right");
		next.onclick = () =>
			guarded("could not load that week", () =>
				this.goTo(addDays(this.weekStart, 7))
			);
	}

	private async openWeekNote(): Promise<void> {
		const file = this.plugin.plans.noteFile(this.weekStart);
		if (!file) {
			new Notice("This week has no plan note yet. Drop a recipe to create one.");
			return;
		}
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private drawGrid(): void {
		const grid = this.gridEl;
		if (!grid) return;
		grid.empty();
		// Een CSS-variabele, geen opmaak: de stylesheet bepaalt wat er met het
		// aantal kolommen gebeurt, deze regel zegt alleen hoeveel het er zijn.
		grid.setCssProps({ "--pantry-columns": "7" });

		const { meals } = this.plugin.settings;
		if (meals.length === 0) {
			grid.createDiv({
				cls: "pantry-empty-state",
				text: "No meals configured yet. Add one in the Pantry settings to start planning.",
			});
			return;
		}

		if (this.narrow) {
			this.drawDayList(grid, meals);
			return;
		}

		const today = new Date();

		grid.createDiv({ cls: "pantry-corner" });
		for (let offset = 0; offset < 7; offset++) {
			const date = addDays(this.weekStart, offset);
			const header = grid.createDiv({ cls: "pantry-day-header" });
			if (isSameDay(date, today)) header.addClass("is-today");
			const { weekday, day } = formatDayHeader(date);
			header.createSpan({ cls: "pantry-day-name", text: weekday });
			header.createSpan({ cls: "pantry-day-number", text: day });
		}

		const noteLabel = grid.createDiv({ cls: "pantry-corner pantry-note-corner" });
		noteLabel.setText(DAY_NOTE_LABEL);
		for (let offset = 0; offset < 7; offset++) {
			this.drawDayNote(grid, addDays(this.weekStart, offset), "");
		}

		meals.forEach((meal, mealIndex) => {
			const label = grid.createDiv({ cls: "pantry-meal-label" });
			label.style.setProperty(
				"--pantry-hue",
				`${MEAL_HUES[mealIndex % MEAL_HUES.length]}`
			);
			label.createSpan({ text: meal.name || "Untitled meal" });

			for (let offset = 0; offset < 7; offset++) {
				const date = addDays(this.weekStart, offset);
				this.drawSlot(grid, date, meal, mealIndex, isSameDay(date, today));
			}
		});
	}

	/**
	 * Phone layout: one block per day with the meals stacked underneath, so the
	 * week is read by scrolling down rather than sideways.
	 */
	private drawDayList(root: HTMLElement, meals: MealType[]): void {
		const today = new Date();

		for (let offset = 0; offset < 7; offset++) {
			const date = addDays(this.weekStart, offset);
			const isToday = isSameDay(date, today);

			const day = root.createDiv({ cls: "pantry-day" });
			if (isToday) day.addClass("is-today");

			const heading = day.createDiv({ cls: "pantry-day-heading" });
			const { weekday, day: dayNumber } = formatDayHeader(date);
			heading.createSpan({ cls: "pantry-day-name", text: weekday });
			heading.createSpan({ cls: "pantry-day-number", text: dayNumber });

			this.drawDayNote(day, date, DAY_NOTE_LABEL);

			const rows = day.createDiv({ cls: "pantry-day-meals" });
			meals.forEach((meal, mealIndex) => {
				const row = rows.createDiv({ cls: "pantry-meal-row" });
				row.style.setProperty(
					"--pantry-hue",
					`${MEAL_HUES[mealIndex % MEAL_HUES.length]}`
				);
				const label = row.createDiv({ cls: "pantry-meal-label" });
				label.createSpan({ text: meal.name || "Untitled meal" });
				this.drawSlot(row, date, meal, mealIndex, isToday);
			});
		}
	}

	/**
	 * One free-text line per day for what the calendar says. Saved on blur and,
	 * while typing, after a short pause — never through `mutate`, which would
	 * redraw the grid and take the field away mid-sentence.
	 */
	private drawDayNote(
		host: HTMLElement,
		date: Date,
		placeholder: string
	): void {
		const isoDate = toISODate(date);
		const { weekday } = formatDayHeader(date);
		const wrap = host.createDiv({ cls: "pantry-day-note" });
		const input = wrap.createEl("textarea", {
			cls: "pantry-day-note-input",
			attr: {
				rows: "1",
				placeholder,
				"aria-label": `${DAY_NOTE_LABEL} ${weekday}`,
			},
		});
		input.value = noteAt(this.plan, isoDate);
		if (input.value.length > 0) wrap.addClass("has-note");

		// Meegroeien met wat je typt kan alleen gemeten worden, niet in CSS
		// gezet: de hoogte volgt uit `scrollHeight` van dit ene veld.
		const grow = (): void => {
			input.setCssStyles({ height: "auto" });
			input.setCssStyles({ height: `${Math.max(input.scrollHeight, 28)}px` });
		};
		// Not laid out yet on the first draw, so scrollHeight is still 0.
		window.requestAnimationFrame(grow);

		const store = (): void => {
			this.clearNoteTimer();
			if (noteAt(this.plan, isoDate) === input.value.trim()) return;
			setNote(this.plan, isoDate, input.value);
			// saveQuietly meldt zelf al wat er misgaat; hier alleen de promise
			// netjes afhandelen zonder het veld onder de cursor te herbouwen.
			void this.saveQuietly().catch(() => undefined);
		};

		input.addEventListener("input", () => {
			grow();
			wrap.toggleClass("has-note", input.value.trim().length > 0);
			this.clearNoteTimer();
			this.noteTimer = window.setTimeout(store, 800);
		});
		input.addEventListener("blur", store);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				input.blur();
			}
		});
	}

	private drawSlot(
		grid: HTMLElement,
		date: Date,
		meal: MealType,
		mealIndex: number,
		today: boolean
	): void {
		const isoDate = toISODate(date);
		const label = mealLabel(meal);
		const slot = grid.createDiv({ cls: "pantry-slot" });
		slot.dataset.date = isoDate;
		slot.dataset.meal = label;
		slot.style.setProperty(
			"--pantry-hue",
			`${MEAL_HUES[mealIndex % MEAL_HUES.length]}`
		);
		if (today) slot.addClass("is-today");

		const entries = recipesAt(this.plan, isoDate, meal);
		entries.forEach((entry, index) =>
			this.drawPlannedCard(slot, entry, isoDate, meal, index)
		);

		if (entries.length === 0) {
			slot.createDiv({
				cls: "pantry-slot-placeholder",
				text:
					this.narrow || this.options.embedded
						? "Nothing planned"
						: "Drop a recipe here",
			});
		}

		const add = slot.createEl("button", {
			cls: "pantry-slot-add",
			attr: { "aria-label": `Add a recipe to ${label} on ${isoDate}` },
		});
		setIcon(add, "plus");
		add.onclick = (event: MouseEvent) => {
			event.stopPropagation();
			new AddRecipeModal(this.plugin, (recipe) => {
				guarded(`could not plan ${recipe.name}`, () =>
					this.handleDrop({ kind: "recipe", name: recipe.name }, isoDate, meal)
				);
			}).open();
		};

		slot.addEventListener("dragover", (event: DragEvent) => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			slot.addClass("is-drop-target");
		});
		slot.addEventListener("dragleave", (event: DragEvent) => {
			if (slot.contains(event.relatedTarget as Node)) return;
			slot.removeClass("is-drop-target");
		});
		slot.addEventListener("drop", (event: DragEvent) => {
			event.preventDefault();
			slot.removeClass("is-drop-target");
			const payload = readPayload(event);
			if (payload) {
				guarded("could not plan that", () =>
					this.handleDrop(payload, isoDate, meal)
				);
			}
		});
	}

	private drawPlannedCard(
		slot: HTMLElement,
		entry: PlannedRecipe,
		date: string,
		meal: MealType,
		index: number
	): void {
		const name = linkTarget(entry.recipe);
		const card = slot.createDiv({ cls: "pantry-planned-card" });
		card.setAttr("draggable", "true");

		const top = card.createDiv({ cls: "pantry-planned-top" });
		top.createDiv({ cls: "pantry-planned-name", text: name });

		const remove = top.createEl("button", {
			cls: "pantry-planned-remove",
			attr: { "aria-label": `Remove ${name}` },
		});
		setIcon(remove, "x");
		remove.onclick = (event: MouseEvent) => {
			event.stopPropagation();
			guarded("could not remove that meal", () =>
				this.mutate((plan) => {
					removeRecipe(plan, date, meal, index);
				})
			);
		};

		const servings = servingsFor(this.plugin, entry);
		card.createDiv({
			cls: "pantry-planned-servings",
			text: `${formatServings(servings)} ${servings === 1 ? "serving" : "servings"}`,
		});

		this.drawTicks(card, entry);

		card.addEventListener("dragstart", (event: DragEvent) => {
			event.dataTransfer?.setData(
				DRAG_MIME,
				JSON.stringify({
					kind: "planned",
					date,
					meal: mealLabel(meal),
					index,
				})
			);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", () => card.removeClass("is-dragging"));

		enableTouchDrag(card, {
			payload: () => ({
				kind: "planned",
				date,
				meal: mealLabel(meal),
				index,
			}),
			label: () => name,
			drop: (payload, toDate, toMeal) => {
				const destination = findMeal(this.plugin.settings.meals, toMeal);
				if (destination) {
					guarded("could not move that meal", () =>
						this.handleDrop(payload, toDate, destination)
					);
				}
			},
		});

		const openNote = () => {
			const file = this.plugin.app.metadataCache.getFirstLinkpathDest(name, "");
			if (file) {
				guarded(`could not open ${name}`, () =>
					this.plugin.app.workspace.getLeaf(false).openFile(file)
				);
			}
		};

		card.onclick = (event: MouseEvent) => {
			if (event.metaKey || event.ctrlKey) {
				openNote();
				return;
			}
			EatersPopover.show(
				this.plugin,
				entry,
				card.getBoundingClientRect(),
				() => guarded("could not save your meal plan", () => this.persist()),
				openNote,
				{
					date,
					meal: mealLabel(meal),
					days: this.weekDayOptions(),
					meals: this.plugin.settings.meals.map(mealLabel),
					move: (targetDate: string, targetMeal: string) =>
						guarded("could not move that meal", () =>
							this.moveEntry(date, meal, index, targetDate, targetMeal)
						),
					cook: () =>
						guarded("could not open cook mode", () =>
							this.plugin.openCook(name, servingsFor(this.plugin, entry))
						),
				}
			);
		};
	}

	/**
	 * Eaten or skipped, on the card itself. Tapping the button that is already
	 * on takes the answer back, which is the only undo the screen needs.
	 */
	private drawTicks(card: HTMLElement, entry: PlannedRecipe): void {
		const status = entry.status ?? null;
		card.toggleClass("is-eaten", status === "eaten");
		card.toggleClass("is-skipped", status === "skipped");

		const row = card.createDiv({ cls: "pantry-planned-ticks" });

		const add = (value: MealStatus, icon: string, label: string): void => {
			const button = row.createEl("button", {
				cls: `pantry-tick is-${value}`,
				attr: { "aria-label": label, title: label },
			});
			button.toggleClass("is-on", status === value);
			setIcon(button, icon);
			button.onclick = (event: MouseEvent) => {
				event.stopPropagation();
				guarded("could not book that meal", () =>
					this.setStatus(entry, status === value ? null : value)
				);
			};
		};

		add("eaten", "check", "Eaten — take the ingredients off your stock");
		add("skipped", "ban", "Skipped — leave your stock alone");
	}

	/**
	 * Moves a meal between planned, eaten and skipped, keeping the stock counts
	 * in step. An earlier "eaten" is always given back first, so switching from
	 * eaten to skipped is a clean reversal rather than a second subtraction.
	 *
	 * Wat er ook misgaat, het plan moet vastleggen wat er van de voorraad af
	 * ging. Klapte deze keten halverwege, dan stonden er producten afgeboekt
	 * terwijl het plan nog "niet gegeten" zei — en boekte de volgende tik ze
	 * nog een keer af. Vandaar de `finally`: eerst opschrijven wat er gebeurd
	 * is, dan pas de fout melden.
	 */
	private async setStatus(
		entry: PlannedRecipe,
		next: MealStatus | null
	): Promise<void> {
		const current = entry.status ?? null;
		if (current === next) return;

		// Tussen de tik en `mutate()` zitten een reeks frontmatter-writes, en
		// tot dat moment is `entry.status` nog het oude. Een tweede tik in dat
		// venster — op de telefoon zo gebeurd — liep dus volledig door en
		// boekte alles nog een keer af. `mutate()` overschreef daarna
		// `entry.used` met alleen de laatste boeking, dus uitvinken gaf één
		// maaltijd terug en bleef de voorraad permanent te laag.
		if (this.booking.has(entry)) return;
		this.booking.add(entry);

		// Meteen tekenen, zodat de tik voelbaar landt in plaats van een halve
		// seconde niets te doen. `mutate()` schrijft straks hetzelfde.
		if (next) entry.status = next;
		else delete entry.status;
		this.drawGrid();

		let given: StockChange | null = null;
		let taken: StockChange | null = null;

		try {
			if (current === "eaten" && entry.used) {
				given = await returnToStock(this.plugin, entry.used);
			}

			if (next === "eaten") {
				const amounts = await consumptionOf(this.plugin, entry);
				taken = await takeFromStock(this.plugin, amounts);
			}
		} finally {
			await this.mutate(() => {
				if (next) entry.status = next;
				else delete entry.status;

				if (taken && Object.keys(taken.used).length > 0) entry.used = taken.used;
				else delete entry.used;
			});

			this.booking.delete(entry);
			this.plugin.refreshStockViews();
			guarded("could not refresh your grocery list", () =>
				this.plugin.list.refresh()
			);
		}

		this.reportStockChange(taken, given);
	}

	/** Maaltijden waarvan de boeking nu loopt; zie setStatus. */
	private booking: Set<PlannedRecipe> = new Set();

	/** Vertelt wat er niet geboekt kon worden, en waarom niet. */
	private reportStockChange(
		taken: StockChange | null,
		given: StockChange | null
	): void {
		const list = (names: string[]): string => {
			const shown = names.slice(0, 3).join(", ");
			return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
		};

		const unsure = [...(taken?.unsure ?? []), ...(given?.unsure ?? [])];
		if (unsure.length > 0) {
			new Notice(
				`No count to work from for ${list(unsure)}. Flagged to check instead.`
			);
		}

		const failed = [...(taken?.failed ?? []), ...(given?.failed ?? [])];
		if (failed.length > 0) {
			new Notice(
				`Pantry could not update ${list(failed)}. See the console for details.`
			);
		}
	}

	/** Drops a recipe coming from outside the grid, e.g. the recipe list. */
	async dropRecipe(name: string, date: string, label: string): Promise<void> {
		const meal = findMeal(this.plugin.settings.meals, label);
		if (!meal) return;
		await this.handleDrop({ kind: "recipe", name }, date, meal);
	}

	/** The seven days of the shown week, as options for the move picker. */
	private weekDayOptions(): { value: string; label: string }[] {
		return Array.from({ length: 7 }, (_unused, offset) => {
			const date = addDays(this.weekStart, offset);
			const { weekday, day } = formatDayHeader(date);
			return { value: toISODate(date), label: `${weekday} ${day}` };
		});
	}

	/** Move without dragging, driven by the picker in the eaters panel. */
	private async moveEntry(
		fromDate: string,
		fromMeal: MealType,
		index: number,
		toDate: string,
		toMealLabel: string
	): Promise<void> {
		const target = findMeal(this.plugin.settings.meals, toMealLabel);
		if (!target) return;
		await this.handleDrop(
			{ kind: "planned", date: fromDate, meal: mealLabel(fromMeal), index },
			toDate,
			target
		);
	}

	private async handleDrop(
		payload: DragPayload,
		date: string,
		meal: MealType
	): Promise<void> {
		const label = mealLabel(meal);

		if (payload.kind === "recipe") {
			await this.mutate((plan) => {
				addRecipe(plan, date, meal, {
					recipe: toLink(payload.name),
					eaters: this.plugin.people.all().map(
						(member) => member.name.trim() || member.id
					),
					guests: 0,
				});
			});
			this.flashNewest(date, label);
			return;
		}

		const source = findMeal(this.plugin.settings.meals, payload.meal);
		if (!source) return;
		if (payload.date === date && isMeal(payload.meal, meal)) return;

		await this.mutate((plan) => {
			const moved = removeRecipe(plan, payload.date, source, payload.index);
			if (moved) addRecipe(plan, date, meal, moved);
		});
		this.flashNewest(date, label);
	}

	/** Little pop-in so a dropped recipe is easy to spot. */
	private flashNewest(date: string, mealLabelText: string): void {
		const slot = this.gridEl?.querySelector<HTMLElement>(
			`.pantry-slot[data-date="${date}"][data-meal="${CSS.escape(mealLabelText)}"]`
		);
		const cards = slot?.querySelectorAll(".pantry-planned-card");
		const card = cards?.[cards.length - 1];
		if (card instanceof HTMLElement) {
			card.addClass("is-new");
			window.setTimeout(() => card.removeClass("is-new"), 400);
		}
	}
}
