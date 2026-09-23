import { setIcon } from "obsidian";
import type PantryPlugin from "../main";
import { parseNumber } from "../number";
import { formatServings, isEater, linkTarget, servingsFor } from "../plan";
import type { PlannedRecipe } from "../types";

/** Everything the panel needs to offer "send this to another slot". */
export interface MoveTarget {
	/** ISO date of the day the entry sits on right now. */
	date: string;
	/** Label of the meal it sits in right now. */
	meal: string;
	/** Selectable days, in week order. */
	days: { value: string; label: string }[];
	/** Selectable meal labels, in configured order. */
	meals: string[];
	move: (date: string, meal: string) => void;
	/** Opens the cook view for this planned recipe, scaled to its servings. */
	cook: () => void;
}

const EDGE_MARGIN = 8;
/** Below this width the panel becomes a full-width sheet at the bottom. */
const SHEET_BREAKPOINT = 640;

/**
 * Small floating panel for one planned recipe: who eats it, how many guests,
 * and the resulting number of servings.
 */
export class EatersPopover {
	private static open: EatersPopover | null = null;

	private plugin: PantryPlugin;
	private entry: PlannedRecipe;
	private onChange: () => void;
	private onOpenNote: () => void;
	private target: MoveTarget | null;

	private el: HTMLElement;
	private bodyEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private sheet = false;
	private backdrop: HTMLElement | null = null;
	private outsideClick: (event: PointerEvent) => void;
	private onKeyDown: (event: KeyboardEvent) => void;

	private constructor(
		plugin: PantryPlugin,
		entry: PlannedRecipe,
		anchor: DOMRect,
		onChange: () => void,
		onOpenNote: () => void,
		target: MoveTarget | null = null
	) {
		this.plugin = plugin;
		this.entry = entry;
		this.onChange = onChange;
		this.onOpenNote = onOpenNote;
		this.target = target;

		// A floating panel anchored to a card is unusable on a phone, so narrow
		// screens get a sheet that slides up from the bottom instead.
		this.sheet = window.innerWidth < SHEET_BREAKPOINT;
		if (this.sheet) {
			this.backdrop = document.body.createDiv({ cls: "pantry-sheet-backdrop" });
		}

		this.el = document.body.createDiv({ cls: "pantry-popover" });
		this.el.toggleClass("is-sheet", this.sheet);
		this.draw();
		if (!this.sheet) this.place(anchor);

		this.outsideClick = (event: PointerEvent) => {
			if (!this.el.contains(event.target as Node)) this.close();
		};
		this.onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
		};
		// Deferred so the click that opened the panel does not close it again.
		// Wel eerst kijken of hij intussen al dicht is: sluit er iets binnen die
		// ene tick, dan hingen de luisteraars daarna aan een verdwenen paneel en
		// bleven ze aan `document` hangen tot Obsidian herstartte.
		window.setTimeout(() => {
			if (EatersPopover.open !== this) return;
			document.addEventListener("pointerdown", this.outsideClick);
			document.addEventListener("keydown", this.onKeyDown);
		}, 0);
	}

	static show(
		plugin: PantryPlugin,
		entry: PlannedRecipe,
		anchor: DOMRect,
		onChange: () => void,
		onOpenNote: () => void,
		target: MoveTarget | null = null
	): void {
		EatersPopover.open?.close();
		EatersPopover.open = new EatersPopover(
			plugin,
			entry,
			anchor,
			onChange,
			onOpenNote,
			target
		);
	}

	static closeAny(): void {
		EatersPopover.open?.close();
	}

	private close(): void {
		document.removeEventListener("pointerdown", this.outsideClick);
		document.removeEventListener("keydown", this.onKeyDown);
		this.el.remove();
		this.backdrop?.remove();
		this.backdrop = null;
		if (EatersPopover.open === this) EatersPopover.open = null;
	}

	private place(anchor: DOMRect): void {
		const { offsetWidth: width, offsetHeight: height } = this.el;

		let top = anchor.bottom + 6;
		if (top + height > window.innerHeight - EDGE_MARGIN) {
			top = Math.max(EDGE_MARGIN, anchor.top - height - 6);
		}

		let left = anchor.left;
		left = Math.min(left, window.innerWidth - width - EDGE_MARGIN);
		left = Math.max(EDGE_MARGIN, left);

		this.el.style.top = `${Math.round(top)}px`;
		this.el.style.left = `${Math.round(left)}px`;
	}

	private commit(): void {
		this.onChange();
		this.drawBody();
	}

	private draw(): void {
		const name = linkTarget(this.entry.recipe);

		const header = this.el.createDiv({ cls: "pantry-popover-header" });
		header.createDiv({ cls: "pantry-popover-title", text: name });

		if (this.target) {
			const cook = header.createEl("button", {
				cls: "pantry-icon-button pantry-popover-cook",
				attr: { "aria-label": "Cook this recipe" },
			});
			setIcon(cook, "chef-hat");
			cook.onclick = () => {
				const start = this.target?.cook;
				this.close();
				start?.();
			};
		}

		const openNote = header.createEl("button", {
			cls: "pantry-icon-button pantry-popover-open",
			attr: { "aria-label": "Open recipe note" },
		});
		setIcon(openNote, "file-text");
		openNote.onclick = () => {
			this.close();
			this.onOpenNote();
		};

		if (this.sheet) {
			// No click-outside reflex on touch, so give the sheet a real way out.
			const dismiss = header.createEl("button", {
				cls: "pantry-icon-button pantry-popover-close",
				attr: { "aria-label": "Close" },
			});
			setIcon(dismiss, "x");
			dismiss.onclick = () => this.close();
		}

		this.bodyEl = this.el.createDiv({ cls: "pantry-popover-body" });
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const household = this.plugin.people.all();
		if (household.length === 0) {
			body.createDiv({
				cls: "pantry-settings-hint",
				text: "No household members yet. Add them in the Cupboard settings.",
			});
		} else {
			const list = body.createDiv({ cls: "pantry-eaters" });
			household.forEach((member) => {
				const label = member.name.trim() || member.id;
				const selected = this.entry.eaters.some((stored) =>
					isEater(stored, member.name, member.id)
				);

				const row = list.createEl("button", { cls: "pantry-eater" });
				row.toggleClass("is-selected", selected);
				row.setAttr("aria-pressed", `${selected}`);

				const box = row.createSpan({ cls: "pantry-eater-box" });
				if (selected) setIcon(box, "check");

				row.createSpan({ cls: "pantry-eater-name", text: label });
				if (member.portionFactor !== 1) {
					row.createSpan({
						cls: "pantry-eater-factor",
						text: `×${formatServings(member.portionFactor)}`,
					});
				}

				row.onclick = () => {
					this.entry.eaters = selected
						? this.entry.eaters.filter(
								(stored) => !isEater(stored, member.name, member.id)
						  )
						: [...this.entry.eaters, label];
					this.commit();
				};
			});
		}

		this.drawGuests(body);
		this.drawMove(body);

		this.footerEl = body.createDiv({ cls: "pantry-popover-footer" });
		this.drawFooter();
	}

	/**
	 * Guests are a free number rather than a counter: a visiting child can be
	 * half a portion, so 0.5 has to be typeable. Comma and dot both work.
	 */
	private drawGuests(body: HTMLElement): void {
		const guests = body.createDiv({ cls: "pantry-guests" });
		guests.createEl("label", {
			cls: "pantry-guests-label",
			text: "Guests",
			attr: { for: "pantry-guests-input" },
		});

		const input = guests.createEl("input", {
			cls: "pantry-guests-input",
			attr: {
				id: "pantry-guests-input",
				type: "text",
				inputmode: "decimal",
				placeholder: "0",
				"aria-label": "Number of guests",
			},
		});
		input.value = formatServings(this.entry.guests || 0);

		const parse = (raw: string): number | null => {
			if (raw.trim().length === 0) return 0;
			const value = parseNumber(raw);
			return value !== null && value >= 0 ? value : null;
		};

		const apply = (persist: boolean): void => {
			const value = parse(input.value);
			input.toggleClass("is-invalid", value === null);
			if (value === null) return;
			this.entry.guests = value;
			this.drawFooter();
			if (persist) {
				input.value = formatServings(value);
				this.onChange();
			}
		};

		input.addEventListener("input", () => apply(false));
		input.addEventListener("blur", () => {
			if (parse(input.value) === null) {
				// Reject nonsense rather than silently storing zero.
				input.value = formatServings(this.entry.guests || 0);
				input.removeClass("is-invalid");
				return;
			}
			apply(true);
		});
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				input.blur();
			}
		});
	}

	/**
	 * Sending a recipe to another slot without dragging: pick a day and a meal,
	 * then confirm. The button stays disabled until the choice actually differs,
	 * so a stray tap can never move something by accident.
	 */
	private drawMove(body: HTMLElement): void {
		const target = this.target;
		if (!target) return;

		const section = body.createDiv({ cls: "pantry-move" });
		section.createDiv({ cls: "pantry-move-label", text: "Move to" });

		const row = section.createDiv({ cls: "pantry-move-row" });

		const daySelect = row.createEl("select", {
			cls: "dropdown pantry-move-select",
			attr: { "aria-label": "Day" },
		});
		target.days.forEach((day) => {
			const option = daySelect.createEl("option", { text: day.label });
			option.value = day.value;
			if (day.value === target.date) option.selected = true;
		});

		let mealSelect: HTMLSelectElement | null = null;
		if (target.meals.length > 1) {
			mealSelect = row.createEl("select", {
				cls: "dropdown pantry-move-select",
				attr: { "aria-label": "Meal" },
			});
			target.meals.forEach((meal) => {
				const option = mealSelect?.createEl("option", { text: meal });
				if (!option) return;
				option.value = meal;
				if (meal === target.meal) option.selected = true;
			});
		}

		const apply = row.createEl("button", {
			cls: "pantry-move-button",
			text: "Move",
		});

		const chosenMeal = (): string => mealSelect?.value ?? target.meal;
		const sync = (): void => {
			const changed =
				daySelect.value !== target.date || chosenMeal() !== target.meal;
			apply.disabled = !changed;
			apply.toggleClass("is-ready", changed);
		};

		daySelect.addEventListener("change", sync);
		mealSelect?.addEventListener("change", sync);
		sync();

		apply.onclick = () => {
			if (apply.disabled) return;
			const date = daySelect.value;
			const meal = chosenMeal();
			// Indices shift once the plan changes, so let go of the panel first.
			this.close();
			target.move(date, meal);
		};
	}

	/** Shows the servings needed and, when known, how that scales the recipe. */
	private drawFooter(): void {
		const footer = this.footerEl;
		if (!footer) return;
		footer.empty();

		const needed = servingsFor(this.plugin, this.entry);
		footer.createSpan({
			cls: "pantry-popover-servings",
			text: `${formatServings(needed)} ${needed === 1 ? "serving" : "servings"}`,
		});

		const base = this.recipeServings();
		if (base && base > 0) {
			const factor = needed / base;
			footer.createSpan({
				cls: "pantry-popover-scale",
				text: `recipe serves ${formatServings(base)} · ×${formatServings(
					Math.round(factor * 100) / 100
				)}`,
			});
		}
	}

	/**
	 * Op hoeveel porties het recept zelf geschreven is.
	 *
	 * Was hier een derde uitwerking, en de enige die alleen naar het ingestelde
	 * veld keek: een recept met `porties: 4` in plaats van `servings: 4` viel
	 * hier stil terug op niets, terwijl de kookmodus hem wél las.
	 */
	private recipeServings(): number | null {
		const file = this.plugin.cook.file(linkTarget(this.entry.recipe));
		return file ? this.plugin.cook.baseServings(file) : null;
	}
}
