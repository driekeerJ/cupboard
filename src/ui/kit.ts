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
