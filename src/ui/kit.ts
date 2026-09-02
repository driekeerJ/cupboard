/**
 * De brokjes DOM die in bijna elk scherm terugkomen.
 *
 * Het segmented control stond zes keer uitgeschreven, de lege staat vijf keer,
 * en het bewaren van de scrollpositie twee keer tot en met het commentaarblok.
 * Zes kopieën betekent dat een verbetering aan één ervan de andere vijf uit
 * elkaar laat lopen — en dat is precies hoe schermen die op elkaar horen te
 * lijken langzaam gaan verschillen.
 */

export interface SegmentOption<T> {
	value: T;
	label: string;
	/** Vraagt aandacht: gebruikt voor "Missing info" met een aantal erachter. */
	alarm?: boolean;
}

/**
 * Een rij knoppen waarvan er één actief is.
 *
 * `parent` krijgt de rij eronder; de rij zelf wordt teruggegeven zodat een
 * scherm er nog iets aan kan hangen.
 */
export function segment<T>(
	parent: HTMLElement,
	options: readonly SegmentOption<T>[],
	active: T,
	pick: (value: T) => void,
	cls = "pantry-segment"
): HTMLElement {
	const row = parent.createDiv({ cls });
	for (const option of options) {
		const chip = row.createEl("button", {
			cls: "pantry-segment-item",
			text: option.label,
		});
		chip.toggleClass("is-active", option.value === active);
		if (option.alarm) chip.addClass("is-alarm");
		chip.onclick = () => pick(option.value);
	}
	return row;
}

/** Wat er staat als er niets te tonen is: een titel en een zin die verder helpt. */
export function emptyState(
	parent: HTMLElement,
	title: string,
	hint: string
): HTMLElement {
	const wrap = parent.createDiv({ cls: "pantry-empty" });
	wrap.createDiv({ cls: "pantry-empty-title", text: title });
	wrap.createDiv({ cls: "pantry-empty-hint", text: hint });
	return wrap;
}

/**
 * Onthoudt waar je was; de teruggegeven functie zet je daar terug.
 *
 * Een tik werkt de telling bij en tekent de lijst opnieuw; zonder dit sprong
 * die lijst elke keer naar boven, midden in de winkel. Als functie en niet als
 * wrapper, omdat elke lijst onderweg vroeg terug kan keren \u2014 en juist die
 * afslagen vergaten het herstellen toen elk scherm het zelf deed.
 */
export function keepScroll(body: HTMLElement): () => void {
	const scroller =
		(body.closest(".view-content")) ?? body.parentElement;
	const scroll = scroller?.scrollTop ?? 0;
	return () => {
		if (scroller) scroller.scrollTop = scroll;
	};
}

export interface ChipPicker {
	label: string;
	/** What is set now; "" draws the block as still unanswered. */
	value: string;
	options: string[];
	/** True while this picker's free-text field is the open one. */
	typing: boolean;
	/** Opens or closes that field. Only ever one at a time per screen. */
	setTyping: (open: boolean) => void;
	/** A chip tap or a typed value. "" means: clear this field. */
	pick: (value: string) => void;
}

/**
 * Chips, not a text box: in a shop you tap, you do not type. The free-text
 * field is there for the one time the name you need does not exist yet.
 *
 * Tapping the chip that is already active clears the field, so a wrong value
 * never needs a detour through the note.
 *
 * Product sheet and new-product form draw the same block. They differ only in
 * what a tap does — the sheet writes to the note at once, the form holds a
 * draft until you press Add — and that difference is the `pick` callback.
 */
export function chipPicker(parent: HTMLElement, spec: ChipPicker): HTMLElement {
	const block = parent.createDiv({ cls: "pantry-sheet-block" });
	block.toggleClass("is-empty", spec.value.trim().length === 0);
	block.createDiv({ cls: "pantry-sheet-label", text: spec.label });

	const options = block.createDiv({ cls: "pantry-sheet-options" });
	const current = spec.value.trim().toLowerCase();

	spec.options.forEach((option) => {
		const chip = options.createEl("button", {
			cls: "pantry-sheet-option",
			text: option,
		});
		const active = option.trim().toLowerCase() === current;
		chip.toggleClass("is-active", active);
		chip.setAttr("aria-pressed", active ? "true" : "false");
		chip.onclick = () => spec.pick(active ? "" : option);
	});

	if (spec.typing) {
		const input = block.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: `New ${spec.label.toLowerCase()}` },
		});
		input.value = spec.value;
		window.setTimeout(() => input.focus(), 0);
		const commit = (): void => {
			const value = input.value.trim();
			if (value.length === 0) {
				spec.setTyping(false);
				return;
			}
			spec.pick(value);
		};
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") commit();
			if (event.key === "Escape") spec.setTyping(false);
		});
		input.addEventListener("blur", commit);
	} else {
		const add = options.createEl("button", {
			cls: "pantry-sheet-option is-add",
			text: spec.value ? "Other…" : "Type one…",
		});
		add.onclick = () => spec.setTyping(true);
	}

	return block;
}
