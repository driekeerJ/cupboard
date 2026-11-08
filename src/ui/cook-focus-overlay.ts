/**
 * De focusmodus als volledig scherm.
 *
 * Een kaart midden in de kookweergave liet alles eromheen staan: tabbladen,
 * de linkerbalk, de statusbalk, de knoppen boven het recept. Aan het aanrecht
 * is dat ruis. Deze laag hangt daarom aan de `body` van het venster waarin de
 * kookweergave staat — boven heel Obsidian, en in een los venster dáár, en laat alleen zien wat je nú doet, wat er hierna komt en hoe
 * ver je bent.
 *
 * De laag bezit niets. Vinkjes gaan via de kookweergave naar de notitie
 * (`FocusHost.save`), en wat er getoond wordt komt elke keer opnieuw uit
 * `host.note()` — zodat een vinkje dat via Sync binnenkomt hier gewoon klopt.
 */

import {
	firstOpenSlide,
	focusSlides,
	isSlideDone,
	nextOpenSlide,
	type FocusSlide,
} from "../cook-focus";
import type { CookLine, CookNote } from "../cook-session";
import { withoutLinks } from "../ingredients";

/**
 * Hoe lang een afgevinkte dia nog blijft staan voordat de volgende komt. Lang
 * genoeg om het vinkje te zien landen — en om een misser terug te tikken
 * voordat de dia wegschuift — kort genoeg om niet te wachten.
 */
const ADVANCE_MS = 300;

/** Zo ver moet een vinger horizontaal schuiven voordat het een veeg is. */
const SWIPE_PX = 60;

export interface FocusHost {
	/** Een element in de kookweergave: bepaalt in welk venster de laag komt. */
	anchor(): HTMLElement;
	note(): CookNote;
	title(): string;
	/** Zet het vinkje van deze regel in de notitie; de regel is al bijgewerkt. */
	save(line: CookLine): void;
	/** Staptekst met timerknoppen, zoals in de lijst. */
	stepText(host: HTMLElement, text: string, step: number): void;
	/** Vóór het tekenen van een dia: oude timerknoppen vergeten. */
	beginSlide(): void;
	/** Na het tekenen: de klokjes meteen goed zetten. */
	endSlide(): void;
	closed(): void;
}

type Direction = "next" | "prev" | "none";

interface WakeLockHandle {
	release(): Promise<void>;
}

export class FocusOverlay {
	private host: FocusHost;
	private el: HTMLElement | null = null;
	private stage: HTMLElement | null = null;
	private bar: HTMLElement | null = null;
	private counter: HTMLElement | null = null;
	private upNext: HTMLElement | null = null;
	private prevButton: HTMLButtonElement | null = null;
	private nextButton: HTMLButtonElement | null = null;

	private slide = 0;
	/** Na de laatste dia: het afsluitscherm in plaats van een dia. */
	private finished = false;
	private advanceTimer: number | null = null;
	private wakeLock: WakeLockHandle | null = null;
	private touch: { x: number; y: number } | null = null;
	private doc: Document = document;
	private win: Window = window;

	private readonly onKey = (event: KeyboardEvent): void => this.key(event);
	private readonly onVisible = (): void => {
		if (this.doc.visibilityState !== "visible") return;
		// Het besturingssysteem liet het slot los toen de app naar de
		// achtergrond ging; het oude handvat zegt niets meer.
		this.wakeLock = null;
		this.keepAwake();
	};

	constructor(host: FocusHost) {
		this.host = host;
	}

	get isOpen(): boolean {
		return this.el !== null;
	}

	open(): void {
		if (this.el) return;

		// Een kookweergave in een los venster (popout) krijgt de laag in dát
		// venster, niet in het hoofdvenster waar niemand kijkt.
		this.doc = this.host.anchor().ownerDocument;
		this.win = this.doc.defaultView ?? window;
		const el = this.doc.body.createDiv({ cls: "pantry-focus-overlay" });
		el.setAttr("role", "dialog");
		el.setAttr("aria-modal", "true");
		el.setAttr("aria-label", `Cooking: ${this.host.title()}`);
		this.el = el;

		const progress = el.createDiv({ cls: "pantry-focus-progress" });
		this.bar = progress.createDiv({ cls: "pantry-focus-progress-bar" });

		const top = el.createDiv({ cls: "pantry-focus-top" });
		top.createDiv({ cls: "pantry-focus-recipe", text: this.host.title() });
		this.counter = top.createDiv({ cls: "pantry-focus-counter" });
		const close = top.createEl("button", {
			cls: "pantry-focus-close",
			text: "×",
			attr: { "aria-label": "Close focus mode" },
		});
		close.onclick = () => this.close();

		this.stage = el.createDiv({ cls: "pantry-focus-stage" });

		const bottom = el.createDiv({ cls: "pantry-focus-bottom" });
		this.prevButton = bottom.createEl("button", {
			cls: "pantry-focus-nav is-prev",
			text: "‹  Back",
			attr: { "aria-label": "Previous step" },
		});
		this.prevButton.onclick = () => this.back();
		this.upNext = bottom.createDiv({ cls: "pantry-focus-next" });
		this.nextButton = bottom.createEl("button", {
			cls: "pantry-focus-nav is-next",
			text: "Next  ›",
			attr: { "aria-label": "Next step" },
		});
		this.nextButton.onclick = () => this.forward();

		// Vegen werkt op telefoon en iPad. De laag zit buiten Obsidians
		// werkruimte en houdt de aanraking voor zich, zodat dezelfde veeg niet
		// ook de zijbalk openschuift.
		el.addEventListener("touchstart", (event) => this.touchStart(event), { passive: true });
		el.addEventListener("touchend", (event) => this.touchEnd(event));
		el.addEventListener("touchmove", (event) => event.stopPropagation(), { passive: true });

		this.win.addEventListener("keydown", this.onKey, true);
		this.doc.addEventListener("visibilitychange", this.onVisible);

		this.slide = firstOpenSlide(focusSlides(this.host.note()));
		this.finished = false;
		this.render("none");
		this.keepAwake();

		// Eén frame later, zodat de laag zichtbaar invloeit in plaats van
		// ineens over alles heen te staan.
		this.win.requestAnimationFrame(() => el.addClass("is-open"));
	}

	close(): void {
		if (!this.el) return;
		this.cancelAdvance();
		this.win.removeEventListener("keydown", this.onKey, true);
		this.doc.removeEventListener("visibilitychange", this.onVisible);
		this.release();
		this.el.remove();
		this.el = null;
		this.stage = null;
		this.host.beginSlide();
		this.host.closed();
	}

	/** De notitie is opnieuw gelezen: dezelfde dia, met de nieuwe vinkjes. */
	refresh(fromStart = false): void {
		if (!this.el) return;
		if (fromStart) {
			this.cancelAdvance();
			this.slide = 0;
			this.finished = false;
		}
		this.render("none");
	}

	private slides(): FocusSlide[] {
		return focusSlides(this.host.note());
	}

	private render(direction: Direction): void {
		const stage = this.stage;
		if (!stage) return;
		const slides = this.slides();
		this.slide = Math.min(Math.max(0, this.slide), Math.max(0, slides.length - 1));

		this.host.beginSlide();
		stage.empty();
		const view = stage.createDiv({ cls: "pantry-focus-slide" });
		if (direction !== "none") view.addClass(`is-enter-${direction}`);

		const slide = slides[this.slide];
		if (slides.length === 0 || !slide) {
			view.createDiv({
				cls: "pantry-focus-empty",
				text: "This session has nothing to tick off. Close focus mode and use Start over to build it from the recipe again.",
			});
		} else if (this.finished) {
			this.drawFinished(view, slides);
		} else {
			this.drawSlide(view, slide, slides);
		}

		this.drawChrome(slides);
		this.host.endSlide();
	}

	private drawSlide(view: HTMLElement, slide: FocusSlide, slides: FocusSlide[]): void {
		view.createDiv({
			cls: "pantry-focus-kicker",
			text: slide.kind === "ingredients" ? "Ingredients" : "Method",
		});
		view.createEl("h1", {
			cls: "pantry-focus-title",
			text: slide.label ?? "Get ready",
		});

		const list = view.createDiv({ cls: "pantry-focus-lines" });
		for (const line of slide.lines) {
			this.drawLine(list, slide, line, slides);
		}
	}

	private drawLine(
		list: HTMLElement,
		slide: FocusSlide,
		line: CookLine,
		slides: FocusSlide[]
	): void {
		// Een stap kan timerknoppen bevatten, en een knop in een knop is geen
		// geldige HTML. Daarom is de regel zelf een div met een rol.
		const row = list.createDiv({ cls: "pantry-focus-line" });
		row.setAttr("role", "checkbox");
		row.setAttr("tabindex", "0");
		const box = row.createSpan({ cls: "pantry-focus-box" });
		// Een teken in plaats van een icoon: dat rendert altijd.
		box.createSpan({ cls: "pantry-focus-tick", text: "✓" });

		const text = row.createDiv({ cls: "pantry-focus-text" });
		if (slide.kind === "step") this.host.stepText(text, line.text, line.index);
		else text.setText(withoutLinks(line.text));

		const paint = (): void => {
			row.toggleClass("is-done", line.done);
			row.setAttr("aria-checked", `${line.done}`);
		};
		paint();

		const toggle = (): void => {
			line.done = !line.done;
			paint();
			this.host.save(line);
			this.afterTick(slide, slides);
		};
		row.addEventListener("click", (event) => {
			// Een tik op een timer start de timer, en vinkt de stap niet af.
			if ((event.target as HTMLElement).closest(".pantry-timer")) return;
			toggle();
		});
		row.addEventListener("keydown", (event) => {
			if (event.key !== " " && event.key !== "Enter") return;
			event.preventDefault();
			toggle();
		});
	}

	private drawFinished(view: HTMLElement, slides: FocusSlide[]): void {
		view.addClass("is-finished");
		const open = slides.filter((slide) => !isSlideDone(slide)).length;

		// Doorgeklikt zonder alles af te vinken is iets anders dan klaar:
		// dan zeggen we dat er nog iets openstaat, en niet "smakelijk eten".
		if (open > 0) {
			view.createDiv({ cls: "pantry-focus-badge is-open", text: `${open}` });
			view.createEl("h1", { cls: "pantry-focus-title", text: "Almost there" });
			view.createDiv({
				cls: "pantry-focus-subtitle",
				text: `${open} ${open === 1 ? "slide still has" : "slides still have"} something to tick off.`,
			});
			const go = view.createEl("button", { cls: "pantry-focus-done", text: "Show me" });
			go.onclick = () => this.goTo(firstOpenSlide(this.slides()));
			return;
		}

		view.createDiv({ cls: "pantry-focus-badge", text: "✓" });
		view.createEl("h1", { cls: "pantry-focus-title", text: "All done" });
		view.createDiv({
			cls: "pantry-focus-subtitle",
			text: "Everything is ticked off. Enjoy your meal.",
		});
		const close = view.createEl("button", { cls: "pantry-focus-done", text: "Close" });
		close.onclick = () => this.close();
	}

	/** Voortgang, teller, "hierna" en de knoppen onderaan. */
	private drawChrome(slides: FocusSlide[]): void {
		const total = slides.length;
		const done = slides.filter((slide) => isSlideDone(slide)).length;
		if (this.bar) {
			this.bar.style.width = total > 0 ? `${(done / total) * 100}%` : "0%";
		}
		if (this.counter) {
			this.counter.setText(
				this.finished || total === 0 ? "" : `${this.slide + 1} of ${total}`
			);
		}

		if (this.upNext) {
			this.upNext.empty();
			const next = this.finished ? undefined : slides[this.slide + 1];
			if (next) {
				this.upNext.createSpan({ cls: "pantry-focus-next-label", text: "Up next" });
				this.upNext.createSpan({ cls: "pantry-focus-next-text", text: preview(next) });
			}
		}

		if (this.prevButton) this.prevButton.disabled = !this.finished && this.slide === 0;
		if (this.nextButton) {
			const last = this.slide >= total - 1;
			this.nextButton.disabled = this.finished || total === 0;
			this.nextButton.setText(last ? "Finish  ✓" : "Next  ›");
		}
	}

	/**
	 * Na elk vinkje: is de dia nu af, dan schuift de volgende open dia er
	 * vanzelf in. Tik je in de tussentijd iets weer uit, dan blijft hij staan.
	 */
	private afterTick(slide: FocusSlide, slides: FocusSlide[]): void {
		this.cancelAdvance();
		this.drawChrome(slides);
		if (!isSlideDone(slide)) return;

		const from = this.slide;
		const target = nextOpenSlide(slides, from);
		this.advanceTimer = this.win.setTimeout(() => {
			this.advanceTimer = null;
			// Intussen zelf gebladerd? Dan niet alsnog wegspringen.
			if (!this.el || this.slide !== from || this.finished) return;
			if (target === null) {
				this.finished = true;
				this.render("next");
			} else {
				this.goTo(target);
			}
		}, ADVANCE_MS);
	}

	private forward(): void {
		const slides = this.slides();
		if (this.finished) return;
		if (this.slide >= slides.length - 1) {
			this.cancelAdvance();
			this.finished = true;
			this.render("next");
			return;
		}
		this.goTo(this.slide + 1);
	}

	private back(): void {
		if (this.finished) {
			this.cancelAdvance();
			this.finished = false;
			this.render("prev");
			return;
		}
		this.goTo(this.slide - 1);
	}

	private goTo(index: number): void {
		this.cancelAdvance();
		const count = this.slides().length;
		const next = Math.min(Math.max(0, index), Math.max(0, count - 1));
		if (next === this.slide && !this.finished) return;
		const direction: Direction = next < this.slide ? "prev" : "next";
		this.slide = next;
		this.finished = false;
		this.render(direction);
	}

	private cancelAdvance(): void {
		if (this.advanceTimer === null) return;
		this.win.clearTimeout(this.advanceTimer);
		this.advanceTimer = null;
	}

	private key(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		// Het doel kan ook het venster zelf zijn, en dat heeft geen `closest`.
		// Geen `instanceof Element`: in een los venster is dat een andere
		// Element-klasse en zou de vergelijking altijd mislukken.
		const target = event.target as Partial<Element> | null;
		if (target?.closest?.("input, textarea, [contenteditable='true']")) return;

		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.close();
		} else if (event.key === "ArrowRight" || event.key === "PageDown") {
			event.preventDefault();
			event.stopPropagation();
			this.forward();
		} else if (event.key === "ArrowLeft" || event.key === "PageUp") {
			event.preventDefault();
			event.stopPropagation();
			this.back();
		}
	}

	private touchStart(event: TouchEvent): void {
		event.stopPropagation();
		const point = event.touches[0];
		this.touch = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null;
	}

	private touchEnd(event: TouchEvent): void {
		event.stopPropagation();
		const start = this.touch;
		this.touch = null;
		const point = event.changedTouches[0];
		if (!start || !point) return;
		const dx = point.clientX - start.x;
		const dy = point.clientY - start.y;
		if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
		if (dx < 0) this.forward();
		else this.back();
	}

	/**
	 * Het scherm aan houden zolang je kookt: met natte handen ontgrendel je
	 * geen iPad. Niet elk platform kent dit; dan gebeurt er gewoon niets.
	 */
	private keepAwake(): void {
		if (!this.el || this.wakeLock) return;
		const api = (this.win.navigator as Navigator & {
			wakeLock?: { request(type: "screen"): Promise<WakeLockHandle> };
		}).wakeLock;
		if (!api) return;
		api.request("screen").then(
			(lock) => {
				if (this.el) this.wakeLock = lock;
				else lock.release().catch(() => undefined);
			},
			// Geweigerd (bijv. batterijbesparing): het scherm mag dan uit.
			() => undefined
		);
	}

	private release(): void {
		this.wakeLock?.release().catch(() => undefined);
		this.wakeLock = null;
	}
}

/** Eén regel over de volgende dia, voor "Up next". */
function preview(slide: FocusSlide): string {
	if (slide.kind === "step") return withoutLinks(slide.lines[0]?.text ?? "");
	const count = slide.lines.length;
	const what = `${count} ingredient${count === 1 ? "" : "s"}`;
	return slide.label ? `${slide.label} · ${what}` : what;
}
