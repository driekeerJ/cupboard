import { Modal, Notice, normalizePath } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { UNASSIGNED, safeProductName } from "../products";
import { dedupe } from "../text";
import { chipPicker } from "./kit";

/** The fields you fill in by tapping a chip. All of them plain strings. */
type PickerKey = "shop" | "shelf" | "storage" | "unit";

/** What the form holds until you press Add. */
interface Draft {
	name: string;
	shop: string;
	shelf: string;
	storage: string;
	unit: string;
	size: string;
	/** False once you have said the amount does not matter. */
	amountMatters: boolean;
	minimum: number;
	url: string;
	aliases: string;
}

/** Most things you keep in stock, you want one of. */
const DEFAULT_MINIMUM = 1;

function blank(): Draft {
	return {
		name: "",
		shop: "",
		shelf: "",
		storage: "",
		unit: "",
		size: "",
		amountMatters: true,
		minimum: DEFAULT_MINIMUM,
		url: "",
		aliases: "",
	};
}

/**
 * Adding a product, in one screen.
 *
 * The old way was a button that wrote a note called "New product" and told you
 * to go and rename it. Everything after that — unit, shop, shelf, place, the
 * lot — was a second job in a second place, and the name, the one thing only
 * you can supply, was the one thing the app would not ask for.
 *
 * Two things make this different from the product sheet, which edits a note
 * that already exists:
 *
 * **It holds a draft.** The sheet writes every tap straight to the note,
 * because a half-applied edit in a shop is worse than no edit. Here there is
 * no note yet, so there is nothing to half-apply; the whole form is written
 * once, when you press Add. Close it and nothing happened.
 *
 * **It asks the name first**, and says so at once when that name is taken.
 * `create()` hands back the existing note rather than overwriting it, so a
 * clash is never destructive — but silently editing a different product than
 * the one you thought you were making is its own kind of wrong.
 */
export class NewProductModal extends Modal {
	private plugin: PantryPlugin;
	private draft: Draft = blank();
	private onCreated: (path: string) => void;
	/** The picker whose free-text field is open; only ever one at a time. */
	private typing: string | null = null;
	private warnEl: HTMLElement | null = null;
	/**
	 * De knoppen die alleen mogen als er een bruikbare naam staat.
	 *
	 * Ze worden apart bijgehouden omdat de naam bij elke aanslag verandert
	 * zonder dat het formulier hertekent \u2014 dat zou de cursor kosten. Zonder
	 * deze verwijzingen bleef Add uit staan tot je toevallig een chip aantikte.
	 */
	private lockable: HTMLButtonElement[] = [];
	/** Alleen de eerste keer springt de focus naar het naamveld. */
	private opened = false;

	constructor(plugin: PantryPlugin, onCreated: (path: string) => void = () => undefined) {
		super(plugin.app);
		this.plugin = plugin;
		this.onCreated = onCreated;
	}

	onOpen(): void {
		this.modalEl.addClass("pantry-sheet-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-sheet");

		const head = root.createDiv({ cls: "pantry-sheet-head" });
		head.createDiv({ cls: "pantry-sheet-name", text: "New product" });
		head.createDiv({
			cls: "pantry-sheet-facts",
			text: "Nothing is written until you press Add.",
		});

		const body = root.createDiv({ cls: "pantry-sheet-body" });
		this.drawName(body);
		this.drawPicker(body, "shop", "Shop", this.draft.shop, this.shopOptions());
		this.drawPicker(body, "shelf", "Shelf", this.draft.shelf, this.shelfOptions());
		this.drawPicker(
			body,
			"storage",
			"Place in the house",
			this.draft.storage,
			this.storageOptions()
		);
		this.drawPicker(body, "unit", "Unit", this.draft.unit, this.plugin.products.values("unit"));
		this.drawSize(body);
		this.drawMinimum(body);
		this.drawLink(body);
		this.drawAliases(body);

		this.drawFoot(root);
	}

	// ---------------------------------------------------------------- options

	private shopOptions(): string[] {
		return dedupe([...this.plugin.shops.names(), ...this.plugin.products.values("shop")]);
	}

	/** Shelves of the chosen shop first; other known shelves after. */
	private shelfOptions(): string[] {
		const shop = this.draft.shop;
		const route = shop
			? this.plugin.shops.shelves(shop)
			: this.plugin.shops.all().flatMap((item) => item.shelves);
		const seen = new Set(route.map((shelf) => shelf.toLowerCase()));
		const rest = this.plugin.products
			.values("shelf")
			.filter((shelf) => !seen.has(shelf.toLowerCase()));
		return [...dedupe(route), ...rest];
	}

	private storageOptions(): string[] {
		return this.plugin.products.values("storage").filter((place) => place !== UNASSIGNED);
	}

	// ------------------------------------------------------------------ name

	private drawName(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.toggleClass("is-empty", this.draft.name.trim().length === 0);
		block.createDiv({ cls: "pantry-sheet-label", text: "Name" });

		const input = block.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: {
				type: "text",
				placeholder: "Chopped tomatoes",
				enterkeyhint: "done",
			},
		});
		input.value = this.draft.name;

		this.warnEl = block.createDiv({ cls: "pantry-sheet-warn" });
		this.drawWarning();

		// De naam gaat bij elke aanslag het concept in, niet pas bij blur: een
		// tik op een chip hertekent het formulier, en wat alleen in het
		// invoerveld stond zou dan weg zijn. De waarschuwing wordt los
		// bijgewerkt, want hertekenen zou de cursor onder je vandaan trekken.
		input.addEventListener("input", () => {
			this.draft.name = input.value;
			this.drawWarning();
			this.lockButtons();
		});

		// Alleen de eerste keer. Zou de focus hierheen springen bij elke
		// hertekening, dan klapte op mobiel het toetsenbord open zodra je een
		// chip aantikte.
		if (!this.opened) {
			this.opened = true;
			window.setTimeout(() => input.focus(), 0);
		}
	}

	/**
	 * A name that is taken, said out loud before you fill in the rest.
	 *
	 * Two different clashes. The note itself existing is a hard stop: pressing
	 * Add would hand you that note, not a new one. Matching an existing
	 * product's name or alias is a soft one — "Tomatenblokjes" is a legitimate
	 * second product even when something else answers to it — so it warns and
	 * lets you through.
	 */
	private drawWarning(): void {
		const warn = this.warnEl;
		if (!warn) return;
		warn.empty();

		const clash = this.clash();
		if (!clash) {
			warn.toggleClass("is-hard", false);
			return;
		}

		warn.toggleClass("is-hard", clash.kind === "exact");
		warn.setText(
			clash.kind === "exact"
				? `A product note called "${clash.name}" already exists.`
				: `"${clash.name}" already answers to this name.`
		);
	}

	private clash(): { kind: "exact" | "alias"; name: string } | null {
		const name = safeProductName(this.draft.name);
		if (name.length === 0) return null;

		const path = normalizePath(`${this.plugin.products.folder()}/${name}.md`);
		if (this.app.vault.getFileByPath(path)) return { kind: "exact", name };

		const match = this.plugin.products.match(name);
		return match ? { kind: "alias", name: match.name } : null;
	}

	// --------------------------------------------------------------- pickers

	private drawPicker(
		parent: HTMLElement,
		key: PickerKey,
		label: string,
		value: string,
		options: string[]
	): void {
		chipPicker(parent, {
			label,
			value,
			options,
			typing: this.typing === key,
			setTyping: (open: boolean) => {
				this.typing = open ? key : null;
				this.render();
			},
			pick: (picked: string) => {
				// De keuze van winkel bepaalt welke schappen er zijn, dus het
				// hele formulier wordt hertekend; het concept houdt de rest vast.
				if (key === "shop" && picked !== this.draft.shop) this.draft.shelf = "";
				this.draft[key] = picked;
				this.typing = null;
				this.render();
			},
		});
	}

	// ------------------------------------------------------------------ size

	private drawSize(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.toggleClass("is-empty", this.draft.size.length === 0 && this.draft.amountMatters);
		block.createDiv({ cls: "pantry-sheet-label", text: "Package size" });

		const row = block.createDiv({ cls: "pantry-sheet-row" });
		const input = row.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: "400 g, 1,5 l, 250 ml…" },
		});
		input.value = this.draft.size;
		input.addEventListener("input", () => {
			this.draft.size = input.value;
		});

		// The way out for salt, oil and spices: things you keep in the house
		// rather than measure onto a list.
		const skip = row.createEl("button", {
			cls: "pantry-sheet-option is-toggle",
			text: "Amount does not matter",
		});
		skip.toggleClass("is-active", !this.draft.amountMatters);
		skip.setAttr("aria-pressed", this.draft.amountMatters ? "false" : "true");
		skip.onclick = () => {
			this.draft.amountMatters = !this.draft.amountMatters;
			this.render();
		};
	}

	// --------------------------------------------------------------- minimum

	private drawMinimum(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.createDiv({ cls: "pantry-sheet-label", text: "Minimum" });

		const row = block.createDiv({ cls: "pantry-sheet-stepper" });
		const down = row.createEl("button", { cls: "pantry-sheet-step", text: "−" });
		const shown = row.createSpan({ cls: "pantry-sheet-number" });
		const up = row.createEl("button", { cls: "pantry-sheet-step", text: "+" });
		const suffix = row.createSpan({
			cls: "pantry-sheet-suffix is-quiet",
			text: this.draft.unit ? `${this.draft.unit} in the house` : "in the house",
		});
		suffix.toggleClass("is-quiet", true);

		// Niets asynchroons hier: het concept staat in het geheugen, dus een
		// stepper die vooruitloopt op een schrijfactie is niet nodig.
		const paint = (): void => {
			shown.setText(`${this.draft.minimum}`);
			down.toggleClass("is-disabled", this.draft.minimum <= 0);
			down.disabled = this.draft.minimum <= 0;
		};
		paint();

		down.onclick = () => {
			this.draft.minimum = Math.max(0, this.draft.minimum - 1);
			paint();
		};
		up.onclick = () => {
			this.draft.minimum += 1;
			paint();
		};
	}

	// ------------------------------------------------------------------ link

	/**
	 * The link to this product at the shop, and a way to go and find it.
	 *
	 * Pasting beats searching from inside the plugin. A supermarket's search
	 * results are a moving target — scraping one is a button that works until
	 * the shop redesigns its site — while a link the user pasted is a link
	 * forever. The button here only opens the shop's own search page, and
	 * which page that is comes out of the shop note, so this works the same
	 * for a supermarket the author of this plugin has never heard of.
	 */
	private drawLink(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.createDiv({ cls: "pantry-sheet-label", text: "Link" });

		const row = block.createDiv({ cls: "pantry-sheet-row" });
		const input = row.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: "https://…", inputmode: "url" },
		});
		input.value = this.draft.url;
		input.addEventListener("input", () => {
			this.draft.url = input.value;
		});

		const target = this.plugin.shops.searchFor(this.draft.shop, this.draft.name);
		if (target) {
			const look = row.createEl("button", {
				cls: "pantry-sheet-option",
				text: `Search at ${this.draft.shop}`,
			});
			look.onclick = () => window.open(target, "_blank");
			return;
		}

		if (this.draft.shop && !this.plugin.shops.searchFor(this.draft.shop, "x")) {
			block.createDiv({
				cls: "pantry-sheet-hint",
				text: `Put a search address in ${this.draft.shop}'s note to look products up from here.`,
			});
		}
	}

	// --------------------------------------------------------------- aliases

	private drawAliases(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.createDiv({ cls: "pantry-sheet-label", text: "Also known as" });

		const input = block.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: "tomatenblokjes, passata" },
		});
		input.value = this.draft.aliases;
		input.addEventListener("input", () => {
			this.draft.aliases = input.value;
		});
	}

	// ------------------------------------------------------------------ foot

	private drawFoot(root: HTMLElement): void {
		const foot = root.createDiv({ cls: "pantry-sheet-foot" });

		const cancel = foot.createEl("button", {
			cls: "pantry-text-button",
			text: "Cancel",
		});
		cancel.onclick = () => this.close();

		// Producten komen zelden alleen: wie er één uit een winkel toevoegt,
		// voegt er meestal drie toe. Winkel, schap, plek en eenheid blijven
		// daarom staan; alleen wat per product verschilt wordt leeggemaakt.
		const again = foot.createEl("button", {
			cls: "pantry-text-button",
			text: "Save & new",
		});
		again.onclick = () =>
			guarded("could not create the product", () => this.submit(true));

		const add = foot.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: "Add",
		});
		add.onclick = () => guarded("could not create the product", () => this.submit(false));

		this.lockable = [again, add];
		this.lockButtons();
	}

	/** Add blijft uit zolang de naam ontbreekt of al bezet is. */
	private lockButtons(): void {
		const blocked =
			safeProductName(this.draft.name).length === 0 || this.clash()?.kind === "exact";
		this.lockable.forEach((button) => {
			button.disabled = blocked;
			button.toggleClass("is-disabled", blocked);
		});
	}

	private async submit(again: boolean): Promise<void> {
		const name = safeProductName(this.draft.name);
		if (name.length === 0) {
			new Notice("Give the product a name first.");
			return;
		}
		if (this.clash()?.kind === "exact") {
			new Notice(`A product called "${name}" already exists.`);
			return;
		}

		const file = await this.plugin.products.create(name, {
			minimum: this.draft.minimum,
			unit: this.draft.unit,
			size: this.draft.size.trim(),
			amount: this.draft.amountMatters ? "" : "any",
			shop: this.draft.shop,
			storage: this.draft.storage,
			shelf: this.draft.shelf,
			aliases: this.draft.aliases
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
			url: this.draft.url.trim(),
		});

		if (!file) {
			new Notice(`Pantry could not create ${name}.`);
			return;
		}

		new Notice(`${name} added.`);
		this.onCreated(file.path);

		if (!again) {
			this.close();
			return;
		}

		const kept = this.draft;
		this.draft = {
			...blank(),
			shop: kept.shop,
			shelf: kept.shelf,
			storage: kept.storage,
			unit: kept.unit,
		};
		this.typing = null;
		this.render();
	}
}
