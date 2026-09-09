import { setIcon } from "obsidian";
import type PantryPlugin from "../main";
import type { Count, Product, ProductPatch } from "../products";
import { ProductSheet } from "./product-sheet";

/** Above this many, a segmented control stops being a control and becomes a wall. */
const STRIP_LIMIT = 8;

/**
 * Hoe lang je de skip-knop vasthoudt. Lang genoeg dat een tik die naast de
 * strip belandt niets doet, kort genoeg dat het geen wachten wordt.
 */
const HOLD_MS = 550;

/**
 * Wat een telscherm over een rij te zeggen heeft. Het All stock-scherm en de
 * voorraadcheck van een boodschappenlijst tekenen dezelfde rij — dezelfde
 * strip, dezelfde stepper, dezelfde vlag — en verschillen alleen in de som
 * erachter: tot welk getal de strip loopt en wat er rechts staat.
 */
export interface StockRowContext {
	plugin: PantryPlugin;
	/** The number the control runs to: the minimum plus what the meals ask. */
	need(product: Product): number;
	/** Wat er rechts van de naam staat. */
	status(product: Product): { text: string; kind: "quiet" | "buy" | "ok" };
	/** Writes a change made from a row and redraws. */
	change(product: Product, patch: ProductPatch): void;
	/** Held in place after a change took it off the list; see StockView.leaving. */
	leaving(product: Product): boolean;
	/** Redraw after the product sheet changed something. */
	redraw(): void;
	/**
	 * Deze keer overslaan — alleen op de voorraadcheck van een lijst. Het
	 * All stock-scherm heeft geen "deze keer", dus daar ontbreekt hij.
	 */
	skip?: (product: Product) => void;
}

export function drawStockRow(
	parent: HTMLElement,
	product: Product,
	ctx: StockRowContext
): void {
	const row = parent.createDiv({ cls: "pantry-stock-row" });
	row.toggleClass("is-flagged", product.check);
	row.toggleClass("is-leaving", ctx.leaving(product));

	const top = row.createDiv({ cls: "pantry-stock-line" });
	const name = top.createDiv({ cls: "pantry-stock-name is-tappable" });
	name.createSpan({ text: product.name });
	name.setAttr("role", "button");
	name.setAttr("aria-label", `Edit ${product.name}`);
	// A product moves house more often than you would think; fix it where
	// you notice it, which is here, halfway through the counting round.
	name.onclick = () =>
		new ProductSheet(ctx.plugin, product, "storage", () => ctx.redraw()).open();
	if (product.unit) {
		name.createSpan({ cls: "pantry-stock-unit", text: product.unit });
	}

	const status = ctx.status(product);
	top.createDiv({ cls: `pantry-status is-${status.kind}`, text: status.text });

	const controls = row.createDiv({ cls: "pantry-stock-controls" });
	const need = ctx.need(product);
	if (Math.max(need, 1) <= STRIP_LIMIT) drawStrip(controls, product, ctx);
	else drawStepper(controls, product, ctx);

	const check = controls.createEl("button", { cls: "pantry-flag" });
	const icon = check.createSpan({ cls: "pantry-flag-icon" });
	setIcon(icon, product.check ? "bookmark-check" : "bookmark");
	check.createSpan({ cls: "pantry-flag-label", text: "check" });
	check.toggleClass("is-active", product.check);
	check.setAttr("aria-pressed", product.check ? "true" : "false");
	check.setAttr(
		"aria-label",
		product.check ? "On the check list" : "Put on the check list"
	);
	check.onclick = () => ctx.change(product, { check: !product.check });

	if (ctx.skip) drawSkip(controls, product, ctx.skip);
}

/**
 * Overslaan doe je door vast te houden, niet door te tikken. De knop staat
 * naast een strip waar je de hele telronde op zit te tikken, en één misser
 * haalt anders stilletjes een product van de lijst. Een korte tik zegt alleen
 * hoe het wél moet.
 */
function drawSkip(parent: HTMLElement, product: Product, skip: (product: Product) => void): void {
	const button = parent.createEl("button", { cls: "pantry-skip" });
	setIcon(button.createSpan({ cls: "pantry-skip-icon" }), "circle-off");
	const label = button.createSpan({ cls: "pantry-skip-label", text: "skip" });
	button.setAttr("aria-label", `Hold to skip ${product.name} this time`);

	let timer = 0;
	let hint = 0;
	let held = false;

	const disarm = (): void => {
		window.clearTimeout(timer);
		button.removeClass("is-holding");
	};
	const arm = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		held = false;
		button.addClass("is-holding");
		timer = window.setTimeout(() => {
			held = true;
			disarm();
			skip(product);
		}, HOLD_MS);
	};
	const release = (): void => {
		if (!button.hasClass("is-holding")) return;
		disarm();
		if (held) return;
		// Losgelaten vóór de tijd om was: even zeggen wat er verwacht wordt.
		label.setText("hold…");
		window.clearTimeout(hint);
		hint = window.setTimeout(() => label.setText("skip"), 900);
	};

	button.addEventListener("pointerdown", arm);
	button.addEventListener("pointerup", release);
	button.addEventListener("pointerleave", release);
	button.addEventListener("pointercancel", release);
	// Lang drukken opent op een telefoon anders het contextmenu.
	button.addEventListener("contextmenu", (event) => event.preventDefault());
	button.onclick = (event) => event.preventDefault();
}

/**
 * Een overgeslagen product: alleen de naam en de weg terug. Geen strip, want
 * tellen was precies wat je niet ging doen. Terugnemen is één tik — per
 * ongeluk iets wél meenemen is geen ramp.
 */
export function drawSkippedRow(
	parent: HTMLElement,
	product: Product,
	restore: (product: Product) => void
): void {
	const row = parent.createDiv({ cls: "pantry-stock-row is-skipped" });
	const top = row.createDiv({ cls: "pantry-stock-line" });
	const name = top.createDiv({ cls: "pantry-stock-name" });
	name.createSpan({ text: product.name });
	if (product.unit) {
		name.createSpan({ cls: "pantry-stock-unit", text: product.unit });
	}
	const button = top.createEl("button", { cls: "pantry-skip is-active" });
	setIcon(button.createSpan({ cls: "pantry-skip-icon" }), "undo-2");
	button.createSpan({ cls: "pantry-skip-label", text: "take along" });
	button.setAttr("aria-label", `Take ${product.name} along after all`);
	button.onclick = () => restore(product);
}

function drawStrip(parent: HTMLElement, product: Product, ctx: StockRowContext): void {
	const strip = parent.createDiv({ cls: "pantry-strip" });
	const max = Math.max(ctx.need(product), 1);

	// Highest on the left: "plenty" is the answer given most often, so it
	// sits where the thumb lands first.
	stripButton(strip, product, ctx, "plus", `${max}+`, "is-plus");
	for (let value = max; value >= 0; value--) {
		stripButton(strip, product, ctx, value, `${value}`, value === 0 ? "is-zero" : "");
	}
}

function stripButton(
	strip: HTMLElement,
	product: Product,
	ctx: StockRowContext,
	value: Count,
	label: string,
	extraClass: string
): void {
	const button = strip.createEl("button", {
		cls: `pantry-strip-item ${extraClass}`.trim(),
		text: label,
	});
	const active = product.count === value;
	button.toggleClass("is-active", active);
	button.onclick = () => {
		// Tapping the same value again means "never mind", so it clears.
		const next: Count | null = active ? null : value;
		ctx.change(product, { count: next, check: false });
	};
}

function drawStepper(parent: HTMLElement, product: Product, ctx: StockRowContext): void {
	const wrap = parent.createDiv({ cls: "pantry-stepper" });
	const max = Math.max(ctx.need(product), 1);

	// De stand zoals de gebruiker hem aan het maken is, los van wat er op
	// schijf staat. − en + lazen eerst allebei `product.count` op kliktijd
	// en wachtten dan een frontmatter-write af; twee snelle tikken lazen
	// dus dezelfde waarde en telden er samen één bij.
	let wanted: Count | null =
		product.count === "plus"
			? "plus"
			: typeof product.count === "number"
				? product.count
				: null;
	let pending = 0;

	const asNumber = (): number =>
		wanted === "plus" ? max : typeof wanted === "number" ? wanted : 0;

	const none = wrap.createEl("button", { cls: "pantry-stepper-edge", text: "0" });
	const minus = wrap.createEl("button", { cls: "pantry-stepper-step" });
	setIcon(minus, "minus");
	const value = wrap.createDiv({ cls: "pantry-stepper-value" });
	const plus = wrap.createEl("button", { cls: "pantry-stepper-step" });
	setIcon(plus, "plus");
	const plenty = wrap.createEl("button", { cls: "pantry-stepper-edge", text: `${max}+` });

	const paint = (): void => {
		none.toggleClass("is-active", wanted === 0);
		plenty.toggleClass("is-active", wanted === "plus");
		value.setText(wanted === "plus" ? `${max}+` : wanted === null ? "–" : `${wanted}`);
	};
	paint();

	const set = (next: Count | null): void => {
		wanted = next;
		paint();
		window.clearTimeout(pending);
		// Wachten tot de vingers stilliggen; anders is elke tik een
		// schrijfactie naar de frontmatter.
		pending = window.setTimeout(() => {
			ctx.change(product, { count: wanted, check: false });
		}, 350);
	};

	none.onclick = () => set(0);
	minus.onclick = () => set(Math.max(0, asNumber() - 1));
	plus.onclick = () => set(Math.min(max, asNumber() + 1));
	plenty.onclick = () => set("plus");
}

/** Wat er rechts van een productnaam staat, gegeven wat er te kopen valt. */
export function stockStatus(
	need: number,
	buy: number | null
): { text: string; kind: "quiet" | "buy" | "ok" } {
	if (need <= 0) return { text: "no minimum set", kind: "quiet" };
	if (buy === null) return { text: "not counted", kind: "quiet" };
	if (buy > 0) return { text: `buy ${buy}`, kind: "buy" };
	return { text: "enough", kind: "ok" };
}
