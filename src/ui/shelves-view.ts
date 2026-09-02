import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import type { Product } from "../products";
import type { Shop } from "../shops";
import { emptyState, segment } from "./kit";
import { enableRowDrag } from "./reorder";
import { drawBackLink } from "./nav";

export const SHELVES_VIEW_TYPE = "pantry-shelves";

type Mode = "sort" | "route";

/**
 * Sorting products onto shelves, one shelf at a time. Picking a shelf and
 * ticking what lies there beats answering the same question per product: you
 * think per aisle, so the work follows the way you already walk.
 */
export class ShelvesView extends ItemView {
	private plugin: PantryPlugin;
	private mode: Mode = "sort";
	private shop = "";
	private shelf = "";
	private showSorted = false;
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SHELVES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Shelves";
	}

	getIcon(): string {
		return "map";
	}

	async onOpen(): Promise<void> {
		await this.plugin.shops.build();
		this.draw();
	}

	refresh(): void {
		this.draw();
	}

	/**
	 * Wat er in een invoerveld staat, per veld.
	 *
	 * Een hertekening sloopt het veld waar je in typt, en die hertekening komt
	 * van je eigen vorige schrijfactie: je typt "Brood", Enter, begint aan
	 * "Melk", en tweehonderd milliseconden later is "Mel" weg en de focus ook.
	 * De tekst en de cursor worden daarom bewaard en teruggezet, in plaats van
	 * te proberen te voorspellen welke hertekening ongevaarlijk is.
	 */
	private drafts: Map<string, string> = new Map();
	private focused: string | null = null;

	private shopOrFirst(): Shop | null {
		const shops = this.plugin.shops.all();
		if (shops.length === 0) return null;
		return this.plugin.shops.find(this.shop) ?? shops[0] ?? null;
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-shelves");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const titles = inner.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Shelves" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		segment<Mode>(
			inner,
			[
				{ value: "sort", label: "Sort products" },
				{ value: "route", label: "Walking route" },
			],
			this.mode,
			(value) => {
				this.mode = value;
				this.draw();
			}
		);

		const shops = this.plugin.shops.all();
		if (shops.length > 0) {
			const active = this.shopOrFirst();
			segment(
				inner,
				shops.map((shop) => ({ value: shop.name, label: shop.name })),
				active?.name ?? "",
				(name) => {
					this.shop = name;
					this.shelf = "";
					this.draw();
				}
			);
		}

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawBody();
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const shop = this.shopOrFirst();
		if (!shop) {
			this.drawFirstShop(body);
			this.countEl?.setText("");
			return;
		}

		// `pantry: ignore` hoort nergens in een schaproute thuis: water heeft
		// geen schap en zou hier voor altijd als "nog niet ingedeeld" tellen.
		const all = this.plugin.products.all().filter((product) => !product.ignored);
		const sorted = all.filter((product) => product.shelf).length;
		this.countEl?.setText(`${sorted} of ${all.length} products sorted`);

		if (this.mode === "route") this.drawRoute(body, shop);
		else this.drawSort(body, shop);
	}

	/* ---------------------------------------------------------------- */

	private drawFirstShop(body: HTMLElement): void {
		emptyState(
			body,
			"No shops yet",
			"A shop is a note. It starts with the usual shelves in the usual order — rename, reorder or remove whatever does not match yours."
		);
		this.drawAdd(body, "shop", "Shop name", "Add shop", async (value) => {
			const file = await this.plugin.shops.createShop(value);
			if (!file) return;
			this.shop = file.basename;
			this.draw();
		});
	}

	private drawAdd(
		parent: HTMLElement,
		key: string,
		placeholder: string,
		label: string,
		apply: (value: string) => Promise<void>
	): void {
		const row = parent.createDiv({ cls: "pantry-add-row" });
		const input = row.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder },
		});
		const button = row.createEl("button", {
			cls: "pantry-button-primary",
			text: label,
		});

		input.value = this.drafts.get(key) ?? "";
		input.addEventListener("input", () => this.drafts.set(key, input.value));
		input.addEventListener("focus", () => {
			this.focused = key;
		});

		const commit = (): void => {
			const value = input.value.trim();
			if (value.length === 0) return;
			input.value = "";
			this.drafts.delete(key);
			guarded("could not save that", () => apply(value));
		};
		button.onclick = commit;
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") commit();
		});

		if (this.focused === key) {
			// Na de hertekening, want een veld dat nog niet in de DOM hangt kan
			// de focus niet aannemen.
			window.setTimeout(() => {
				input.focus();
				const end = input.value.length;
				input.setSelectionRange(end, end);
			}, 0);
		}
	}

	/* --- Walking route ------------------------------------------------ */

	private drawRoute(body: HTMLElement, shop: Shop): void {
		const section = body.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({ cls: "pantry-section-name", text: "In walking order" });
		heading.createSpan({
			cls: "pantry-section-count",
			text: `${shop.shelves.length}`,
		});

		const list = section.createDiv({ cls: "pantry-section-body pantry-route-list" });

		if (shop.shelves.length === 0) {
			list.createDiv({
				cls: "pantry-empty-hint",
				text: "Add the shelves in the order you pass them.",
			});
		}

		const renumber = (rows: HTMLElement[]): void => {
			rows.forEach((row, index) => {
				const badge = row.querySelector<HTMLElement>(".pantry-route-index");
				if (badge) badge.setText(`${index + 1}`);
			});
		};

		const spec = {
			list,
			rowSelector: ".pantry-route-row",
			onMove: renumber,
			commit: (rows: HTMLElement[]) => {
				const order = rows
					.map((row) => row.dataset.shelf ?? "")
					.filter((name) => name.length > 0);
				const same =
					order.length === shop.shelves.length &&
					order.every((name, index) => name === shop.shelves[index]);
				if (same) return;
				guarded(`could not save the route for ${shop.name}`, async () => {
					await this.plugin.shops.setShelves(shop, order);
					this.draw();
				});
			},
		};

		shop.shelves.forEach((shelf, index) => {
			const row = list.createDiv({ cls: "pantry-route-row" });
			row.dataset.shelf = shelf;

			const grip = row.createDiv({ cls: "pantry-route-grip" });
			setIcon(grip, "grip-vertical");
			grip.setAttr("aria-label", "Drag to reorder");
			enableRowDrag(grip, row, spec);

			row.createDiv({ cls: "pantry-route-index", text: `${index + 1}` });
			row.createDiv({ cls: "pantry-route-name", text: shelf });

			const count = this.plugin.products
				.all()
				.filter(
					(product) =>
						product.shelf.toLowerCase() === shelf.toLowerCase() &&
						this.sameShop(product, shop)
				).length;
			row.createDiv({ cls: "pantry-route-count", text: `${count}` });

			const remove = row.createEl("button", { cls: "pantry-icon-button" });
			setIcon(remove, "x");
			remove.setAttr("aria-label", "Remove this shelf");
			remove.onclick = () =>
				guarded(`could not remove ${shelf}`, () => this.removeShelf(shop, shelf));
		});

		this.drawAdd(section, `shelf:${shop.name}`, "Shelf name", "Add shelf", async (value) => {
			// Zie removeShelf: altijd vanaf de lijst zoals hij nu is.
			const current = this.plugin.shops.find(shop.name) ?? shop;
			await this.plugin.shops.setShelves(current, [...current.shelves, value]);
			this.draw();
		});

		if (shop.shelves.length > 0) {
			const wipe = section.createEl("button", {
				cls: "pantry-button-ghost",
				text: "Start over with an empty route",
			});
			wipe.onclick = () => {
				guarded(`could not clear the route for ${shop.name}`, async () => {
					await this.plugin.shops.setShelves(shop, []);
					this.draw();
				});
			};
		}

		const note = body.createDiv({ cls: "pantry-section" });
		const noteHead = note.createDiv({ cls: "pantry-section-head is-static" });
		noteHead.createSpan({ cls: "pantry-section-name", text: "Shops" });
		const noteBody = note.createDiv({ cls: "pantry-section-body" });
		const open = noteBody.createEl("button", {
			cls: "pantry-button-ghost",
			text: `Open ${shop.name} as a note`,
		});
		open.onclick = () => {
			const file = this.app.vault.getFileByPath(shop.path);
			if (file) {
				guarded(`could not open ${shop.name}`, () =>
					this.app.workspace.getLeaf(false).openFile(file)
				);
			}
		};
		this.drawAdd(noteBody, "shop", "Shop name", "Add shop", async (value) => {
			const file = await this.plugin.shops.createShop(value);
			if (!file) return;
			this.shop = file.basename;
			this.draw();
		});
	}

	private async removeShelf(shop: Shop, shelf: string): Promise<void> {
		// Het Shop-object van tekentijd is verouderd zodra er iets geschreven
		// is: setShelves roept build() aan en die maakt nieuwe objecten. Tik de
		// X bij twee schappen snel achter elkaar, en de tweede schrijfactie
		// vertrok vanaf de oude lijst en zette het eerste schap er weer in.
		const current = this.plugin.shops.find(shop.name) ?? shop;
		const still = this.plugin.products
			.all()
			.filter((product) => product.shelf.toLowerCase() === shelf.toLowerCase());
		await this.plugin.shops.setShelves(
			current,
			current.shelves.filter((item) => item !== shelf)
		);
		if (still.length > 0) {
			new Notice(
				`${still.length} product${still.length === 1 ? "" : "s"} still points at "${shelf}". Sort them onto another shelf.`
			);
		}
		this.draw();
	}

	/* --- Sorting ------------------------------------------------------- */

	private sameShop(product: Product, shop: Shop): boolean {
		return (
			product.shops.length === 0 ||
			product.shops.some(
				(name) => name.toLowerCase() === shop.name.toLowerCase()
			)
		);
	}

	private drawSort(body: HTMLElement, shop: Shop): void {
		if (shop.shelves.length === 0) {
			emptyState(
				body,
				"No shelves yet",
				"Add them under Walking route first, in the order you pass them."
			);
			return;
		}

		const current =
			shop.shelves.find(
				(shelf) => shelf.toLowerCase() === this.shelf.toLowerCase()
			) ??
			shop.shelves[0] ??
			"";

		const picker = body.createDiv({ cls: "pantry-shelf-picker" });
		shop.shelves.forEach((shelf) => {
			const chip = picker.createEl("button", {
				cls: "pantry-shelf-chip",
				text: shelf,
			});
			chip.toggleClass("is-active", shelf === current);
			chip.onclick = () => {
				this.shelf = shelf;
				this.drawBody();
			};
		});

		const onShelf = this.plugin.products
			.all()
			.filter(
				(product) =>
					product.shelf.toLowerCase() === current.toLowerCase() &&
					this.sameShop(product, shop)
			)
			.sort((a, b) => a.name.localeCompare(b.name));

		const pool = this.plugin.products
			.all()
			.filter(
				(product) => product.shelf.length === 0 && this.sameShop(product, shop)
			)
			.sort((a, b) => a.name.localeCompare(b.name));

		const section = body.createDiv({ cls: "pantry-section" });
		const heading = section.createDiv({ cls: "pantry-section-head is-static" });
		heading.createSpan({
			cls: "pantry-section-name",
			text: `What lies at ${current}?`,
		});
		heading.createSpan({ cls: "pantry-section-count", text: `${pool.length} left` });

		const list = section.createDiv({ cls: "pantry-section-body" });

		if (pool.length === 0) {
			list.createDiv({
				cls: "pantry-empty-hint",
				text: "Everything has a shelf. Switch on the toggle below to change one.",
			});
		}

		pool.forEach((product) =>
			this.drawPick(list, product, false, async () => {
				// Deze winkel erbij als hij er nog niet bij stond: je bent
				// hem hier aan het inrichten, dus hij hoort erbij te staan.
				const shops = product.shops.some(
					(name) => name.toLowerCase() === shop.name.toLowerCase()
				)
					? product.shops
					: [...product.shops, shop.name];
				await this.plugin.products.update(product, { shops, shelf: current });
				this.drawBody();
			})
		);

		const toggle = section.createEl("button", {
			cls: "pantry-button-ghost",
			text: this.showSorted
				? `Hide what is already at ${current} (${onShelf.length})`
				: `Show what is already at ${current} (${onShelf.length})`,
		});
		toggle.onclick = () => {
			this.showSorted = !this.showSorted;
			this.drawBody();
		};

		if (!this.showSorted || onShelf.length === 0) return;

		const done = body.createDiv({ cls: "pantry-section" });
		const doneHead = done.createDiv({ cls: "pantry-section-head is-static" });
		doneHead.createSpan({ cls: "pantry-section-name", text: `At ${current}` });
		doneHead.createSpan({ cls: "pantry-section-count", text: `${onShelf.length}` });
		const doneList = done.createDiv({ cls: "pantry-section-body" });
		onShelf.forEach((product) =>
			this.drawPick(doneList, product, true, async () => {
				await this.plugin.products.update(product, { shelf: "" });
				this.drawBody();
			})
		);
	}

	private drawPick(
		parent: HTMLElement,
		product: Product,
		ticked: boolean,
		apply: () => Promise<void>
	): void {
		const row = parent.createDiv({ cls: "pantry-buy-row" });
		row.toggleClass("is-done", ticked);

		const tick = row.createEl("button", { cls: "pantry-tick" });
		const glyph = tick.createSpan({ cls: "pantry-tick-glyph" });
		setIcon(glyph, "check");
		tick.setAttr("aria-pressed", ticked ? "true" : "false");
		tick.setAttr("aria-label", ticked ? "Take off this shelf" : "Put on this shelf");
		tick.onclick = () =>
			guarded(`could not move ${product.name}`, () => apply());

		const main = row.createDiv({ cls: "pantry-buy-main" });
		main.createDiv({ cls: "pantry-buy-name", text: product.name });
		if (product.storage) {
			main.createDiv({ cls: "pantry-buy-meta", text: product.storage });
		}
	}
}
