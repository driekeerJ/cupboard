import { Modal, Notice, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import type { NeedSource } from "../needs";
import {
	UNASSIGNED,
	missingFields,
	type Product,
	type ProductPatch,
} from "../products";

/**
 * Which question the sheet opens on: the shop's order, the house's, or
 * "everything this product still refuses to say".
 */
export type SheetFocus = "shop" | "storage" | "missing";

/**
 * A run through several products. Filling one gap is a chore; filling fifty is
 * a session, and a session needs a way forward that is not "close, scroll,
 * tap". The queue is a snapshot taken when the run starts, so the counter does
 * not shift under you as products drop out of the incomplete set.
 */
export interface SheetRun {
	queue: Product[];
	index: number;
	/** Products screen only: the note can be thrown away from here. */
	allowDelete?: boolean;
}

type BlockKey = "unit" | "size" | "minimum" | "shop" | "shelf" | "storage";

const LABELS: Record<BlockKey, string> = {
	unit: "Unit",
	size: "Package size",
	minimum: "Minimum",
	shop: "Shop",
	shelf: "Shelf",
	storage: "Place in the house",
};

/**
 * The quick edit you reach for with a trolley in one hand: tap a product's name
 * in any list and fix the one thing that is wrong about it. Which field comes
 * first depends on where you are standing — in the shop that is the shelf, at
 * home it is the place in the house, and on the products screen it is whatever
 * the product does not say yet.
 *
 * Every pick writes straight to the product note; there is no save button,
 * because a half-applied edit in a shop is worse than no edit at all.
 */
export class ProductSheet extends Modal {
	private plugin: PantryPlugin;
	private product: Product;
	private focus: SheetFocus;
	private onChange: () => void;
	private run: SheetRun | null;
	private more = false;
	/** The picker whose free-text field is open; only ever one at a time. */
	private typing: string | null = null;
	/**
	 * Frozen per product: filling a gap must never reorder the blocks under
	 * your thumb, however much the "what is missing" answer has changed.
	 */
	private order: BlockKey[] = [];

	constructor(
		plugin: PantryPlugin,
		product: Product,
		focus: SheetFocus,
		onChange: () => void = () => undefined,
		run: SheetRun | null = null
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.product = product;
		this.focus = focus;
		this.onChange = onChange;
		this.run = run;
		this.plan();
	}

	onOpen(): void {
		this.modalEl.addClass("pantry-sheet-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Decides, once per product, which blocks appear and in what order. */
	private plan(): void {
		if (this.focus === "shop") {
			this.order = ["shop", "shelf", "storage"];
			return;
		}
		if (this.focus === "storage") {
			this.order = ["storage", "shop", "shelf"];
			return;
		}
		const all: BlockKey[] = ["unit", "size", "shop", "shelf", "storage", "minimum"];
		const gaps = new Set<string>(missingFields(this.product));
		this.order = [
			...all.filter((key) => gaps.has(key)),
			...all.filter((key) => !gaps.has(key)),
		];
	}

	private async apply(patch: ProductPatch): Promise<void> {
		await this.plugin.products.update(this.product, patch);
		this.sync();
		this.typing = null;
		this.render();
		this.onChange();
	}

	/**
	 * Writes a value without redrawing: text and number fields lose the click
	 * you are halfway through if the sheet rebuilds itself on blur.
	 */
	private async applyQuietly(patch: ProductPatch): Promise<void> {
		await this.plugin.products.update(this.product, patch);
		this.sync();
		this.drawHead();
		this.onChange();
	}

	private sync(): void {
		const fresh = this.plugin.products.byPath(this.product.path);
		if (fresh) this.product = fresh;
	}

	/** Shelves of this product's shop first; other known shelves after. */
	private shelfOptions(): string[] {
		const shop = this.product.shop;
		const route = shop
			? this.plugin.shops.shelves(shop)
			: this.plugin.shops.all().flatMap((item) => item.shelves);
		const seen = new Set(route.map((shelf) => shelf.toLowerCase()));
		const rest = this.plugin.products
			.values("shelf")
			.filter((shelf) => !seen.has(shelf.toLowerCase()));
		return [...dedupe(route), ...rest];
	}

	private shopOptions(): string[] {
		return dedupe([...this.plugin.shops.names(), ...this.plugin.products.values("shop")]);
	}

	private storageOptions(): string[] {
		return this.plugin.products
			.values("storage")
			.filter((place) => place !== UNASSIGNED);
	}

	private headEl: HTMLElement | null = null;

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-sheet");

		this.headEl = root.createDiv({ cls: "pantry-sheet-head" });
		this.drawHead();

		const body = root.createDiv({ cls: "pantry-sheet-body" });
		this.drawNeeds(body);
		this.order.forEach((key) => this.drawBlock(body, key));

		const toggle = body.createEl("button", { cls: "pantry-sheet-more" });
		toggle.createSpan({ text: this.more ? "Fewer fields" : "More fields" });
		const caret = toggle.createSpan({ cls: "pantry-sheet-caret" });
		setIcon(caret, this.more ? "chevron-up" : "chevron-down");
		toggle.onclick = () => {
			this.more = !this.more;
			this.render();
		};

		if (this.more) this.drawMore(body);

		this.drawFoot(root);
	}

	/**
	 * Why this product is on the list at all. "4 spring onions" answers nothing
	 * on its own — four bunches or four stalks? — and the recipe line is the
	 * only place that ever said it. Read-only, above the fields, because in a
	 * shop this is the question you opened the sheet with.
	 *
	 * Lines the maths could not use are shown too, marked: an ingredient that
	 * counts for nothing is exactly the one that confuses you at the shelf.
	 */
	private drawNeeds(body: HTMLElement): void {
		const sources = this.plugin.needs.sources(this.product);
		if (sources.length === 0) return;

		const block = body.createDiv({ cls: "pantry-sheet-block pantry-sheet-needs" });
		block.createDiv({ cls: "pantry-sheet-label", text: "Needed for" });

		// One heading per recipe, even when it asks twice on separate lines.
		const order: string[] = [];
		const byRecipe = new Map<string, NeedSource[]>();
		sources.forEach((source) => {
			const seen = byRecipe.get(source.recipe);
			if (seen) seen.push(source);
			else {
				order.push(source.recipe);
				byRecipe.set(source.recipe, [source]);
			}
		});

		order.forEach((recipe) => {
			const card = block.createDiv({ cls: "pantry-need-card" });
			card.createDiv({ cls: "pantry-need-recipe", text: recipe });
			(byRecipe.get(recipe) ?? []).forEach((source) => {
				const row = card.createDiv({ cls: "pantry-need-line" });
				row.createSpan({ text: source.line });
				if (source.amount <= 0) {
					row.createSpan({
						cls: "pantry-need-uncounted",
						text: "not counted",
					});
				}
			});
		});
	}

	private drawHead(): void {
		const head = this.headEl;
		if (!head) return;
		head.empty();

		if (this.run && this.run.queue.length > 1) {
			head.createDiv({
				cls: "pantry-sheet-progress",
				text: `${this.run.index + 1} of ${this.run.queue.length}`,
			});
		}

		head.createDiv({ cls: "pantry-sheet-name", text: this.product.name });

		const gaps = missingFields(this.product);
		if (gaps.length > 0) {
			head.createDiv({
				cls: "pantry-sheet-gaps",
				text: `Missing: ${gaps.map((key) => LABELS[key].toLowerCase()).join(" · ")}`,
			});
		} else {
			head.createDiv({ cls: "pantry-sheet-facts", text: this.facts() });
		}
	}

	private facts(): string {
		const parts: string[] = [];
		if (this.product.shop) parts.push(this.product.shop);
		if (this.product.shelf) parts.push(this.product.shelf);
		if (this.product.storage && this.product.storage !== UNASSIGNED) {
			parts.push(this.product.storage);
		}
		return parts.length > 0 ? parts.join("  ·  ") : "nothing set yet";
	}

	private drawFoot(root: HTMLElement): void {
		const foot = root.createDiv({ cls: "pantry-sheet-foot" });

		if (this.run?.allowDelete) {
			const remove = foot.createEl("button", {
				cls: "pantry-text-button pantry-danger-button",
				text: "Delete",
			});
			remove.onclick = () =>
				guarded(`could not delete ${this.product.name}`, () => this.remove());
		}

		const open = foot.createEl("button", {
			cls: "pantry-text-button",
			text: "Open note",
		});
		open.onclick = () => {
			this.close();
			guarded(`could not open ${this.product.name}`, () =>
				this.app.workspace.getLeaf(false).openFile(this.product.file)
			);
		};

		const last = !this.run || this.run.index >= this.run.queue.length - 1;
		const next = foot.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: last ? "Done" : "Next",
		});
		next.onclick = () => {
			if (last) {
				this.close();
				return;
			}
			this.step();
		};
	}

	/** Moves the run one product on, keeping the sheet open. */
	private step(): void {
		if (!this.run) return;
		const index = this.run.index + 1;
		const queued = this.run.queue[index];
		// The snapshot can outlive its notes — a product deleted mid-run is
		// simply skipped rather than blowing up the session.
		const fresh = queued ? this.plugin.products.byPath(queued.path) : null;
		this.run = { ...this.run, index };
		if (!fresh) {
			if (index >= this.run.queue.length - 1) this.close();
			else this.step();
			return;
		}
		this.product = fresh;
		this.more = false;
		this.typing = null;
		this.plan();
		this.render();
	}

	private async remove(): Promise<void> {
		const name = this.product.name;
		await this.app.fileManager.trashFile(this.product.file);
		this.plugin.products.build();
		this.onChange();
		new Notice(`${name} moved to trash.`);
		const last = !this.run || this.run.index >= this.run.queue.length - 1;
		if (last) this.close();
		else this.step();
	}

	private drawBlock(parent: HTMLElement, key: BlockKey): void {
		if (key === "size") {
			this.drawSize(parent);
			return;
		}
		if (key === "minimum") {
			this.drawMinimum(parent);
			return;
		}

		const specs: Record<string, { value: string; options: string[]; field: keyof ProductPatch }> =
			{
				unit: {
					value: this.product.unit,
					options: this.plugin.products.values("unit"),
					field: "unit",
				},
				shop: { value: this.product.shop, options: this.shopOptions(), field: "shop" },
				shelf: { value: this.product.shelf, options: this.shelfOptions(), field: "shelf" },
				storage: {
					value: this.product.storage === UNASSIGNED ? "" : this.product.storage,
					options: this.storageOptions(),
					field: "storage",
				},
			};

		const spec = specs[key];
		this.drawPicker(parent, {
			key,
			label: LABELS[key],
			value: spec.value,
			options: spec.options,
			apply: (value: string): ProductPatch => ({ [spec.field]: value }) as ProductPatch,
		});
	}

	/**
	 * Chips, not a text box: in a shop you tap, you do not type. The free-text
	 * field is there for the one time the name you need does not exist yet.
	 */
	private drawPicker(
		parent: HTMLElement,
		spec: {
			key: string;
			label: string;
			value: string;
			options: string[];
			apply: (value: string) => ProductPatch;
		}
	): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.toggleClass("is-empty", spec.value.trim().length === 0);
		block.createDiv({ cls: "pantry-sheet-label", text: spec.label });

		const options = block.createDiv({ cls: "pantry-sheet-options" });
		const current = spec.value.trim().toLowerCase();

		spec.options.forEach((option) => {
			const chip = options.createEl("button", {
				cls: "pantry-sheet-option",
				text: option,
			});
			const active = option.trim().toLowerCase() === current;
			chip.toggleClass("is-active", active);
			chip.setAttr("aria-pressed", active ? "true" : "false");
			chip.onclick = () => {
				// Tapping the one that is already set clears it, so a wrong value
				// never needs a detour through the note.
				guarded(`could not update ${this.product.name}`, () =>
					this.apply(spec.apply(active ? "" : option))
				);
			};
		});

		if (this.typing === spec.key) {
			const input = block.createEl("input", {
				cls: "pantry-field-input pantry-sheet-input",
				attr: { type: "text", placeholder: `New ${spec.label.toLowerCase()}` },
			});
			input.value = spec.value;
			window.setTimeout(() => input.focus(), 0);
			const commit = (): void => {
				const value = input.value.trim();
				if (value.length === 0) {
					this.typing = null;
					this.render();
					return;
				}
				guarded(`could not update ${this.product.name}`, () =>
					this.apply(spec.apply(value))
				);
			};
			input.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter") commit();
				if (event.key === "Escape") {
					this.typing = null;
					this.render();
				}
			});
			input.addEventListener("blur", commit);
		} else {
			const add = options.createEl("button", {
				cls: "pantry-sheet-option is-add",
				text: spec.value ? "Other…" : "Type one…",
			});
			add.onclick = () => {
				this.typing = spec.key;
				this.render();
			};
		}
	}

	/**
	 * Package size is the one field you cannot tap your way to — 400 g, 1,5 l,
	 * 12 stuks are all different answers — so it stays a text box, with the
	 * unit spelled out in the placeholder rather than in a help text.
	 */
	private drawSize(parent: HTMLElement): void {
		const value = this.product.size
			? `${this.product.size.amount} ${this.product.size.unit}`.trim()
			: "";

		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.toggleClass("is-empty", value.length === 0 && this.product.amountMatters);
		block.createDiv({ cls: "pantry-sheet-label", text: LABELS.size });

		const row = block.createDiv({ cls: "pantry-sheet-row" });
		const input = row.createEl("input", {
			cls: "pantry-field-input pantry-sheet-input",
			attr: { type: "text", placeholder: "400 g, 1,5 l, 250 ml…" },
		});
		input.value = value;

		const commit = (): void => {
			const raw = input.value.trim();
			if (raw === value) return;
			guarded(`could not update ${this.product.name}`, () =>
				this.applyQuietly({ size: raw })
			);
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") input.blur();
		});

		// The way out for salt, oil and spices: things you keep in the house
		// rather than measure onto a list. Saying so here means the product
		// stops counting as incomplete instead of being nagged about forever.
		const skip = row.createEl("button", {
			cls: "pantry-sheet-option is-toggle",
			text: "Amount does not matter",
		});
		skip.toggleClass("is-active", !this.product.amountMatters);
		skip.setAttr("aria-pressed", this.product.amountMatters ? "false" : "true");
		skip.onclick = () => {
			guarded(`could not update ${this.product.name}`, () =>
				this.apply({ amount: this.product.amountMatters ? "any" : "" })
			);
		};
	}

	/** A stepper, because every real answer here is a single digit. */
	private drawMinimum(parent: HTMLElement): void {
		const block = parent.createDiv({ cls: "pantry-sheet-block" });
		block.createDiv({ cls: "pantry-sheet-label", text: LABELS.minimum });

		const row = block.createDiv({ cls: "pantry-sheet-stepper" });
		const down = row.createEl("button", { cls: "pantry-sheet-step", text: "−" });
		const shown = row.createSpan({ cls: "pantry-sheet-number" });
		const up = row.createEl("button", { cls: "pantry-sheet-step", text: "+" });
		const suffix = row.createSpan({
			cls: "pantry-sheet-suffix",
			text: this.product.unit ? `${this.product.unit} in the house` : "in the house",
		});
		suffix.toggleClass("is-quiet", true);

		const paint = (): void => {
			shown.setText(`${this.product.minimum}`);
			down.toggleClass("is-disabled", this.product.minimum <= 0);
		};
		paint();

		const set = (value: number): void => {
			const next = Math.max(0, Math.round(value));
			if (next === this.product.minimum) return;
			guarded(`could not update ${this.product.name}`, async () => {
				await this.applyQuietly({ minimum: next });
				paint();
			});
		};
		down.onclick = () => set(this.product.minimum - 1);
		up.onclick = () => set(this.product.minimum + 1);
	}

	/** The rest of the product, as plain fields — rarely needed in a shop. */
	private drawMore(parent: HTMLElement): void {
		const editor = parent.createDiv({ cls: "pantry-sheet-fields" });
		const shown = new Set(this.order);

		const field = (
			label: string,
			value: string,
			apply: (raw: string) => ProductPatch | null,
			suggestions: string[] = []
		): void => {
			const wrap = editor.createDiv({ cls: "pantry-field" });
			wrap.createDiv({ cls: "pantry-field-label", text: label });
			const input = wrap.createEl("input", {
				cls: "pantry-field-input",
				attr: { type: "text" },
			});
			input.value = value;

			if (suggestions.length > 0) {
				const id = `pantry-sheet-${label.toLowerCase().replace(/\W+/g, "-")}`;
				const datalist = wrap.createEl("datalist");
				datalist.id = id;
				suggestions.forEach((option) => {
					datalist.createEl("option").value = option;
				});
				input.setAttr("list", id);
			}

			const commit = (): void => {
				const patch = apply(input.value);
				if (!patch) {
					input.value = value;
					return;
				}
				guarded(`could not update ${this.product.name}`, () =>
					this.applyQuietly(patch)
				);
			};
			input.addEventListener("blur", commit);
			input.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter") input.blur();
			});
		};

		if (!shown.has("minimum")) {
			field("Minimum", `${this.product.minimum}`, (raw) => {
				const value = Number(raw.replace(",", "."));
				return Number.isFinite(value) && value >= 0 ? { minimum: value } : null;
			});
		}
		if (!shown.has("unit")) {
			field(
				"Unit",
				this.product.unit,
				(raw) => ({ unit: raw.trim() }),
				this.plugin.products.values("unit")
			);
		}
		if (!shown.has("size")) {
			field(
				"Package size",
				this.product.size
					? `${this.product.size.amount} ${this.product.size.unit}`.trim()
					: "",
				(raw) => ({ size: raw.trim() })
			);
		}

		field("Also known as", this.product.aliases.join(", "), (raw) => ({
			aliases: raw
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		}));
	}
}

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	values.forEach((value) => {
		const key = value.trim().toLowerCase();
		if (key.length === 0 || seen.has(key)) return;
		seen.add(key);
		kept.push(value.trim());
	});
	return kept;
}
