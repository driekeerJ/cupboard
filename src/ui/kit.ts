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

/** Hoe lang je vasthoudt voordat een tik een "lang drukken" wordt. */
const HOLD_MS = 500;
/** Zoveel mag de vinger schuiven voordat het scrollen is en geen drukken. */
const HOLD_SLOP = 8;

/**
 * Tikken doet het ene, vasthouden het andere.
 *
 * Voor rijen waar de gewone tik de handeling van het moment is (afvinken in
 * de winkel) en de tweede handeling er wel moet zijn maar niet in de weg mag
 * zitten (het product bewerken). Rechtsklik telt als vasthouden, zodat het
 * op een laptop net zo vindbaar is.
 *
 * Tikken luistert op `click` en niet op `pointerup`: een veeg om te scrollen
 * levert geen click op, dus wie door de lijst bladert vinkt niets per ongeluk
 * af. Om dezelfde reden breekt een verschoven vinger het vasthouden af.
 * Android meldt lang drukken zelf ook als `contextmenu`; wie het eerst komt
 * telt, de ander wordt genegeerd.
 */
export function tapOrHold(
	el: HTMLElement,
	tap: () => void,
	hold: () => void
): void {
	let timer = 0;
	let held = false;
	let startX = 0;
	let startY = 0;

	const fire = (): void => {
		window.clearTimeout(timer);
		el.removeClass("is-holding");
		if (held) return;
		held = true;
		hold();
	};
	const cancel = (): void => {
		window.clearTimeout(timer);
		el.removeClass("is-holding");
	};

	el.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0) return;
		held = false;
		startX = event.clientX;
		startY = event.clientY;
		el.addClass("is-holding");
		timer = window.setTimeout(fire, HOLD_MS);
	});
	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (Math.hypot(event.clientX - startX, event.clientY - startY) > HOLD_SLOP) cancel();
	});
	el.addEventListener("pointerup", cancel);
	el.addEventListener("pointerleave", cancel);
	el.addEventListener("pointercancel", cancel);
	el.addEventListener("contextmenu", (event: MouseEvent) => {
		event.preventDefault();
		fire();
	});
	el.addEventListener("click", (event: MouseEvent) => {
		// De click die op een geslaagd vasthouden volgt, is geen tik.
		if (held) {
			held = false;
			event.preventDefault();
			return;
		}
		tap();
	});
}

/**
 * Laat rijen naar hun nieuwe plek glijden in plaats van te verspringen.
 *
 * Elk scherm tekent zijn lijst bij elke wijziging helemaal opnieuw, dus er is
 * geen element dat "verhuist" — alleen een oude en een nieuwe DOM. Daarom
 * FLIP: onthoud waar elke rij met `data-flip` stond, teken opnieuw, en speel
 * per rij het verschil af als een translate die naar nul loopt. Een rij die
 * van plek wisselt is dan te volgen met het oog; dat is in de winkel het
 * verschil tussen "die heb ik" en "welke tikte ik nou aan?".
 */
export function flip(body: HTMLElement, redraw: () => void): void {
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const before = new Map<string, number>();
	if (!reduce) {
		body.querySelectorAll<HTMLElement>("[data-flip]").forEach((row) => {
			const key = row.dataset.flip;
			if (key) before.set(key, row.getBoundingClientRect().top);
		});
	}

	redraw();
	if (reduce) return;

	body.querySelectorAll<HTMLElement>("[data-flip]").forEach((row) => {
		const key = row.dataset.flip;
		const top = key ? before.get(key) : undefined;
		if (top === undefined) return;
		const shift = top - row.getBoundingClientRect().top;
		if (Math.abs(shift) < 1) return;
		row.animate(
			[{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }],
			{ duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" }
		);
	});
}

/**
 * Wat "Package size" en "Amount does not matter" doen, onder het veld zelf.
 *
 * Een placeholder zegt hoe je het invult, niet waarom: een nieuwe gebruiker
 * vroeg wat het veld deed en wat het verschil was tussen de knop en het veld
 * leeg laten. Het antwoord verandert met de knop, dus de zin ook.
 */
export function sizeHint(block: HTMLElement, amountMatters: boolean): void {
	block.createDiv({
		cls: "pantry-sheet-hint",
		text: amountMatters
			? "What one package holds. Recipes ask for 500 g; this turns that into half a 1 kg bag on your list. Left empty, a recipe that asks in grams or millilitres adds nothing to the list."
			: "Recipes never add this to your list and cooking never takes it off stock. Only the minimum counts \u2014 for salt, spices and oil.",
	});
}

export interface ChipPicker {
	label: string;
	/**
	 * What is set now; "" draws the block as still unanswered.
	 *
	 * Een array betekent: er mogen er meerdere aan staan, en de volgorde telt.
	 * De chips krijgen dan een rangnummer, want bij een product dat bij twee
	 * winkels ligt bepaalt die volgorde waar het vandaan komt — en een
	 * volgorde die je niet kunt zien, kun je ook niet bedoelen.
	 */
	value: string | string[];
	options: string[];
	/** True while this picker's free-text field is the open one. */
	typing: boolean;
	/** Opens or closes that field. Only ever one at a time per screen. */
	setTyping: (open: boolean) => void;
	/**
	 * A chip tap or a typed value. "" means: clear this field.
	 *
	 * Bij een meervoudig veld krijgt de callback de aangetikte optie; wat dat
	 * betekent — erbij of eraf — beslist de aanroeper.
	 */
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
	const multi = Array.isArray(spec.value);
	const chosen = (Array.isArray(spec.value) ? spec.value : [spec.value])
		.map((item) => item.trim())
		.filter(Boolean);

	const block = parent.createDiv({ cls: "pantry-sheet-block" });
	block.toggleClass("is-empty", chosen.length === 0);
	block.createDiv({ cls: "pantry-sheet-label", text: spec.label });

	const options = block.createDiv({ cls: "pantry-sheet-options" });
	const rank = new Map(chosen.map((item, index) => [item.toLowerCase(), index]));

	spec.options.forEach((option) => {
		const chip = options.createEl("button", { cls: "pantry-sheet-option" });
		const place = rank.get(option.trim().toLowerCase());
		const active = place !== undefined;
		// Het rangnummer alleen als er iets te kiezen valt: bij één winkel
		// zegt "1" niets en staat het alleen maar in de weg.
		if (multi && active && chosen.length > 1) {
			chip.createSpan({
				cls: "pantry-sheet-option-rank",
				text: `${(place ?? 0) + 1}`,
			});
		}
		chip.createSpan({ text: option });
		chip.toggleClass("is-active", active);
		chip.setAttr("aria-pressed", active ? "true" : "false");
		chip.onclick = () => spec.pick(active && !multi ? "" : option);
	});

	if (spec.typing) {
		const input = block.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: `New ${spec.label.toLowerCase()}` },
		});
		input.value = multi ? "" : (chosen[0] ?? "");
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
			text: chosen.length > 0 ? "Other…" : "Type one…",
		});
		add.onclick = () => spec.setTyping(true);
	}

	return block;
}
