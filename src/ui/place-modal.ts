import { Modal } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { placeAt, shelfAt, type Product } from "../products";
import { chipPicker } from "./kit";

/**
 * Zeggen waar een product in één winkel ligt.
 *
 * Dit komt op vanuit de boodschappenlijst, bij een product dat in deze winkel
 * nog geen schap heeft: de standaardlijst van de Lidl die je deze keer bij de
 * AH haalt, of een schapnaam die alleen de andere winkel kent. Je staat in de
 * winkel of zit er thuis voor; het is één vraag en dus één tik. Het hele
 * productformulier erbij halen voor "bij de koekjes" is te veel.
 *
 * Schrijft meteen, zoals het productblad: er is niets half aan één schap.
 * De winkel komt níét bij de vaste winkels van het product te staan — zie
 * `Product.shelfOverrides` voor waarom.
 */
export class PlaceModal extends Modal {
	private plugin: PantryPlugin;
	private product: Product;
	private shop: string;
	private onDone: () => void;
	private typing = false;

	constructor(plugin: PantryPlugin, product: Product, shop: string, onDone: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.product = product;
		this.shop = shop;
		this.onDone = onDone;
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

		const elsewhere = this.product.shelf
			? `${this.product.shelf}${this.product.shops.length > 0 ? ` at ${this.product.shops.join(", ")}` : ""}`
			: "";
		const head = root.createDiv({ cls: "pantry-sheet-head" });
		head.createDiv({ cls: "pantry-sheet-name", text: this.product.name });
		head.createDiv({
			cls: "pantry-sheet-facts",
			text: elsewhere
				? `Usually at ${elsewhere}. Where is it at ${this.shop}?`
				: `Where is it at ${this.shop}?`,
		});

		const body = root.createDiv({ cls: "pantry-sheet-body" });
		const current = shelfAt(this.product, this.shop);
		const block = chipPicker(body, {
			label: `Shelf at ${this.shop}`,
			options: this.plugin.shops.shelves(this.shop),
			value: this.plugin.shops.hasShelf(this.shop, current) ? current : "",
			typing: this.typing,
			setTyping: (on) => {
				this.typing = on;
				this.render();
			},
			pick: (shelf) => this.pick(shelf),
		});

		// Weet je niet eens of ze het hier hebben: de zoekpagina van de winkel
		// staat in de winkelnotitie. Zonder adres daar verschijnt er niets.
		const target = this.plugin.shops.searchFor(this.shop, this.product.name);
		if (target) {
			const look = block.createEl("button", {
				cls: "pantry-sheet-option",
				text: `Search at ${this.shop}`,
			});
			look.onclick = () => window.open(target, "_blank");
		}
	}

	private pick(shelf: string): void {
		const wanted = shelf.trim();
		// Dezelfde chip nog eens aantikken geeft "" terug: dan is er niets te doen.
		if (wanted.length === 0) {
			this.close();
			return;
		}
		guarded(`could not put ${this.product.name} on a shelf`, async () => {
			// Een schap dat je zelf typt bestaat nog niet op de route. Zonder
			// het daar bij te zetten had het product nog steeds geen plek.
			const shop = this.plugin.shops.find(this.shop);
			if (shop && !this.plugin.shops.hasShelf(shop.name, wanted)) {
				await this.plugin.shops.setShelves(shop, [...shop.shelves, wanted]);
			}
			await this.plugin.products.update(
				this.product,
				placeAt(this.product, this.shop, wanted)
			);
			this.close();
			this.onDone();
		});
	}
}
