/**
 * Een browserpagina in Node, met Obsidians eigen DOM-hulpjes erop.
 *
 * De schermen van Cupboard zijn gewone klassen die een `contentEl` vullen. Of
 * de juiste knop er staat, of een rij het goede label draagt, of een tik de
 * goede schrijfactie doet — daar is geen Obsidian voor nodig, alleen een DOM.
 * Tot 1.4 kon dat alleen in `npm run e2e`: een tweede Obsidian opstarten, op
 * macOS, een minuut of langer. Dat draait niemand voor elke wijziging, en in
 * CI of op Linux draait het helemaal niet.
 *
 * Dit is happy-dom plus de handvol methodes die Obsidian op `Node` en
 * `Element` zet (`createDiv`, `toggleClass`, `setText`, …). De broncode draait
 * ongewijzigd; alleen wat eronder ligt is nagebouwd.
 *
 * Wat dit **niet** bewijst, en dus in de e2e blijft: CSS en layout (er wordt
 * niets getekend), echte aanraking (tik tegenover scroll), animaties, en dat
 * Obsidian de plugin laadt.
 */
import { Window } from "happy-dom";

/** Wat Obsidians `createEl` als tweede argument aanneemt. */
type ElOptions =
	| string
	| {
			cls?: string | string[];
			text?: string;
			attr?: Record<string, string | number | boolean | null>;
			type?: string;
			value?: string;
			placeholder?: string;
			href?: string;
			title?: string;
	  };

interface Patched {
	[key: string]: unknown;
}

let installed = false;

/** Zet `window`, `document` en Obsidians hulpjes neer. Eén keer per testbestand. */
export function installDom(): void {
	if (installed) return;
	installed = true;

	const window = new Window({ url: "app://obsidian.md/" });
	const g = globalThis as unknown as Patched;
	const w = window as unknown as Patched;
	g.window = window;
	g.document = window.document;
	// Obsidian houdt deze bij als het venster dat het laatst de focus had. In
	// een test is er maar één venster.
	g.activeWindow = window;
	g.activeDocument = window.document;
	for (const name of [
		"HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement",
		"Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent",
		"CustomEvent", "getComputedStyle", "CSS",
	]) {
		if (w[name] !== undefined) g[name] = w[name];
	}
	// De schermen roepen deze op `window` aan; in Node zijn het dezelfde timers.
	w.requestAnimationFrame = (fn: (time: number) => void): number =>
		setTimeout(() => fn(Date.now()), 0) as unknown as number;
	w.cancelAnimationFrame = (id: number): void => clearTimeout(id);
	g.requestAnimationFrame = w.requestAnimationFrame;
	// Geen animaties in een test: `flip()` in kit.ts tekent dan gewoon opnieuw.
	w.matchMedia = (): { matches: boolean } => ({ matches: true });

	const doc = window.document as unknown as Document;
	const create = (parent: Node, tag: string, options?: ElOptions): HTMLElement => {
		const el = doc.createElement(tag);
		const o = typeof options === "string" ? { cls: options } : (options ?? {});
		if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
		if (o.text !== undefined) el.textContent = o.text;
		for (const [key, value] of Object.entries(o.attr ?? {})) {
			if (value !== null) el.setAttribute(key, String(value));
		}
		if (o.type) el.setAttribute("type", o.type);
		if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
		if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
		if (o.href) el.setAttribute("href", o.href);
		if (o.title) el.setAttribute("title", o.title);
		parent.appendChild(el);
		return el;
	};

	const node = (w.Node as { prototype: Patched }).prototype;
	node.createEl = function (this: Node, tag: string, options?: ElOptions) {
		return create(this, tag, options);
	};
	node.createDiv = function (this: Node, options?: ElOptions) {
		return create(this, "div", options);
	};
	node.createSpan = function (this: Node, options?: ElOptions) {
		return create(this, "span", options);
	};
	node.empty = function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	node.detach = function (this: Node) {
		this.parentNode?.removeChild(this);
	};
	// Obsidians `instanceof` over vensters heen: in een los venster heeft elk
	// element de klassen van dat venster. Hier is er één venster, dus is het
	// gewoon `instanceof`.
	node.instanceOf = function (this: Node, type: new () => unknown) {
		return this instanceof type;
	};
	// Het document en venster waar een element in staat; een document is
	// zijn eigen document.
	const docOf = (n: Node): Document => n.ownerDocument ?? (n as Document);
	Object.defineProperty(node, "doc", {
		get(this: Node) {
			return docOf(this);
		},
	});
	Object.defineProperty(node, "win", {
		get(this: Node) {
			return docOf(this).defaultView;
		},
	});

	const element = (w.Element as { prototype: Patched }).prototype;
	const classes = (names: string[]): string[] =>
		names.flatMap((name) => name.split(/\s+/)).filter(Boolean);
	element.addClass = function (this: Element, ...names: string[]) {
		this.classList.add(...classes(names));
	};
	element.removeClass = function (this: Element, ...names: string[]) {
		this.classList.remove(...classes(names));
	};
	element.toggleClass = function (this: Element, names: string | string[], on: boolean) {
		for (const name of classes([names].flat())) this.classList.toggle(name, on);
	};
	element.hasClass = function (this: Element, name: string) {
		return this.classList.contains(name);
	};
	element.setText = function (this: Element, text: string) {
		this.textContent = text;
	};
	element.setAttr = function (this: Element, name: string, value: string | number | boolean | null) {
		if (value === null) this.removeAttribute(name);
		else this.setAttribute(name, String(value));
	};
	element.find = function (this: Element, selector: string) {
		return this.querySelector(selector);
	};
	element.findAll = function (this: Element, selector: string) {
		return Array.from(this.querySelectorAll(selector));
	};
	element.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		Object.assign(this.style, styles);
	};
	element.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
	};
	element.show = function (this: HTMLElement) {
		this.style.display = "";
	};
	element.hide = function (this: HTMLElement) {
		this.style.display = "none";
	};
}

/**
 * Wacht tot alles wat een klik in gang zette is uitgewerkt.
 *
 * Een handler gaat via `guarded()` de deur uit en schrijft daarna pas; de
 * schrijfacties van de neppe vault zijn promises zonder echte wachttijd. Een
 * paar rondes door de takenwachtrij is dus genoeg, en klokvast: er is geen
 * `sleep(900)` die op een trage machine net te kort is.
 */
export async function settle(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

/** Een klik zoals een muis hem geeft; `onclick` en `addEventListener` horen hem allebei. */
export async function click(el: Element | null | undefined): Promise<void> {
	if (!el) throw new Error("nothing to click");
	(el as HTMLElement).click();
	await settle();
}

export function all(root: ParentNode, selector: string): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/** De tekst van een element, zonder de witruimte van de opmaak. */
export function text(el: Element | null | undefined): string {
	return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Het eerste element onder `root` met precies deze tekst. */
export function byText(root: ParentNode, selector: string, wanted: string): HTMLElement | null {
	return all(root, selector).find((el) => text(el) === wanted) ?? null;
}
