import { Modal, Notice } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { DEFAULT_EXTRA_AMOUNT, type Extra } from "../extras";
import { dedupe } from "../text";
import { chipPicker } from "./kit";

/** Wat het formulier vasthoudt tot je op Add drukt. */
interface Draft {
	name: string;
	amount: number;
	shop: string;
	shelf: string;
}

/**
 * Een losse boodschap toevoegen of bijwerken.
 *
 * Dit is het formulier voor alles wat je onderweg bedenkt en wat geen product
 * is: batterijen, bloemen, een tweede zak chips. Er komt geen productnotitie
 * van — zie src/extras.ts — dus er is ook niets te vragen over eenheid,
 * verpakking of minimum. Naam, hoeveel, winkel, schap. Meer niet.
 *
 * Winkel en schap zijn er niet voor de netheid: zonder die twee valt het
 * regeltje onderaan de lijst en loop je er in de winkel langs. Mét die twee
 * staat het gewoon tussen je andere boodschappen op de plek waar je toch al
 * loopt. Ze zijn wel overslaanbaar, want "ik bedenk even snel iets" mag geen
 * invulformulier worden.
 *
 * Net als het nieuw-product-formulier houdt dit een concept vast in plaats van
 * elke tik meteen weg te schrijven: er is nog niets om half toe te passen, en
 * wegklikken hoort dan ook niets achter te laten. Bij het bijwerken van een
 * bestaand regeltje geldt hetzelfde — Save schrijft, sluiten niet.
 */
export class ExtraModal extends Modal {
	private plugin: PantryPlugin;
	private draft: Draft;
	/** Het regeltje dat we bijwerken, of null als dit een nieuw regeltje is. */
	private editing: Extra | null;
	private onDone: () => void;
	/** De picker waarvan het vrije tekstveld open staat; altijd hooguit één. */
	private typing: string | null = null;
	/** Alleen de eerste keer springt de focus naar het naamveld. */
	private opened = false;
	private addButtons: HTMLButtonElement[] = [];

	constructor(
		plugin: PantryPlugin,
		extra: Extra | null,
		onDone: () => void = () => undefined
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.editing = extra;
		this.onDone = onDone;
		this.draft = extra
			? {
					name: extra.name,
					amount: extra.amount,
					shop: extra.shop,
					shelf: extra.shelf,
				}
			: { name: "", amount: DEFAULT_EXTRA_AMOUNT, shop: "", shelf: "" };
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
		head.createDiv({
			cls: "pantry-sheet-name",
			text: this.editing ? this.editing.name : "Loose item",
		});
		head.createDiv({
			cls: "pantry-sheet-facts",
			text: this.editing
				? "Only on this list — no product note, no stock."
				: "Something you thought of. It stays on the list until you tick it off.",
		});

		const body = root.createDiv({ cls: "pantry-sheet-body" });
		this.drawName(body);
		this.drawAmount(body);
		this.drawShop(body);
		this.drawShelf(body);

		this.drawFoot(root);
	}

	// ---------------------------------------------------------------- options

	private shopOptions(): string[] {
		return dedupe([
			...this.plugin.shops.names(),
			...this.plugin.products.values("shop"),
		]);
	}

	/** Schappen van de gekozen winkel eerst; andere bekende schappen erna. */
	private shelfOptions(): string[] {
		const shop = this.draft.shop.trim();
		const route = shop
			? this.plugin.shops.shelves(shop)
			: this.plugin.shops.all().flatMap((item) => item.shelves);
		const seen = new Set(route.map((shelf) => shelf.toLowerCase()));
		const rest = this.plugin.products
			.values("shelf")
			.filter((shelf) => !seen.has(shelf.toLowerCase()));
		return [...dedupe(route), ...rest];
	}

	// ------------------------------------------------------------------ velden

	private drawName(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.toggleClass("is-empty", this.draft.name.trim().length === 0);
		block.createDiv({ cls: "pantry-sheet-label", text: "What" });

		const input = block.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: {
				type: "text",
				placeholder: "Batteries, flowers, birthday card…",
				enterkeyhint: "done",
			},
		});
		input.value = this.draft.name;

		// Bij elke aanslag het concept in, niet pas bij blur: een tik op een
		// chip hertekent het formulier, en wat alleen in het invoerveld stond
		// zou dan weg zijn.
		input.addEventListener("input", () => {
			this.draft.name = input.value;
			this.lockButtons();
		});
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			input.blur();
			guarded("could not add the item", () => this.submit(false));
		});

		// Alleen de eerste keer, anders klapt op mobiel het toetsenbord open
		// zodra je een chip aantikt.
		if (!this.opened) {
			this.opened = true;
			window.setTimeout(() => input.focus(), 0);
		}
	}

	/** Een stepper, want elk echt antwoord hier is één cijfer. */
	private drawAmount(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.createDiv({ cls: "pantry-sheet-label", text: "How many" });

		const row = block.createDiv({ cls: "pantry-sheet-stepper" });
		const down = row.createEl("button", { cls: "pantry-sheet-step", text: "−" });
		const shown = row.createSpan({ cls: "pantry-sheet-number" });
		const up = row.createEl("button", { cls: "pantry-sheet-step", text: "+" });

		const paint = (): void => {
			shown.setText(`${this.draft.amount}`);
			down.toggleClass("is-disabled", this.draft.amount <= 1);
		};
		paint();

		down.onclick = () => {
			this.draft.amount = Math.max(1, this.draft.amount - 1);
			paint();
		};
		up.onclick = () => {
			this.draft.amount += 1;
			paint();
		};
	}

	/**
	 * Eén winkel, geen lijstje.
	 *
	 * Een product mag bij meerdere winkels liggen omdat de planner dan kan
	 * kiezen welke op tijd is. Een los regeltje heeft geen moment waarvoor het
	 * op tijd moet zijn — het is een ding dat je ergens meeneemt — dus twee
	 * winkels zou alleen betekenen dat je het twee keer ziet staan.
	 */
	private drawShop(parent: HTMLElement): void {
		chipPicker(parent, {
			label: "Shop",
			value: this.draft.shop,
			options: this.shopOptions(),
			typing: this.typing === "shop",
			setTyping: (open: boolean) => {
				this.typing = open ? "shop" : null;
				this.render();
			},
			pick: (picked: string) => {
				const value = picked.trim();
				const had = this.draft.shop;
				this.draft.shop = value;
				// Een andere winkel is een andere looproute, dus een schap dat
				// daar niet bestaat zegt niets meer.
				if (value.toLowerCase() !== had.toLowerCase()) this.draft.shelf = "";
				this.typing = null;
				this.render();
			},
		});
	}

	private drawShelf(parent: HTMLElement): void {
		chipPicker(parent, {
			label: "Shelf",
			value: this.draft.shelf,
			options: this.shelfOptions(),
			typing: this.typing === "shelf",
			setTyping: (open: boolean) => {
				this.typing = open ? "shelf" : null;
				this.render();
			},
			pick: (picked: string) => {
				this.draft.shelf = picked.trim();
				this.typing = null;
				this.render();
			},
		});
	}

	// ------------------------------------------------------------------- foot

	private drawFoot(root: HTMLElement): void {
		const foot = root.createDiv({ cls: "pantry-sheet-foot" });
		// Elke hertekening maakt nieuwe knoppen; zonder dit blijft de lijst
		// groeien en zetten we knoppen aan die allang uit de DOM zijn.
		this.addButtons = [];

		if (this.editing) {
			const remove = foot.createEl("button", {
				cls: "pantry-text-button pantry-danger-button",
				text: "Remove",
			});
			remove.onclick = () =>
				guarded("could not remove the item", () => this.remove());
		}

		const cancel = foot.createEl("button", {
			cls: "pantry-text-button",
			text: "Cancel",
		});
		cancel.onclick = () => this.close();

		// Wie er één bedenkt, bedenkt er meestal drie. Winkel en schap blijven
		// daarom staan; alleen de naam en het aantal worden leeggemaakt.
		if (!this.editing) {
			const again = foot.createEl("button", {
				cls: "pantry-text-button",
				text: "Add & new",
			});
			again.onclick = () =>
				guarded("could not add the item", () => this.submit(true));
			this.addButtons.push(again);
		}

		const save = foot.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: this.editing ? "Save" : "Add",
		});
		save.onclick = () =>
			guarded("could not add the item", () => this.submit(false));

		this.addButtons.push(save);
		this.lockButtons();
	}

	/** Zonder naam is er niets toe te voegen. */
	private lockButtons(): void {
		const blocked = this.draft.name.trim().length === 0;
		this.addButtons.forEach((button) => {
			button.disabled = blocked;
			button.toggleClass("is-disabled", blocked);
		});
	}

	private async remove(): Promise<void> {
		const extra = this.editing;
		if (!extra) return;
		await this.plugin.list.removeExtra(extra.id);
		this.onDone();
		this.close();
	}

	private async submit(again: boolean): Promise<void> {
		const name = this.draft.name.trim();
		if (name.length === 0) {
			new Notice("Give the item a name first.");
			return;
		}

		if (this.editing) {
			await this.plugin.list.updateExtra(this.editing.id, {
				name,
				amount: this.draft.amount,
				shop: this.draft.shop,
				shelf: this.draft.shelf,
			});
			this.onDone();
			this.close();
			return;
		}

		await this.plugin.list.addExtra({
			name,
			amount: this.draft.amount,
			shop: this.draft.shop,
			shelf: this.draft.shelf,
		});
		this.onDone();

		if (!again) {
			this.close();
			return;
		}

		this.draft = {
			name: "",
			amount: DEFAULT_EXTRA_AMOUNT,
			shop: this.draft.shop,
			shelf: this.draft.shelf,
		};
		this.typing = null;
		this.opened = false;
		this.addButtons = [];
		this.render();
	}
}
