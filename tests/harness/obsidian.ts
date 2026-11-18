/**
 * Wat de plugin van Obsidian gebruikt, nagebouwd.
 *
 * De kern draait op **zes** dingen: `vault.cachedRead`,
 * `metadataCache.getFileCache().frontmatter`, `fileManager.processFrontMatter`,
 * `metadataCache.getFirstLinkpathDest`, `vault.getMarkdownFiles` en
 * `vault.getFileByPath`. Die zitten in `vault.ts`. Dit bestand is alleen de
 * module `obsidian` zelf: de handvol klassen en functies die de kernbestanden
 * importeren.
 *
 * Waarom een module-stub en geen bundel: Node vervangt bij het draaien van de
 * tests de specifier "obsidian" door dit bestand (zie `register.mjs`), zodat
 * `products.ts`, `needs.ts`, `list.ts` en `consume.ts` **ongewijzigd** draaien.
 * Er is dus geen tweede versie van de code die kan gaan afwijken.
 */
import { dump, load } from "./yaml";

export class TAbstractFile {
	path = "";
	name = "";
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "md";
}

/**
 * Echte klassen, geen platte objecten: `markdownIn()` in src/folder.ts leunt op
 * `instanceof`, zoals Obsidians eigen richtlijn voorschrijft.
 */
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

/** Alleen aanwezig omdat plan.ts en settings.ts ze importeren; nooit gebruikt. */
export class MarkdownView {}
export class PluginSettingTab {
	constructor(_app?: unknown, _plugin?: unknown) {}
}
export class Setting {}
export class App {}
export class Menu {}
/**
 * In Obsidian alleen een type. De schermen importeren het zonder `type`, en
 * Node laat zo'n import staan — dus moet er iets met die naam zijn.
 */
export class ViewStateResult {}

/**
 * Elke melding die de plugin toont, in volgorde. Een schermtest kijkt hier
 * of een mislukte schrijfactie gemeld is — en of een geslaagde stil bleef.
 */
export const notices: string[] = [];

export class Notice {
	constructor(message?: string) {
		notices.push(String(message ?? ""));
	}
}

export class MarkdownRenderChild {}

/** Geen telefoon, geen Mac: de schermen vragen dit alleen voor kleine verschillen. */
export const Platform = { isMobile: false, isPhone: false, isDesktop: true, isMacOS: false, isIosApp: false, isAndroidApp: false };

/**
 * Het deel van `Plugin` waar `main.ts` op leunt bij het laden. Alles wat de
 * plugin aanmeldt wordt hier bewaard, zodat een test kan nakijken dat een
 * nieuw scherm en zijn commando er ook echt bij zijn — het soort fout dat
 * anders pas blijkt als de e2e zegt dat de plugin niet geladen is.
 */
export class Plugin {
	app: unknown;
	manifest: unknown;
	/** Elk aangemeld commando, op id. */
	commands: Map<string, { id: string; name: string; callback?: () => unknown }> = new Map();
	/** Elk aangemeld scherm: het type en de functie die het aanmaakt. */
	views: Map<string, (leaf: WorkspaceLeaf) => unknown> = new Map();

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	addCommand(command: { id: string; name: string; callback?: () => unknown }): void {
		if (this.commands.has(command.id)) throw new Error(`command ${command.id} is registered twice`);
		this.commands.set(command.id, command);
	}

	registerView(type: string, create: (leaf: WorkspaceLeaf) => unknown): void {
		if (this.views.has(type)) throw new Error(`view ${type} is registered twice`);
		this.views.set(type, create);
	}

	addRibbonIcon(): HTMLElement {
		return document.createElement("div");
	}

	addSettingTab(): void {}
	registerEvent(): void {}
	registerDomEvent(): void {}
	registerInterval(id: number): number {
		return id;
	}
	registerMarkdownCodeBlockProcessor(): void {}
	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}
	saveData(): Promise<void> {
		return Promise.resolve();
	}
}

/** Het icoon wordt niet getekend; de naam staat erop zodat een test hem kan lezen. */
export function setIcon(el: HTMLElement, name: string): void {
	el.setAttribute("data-icon", name);
}

/**
 * Een tab. Schermen navigeren met `leaf.setViewState`; de test leest hier
 * terug waar een klik naartoe wilde, zonder dat er een tweede scherm
 * getekend hoeft te worden.
 */
export class WorkspaceLeaf {
	/** Elke navigatie vanaf dit scherm: het type en de meegegeven staat. */
	opened: { type: string; state: Record<string, unknown> }[] = [];

	setViewState(view: { type: string; state?: Record<string, unknown> }): Promise<void> {
		this.opened.push({ type: view.type, state: view.state ?? {} });
		return Promise.resolve();
	}

	openFile(): Promise<void> {
		return Promise.resolve();
	}
}

/**
 * Het deel van `ItemView` dat de schermen gebruiken: een `contentEl` om te
 * vullen, de tab waar ze in zitten, en luisteraars die bij het sluiten weer
 * weg moeten. Leunt op de DOM uit `dom.ts`; zonder `installDom()` is er geen
 * `document` en mislukt de constructor — precies goed, want een kerntest hoort
 * nooit een scherm aan te maken.
 */
export class ItemView {
	app: unknown;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	contentEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		this.containerEl = document.createElement("div");
		this.contentEl = document.createElement("div");
		this.contentEl.className = "view-content";
		this.containerEl.appendChild(this.contentEl);
		document.body.appendChild(this.containerEl);
	}

	/** Obsidian bewaart hier de staat van de tab; de schermen roepen `super` aan. */
	setState(_state: unknown, _result: unknown): Promise<void> {
		return Promise.resolve();
	}

	getState(): Record<string, unknown> {
		return {};
	}

	registerDomEvent(el: HTMLElement, type: string, handler: (event: Event) => void): void {
		el.addEventListener(type, handler);
	}

	registerEvent(): void {}

	registerInterval(id: number): number {
		return id;
	}
}

/**
 * Een venster dat over het scherm komt. `open()` hangt het in de pagina en
 * roept `onOpen` aan, `close()` haalt het weg — genoeg om te testen wat erin
 * staat en wat een tik erop doet. De e2e vindt het op dezelfde selector.
 */
export class Modal {
	app: unknown;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;

	constructor(app: unknown) {
		this.app = app;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "modal-container";
		this.modalEl = document.createElement("div");
		this.modalEl.className = "modal";
		this.titleEl = document.createElement("div");
		this.titleEl.className = "modal-title";
		this.contentEl = document.createElement("div");
		this.contentEl.className = "modal-content";
		this.modalEl.append(this.titleEl, this.contentEl);
		this.containerEl.appendChild(this.modalEl);
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}

	close(): void {
		if (!this.containerEl.parentNode) return;
		this.containerEl.parentNode.removeChild(this.containerEl);
		this.onClose();
	}

	onOpen(): void {}

	onClose(): void {}
}

/**
 * Obsidians `debounce`, maar dan meteen: in een test wil je het resultaat van
 * een schrijfactie in dezelfde stap kunnen nakijken, niet anderhalve seconde
 * later. `cancel()` hoort erbij omdat de plugin hem bij `onunload` aanroept.
 */
export function debounce<T extends unknown[]>(
	fn: (...args: T) => unknown
): ((...args: T) => void) & { cancel: () => void } {
	const run = (...args: T): void => {
		fn(...args);
	};
	run.cancel = (): void => undefined;
	return run;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
}

export function parseYaml(value: string): unknown {
	return load(value) ?? {};
}

export function stringifyYaml(value: unknown): string {
	return dump(value);
}
