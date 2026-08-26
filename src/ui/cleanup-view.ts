import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import {
	commonUnit,
	type ProductIssue,
	type RecipeLine,
	type UnknownIngredient,
} from "../cleanup";
import type { Product } from "../products";
import { drawBackLink } from "./nav";

export const CLEANUP_VIEW_TYPE = "pantry-cleanup";

type Mode = "todo" | "zero";

/** Package names to start from, the way the walking route starts from shelves. */
const PACKAGES = ["pack", "tin", "jar", "bottle", "bag", "box", "bunch"];

type Card =
	| { kind: "unknown"; entry: UnknownIngredient }
	| { kind: "product"; issue: ProductIssue };

/**
 * The screen that makes the numbers true.
 *
 * A recipe asking for 800 g of chickpeas can only become "buy 2" once the
 * product says a tin holds 400 g. That is one question per product, asked once,
 * so this is a queue and not a table: one card at a time, the recipe lines that
 * need it in plain sight, three answers, next.
 */
export class CleanupView extends ItemView {
	private plugin: PantryPlugin;
	private mode: Mode = "todo";
	/** Pushed to the back of the queue for this session only. */
	private skipped: Set<string> = new Set();
	/** Which product is showing the package form. */
	private expanded = "";
	/** Which unknown ingredient is showing the product picker. */
	private picking = "";
	private query = "";
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CLEANUP_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Cleanup";
	}

	getIcon(): string {
		return "wand-2";
	}

	async onOpen(): Promise<void> {
		this.draw();
		await this.reload();
	}

	refresh(): void {
		guarded("could not refresh the cleanup list", () => this.reload());
	}

	/**
	 * Herbouwt de opruimlijst uit de productindex zoals hij nu is.
	 *
	 * Hier stond `products.build()`, en dat leest élke productnotitie opnieuw
	 * uit de metadata-cache — precies wat het commentaar bij `ProductIndex.apply`
	 * verbiedt. Direct na een antwoord is die cache nog niet bij, dus de patch
	 * werd weggegooid en de kaart die je net beantwoordde stond er meteen weer.
	 * Herbouwen van de index hoort bij het ene invalidatiepad in `main.ts`, dat
	 * pas draait als de cache wél bij is.
	 */
	private async reload(): Promise<void> {
		await this.plugin.cleanup.rebuild();
		this.drawBody();
	}

	/* ------------------------------------------------------------------ */

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-app", "pantry-cleanup");

		const head = root.createDiv({ cls: "pantry-head" });
		const inner = head.createDiv({ cls: "pantry-head-inner" });
		drawBackLink(inner, this);

		const titles = inner.createDiv({ cls: "pantry-head-titles" });
		titles.createEl("h1", { cls: "pantry-head-title", text: "Cleanup" });
		this.countEl = titles.createDiv({ cls: "pantry-head-sub" });

		const modes = inner.createDiv({ cls: "pantry-segment" });
		([
			["todo", "To sort out"],
			["zero", "Still not counting"],
		] as Array<[Mode, string]>).forEach(([value, label]) => {
			const chip = modes.createEl("button", {
				cls: "pantry-segment-item",
				text: label,
			});
			chip.toggleClass("is-active", this.mode === value);
			chip.onclick = () => {
				this.mode = value;
				this.draw();
				this.drawBody();
			};
		});

		this.bodyEl = root.createDiv({ cls: "pantry-body" });
		this.drawBody();
	}

	/** Unknown names first: until they point at a product, nothing else can. */
	private queue(): Card[] {
		const unknown: Card[] = this.plugin.cleanup
			.missing()
			.map((entry) => ({ kind: "unknown", entry }) as Card);
		const products: Card[] = this.plugin.cleanup
			.open()
			.map((issue) => ({ kind: "product", issue }) as Card);

		const cards = [...unknown, ...products];
		const key = (card: Card): string =>
			card.kind === "unknown" ? `?${card.entry.key}` : card.issue.product.path;

		// Skipped cards are not gone, only later.
		return [
			...cards.filter((card) => !this.skipped.has(key(card))),
			...cards.filter((card) => this.skipped.has(key(card))),
		];
	}

	private drawBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const all = this.plugin.cleanup.all();
		const ready = all.filter((issue) => issue.zero.length === 0).length;
		this.countEl?.setText(
			all.length === 0
				? "No recipes to read yet"
				: `${ready} of ${all.length} products in your recipes are ready`
		);

		if (this.mode === "zero") {
			this.drawStubborn(body);
			return;
		}

		const queue = this.queue();
		if (queue.length === 0) {
			this.drawDone(body);
			return;
		}

		const progress = body.createDiv({ cls: "pantry-queue-progress" });
		progress.createDiv({
			cls: "pantry-queue-count",
			text: `${queue.length} left`,
		});
		const bar = progress.createDiv({ cls: "pantry-progress" });
		const done = Math.max(0, all.length - queue.length);
		const fraction = all.length === 0 ? 0 : done / all.length;
		bar.createDiv({ cls: "pantry-progress-bar" }).style.width = `${Math.round(
			fraction * 100
		)}%`;

		const card = queue[0];
		if (card.kind === "unknown") this.drawUnknown(body, card.entry);
		else this.drawProduct(body, card.issue);

		if (queue.length > 1) {
			const next = body.createDiv({ cls: "pantry-queue-next" });
			next.setText(
				`Next: ${
					queue[1].kind === "unknown"
						? queue[1].entry.name
						: queue[1].issue.product.name
				}`
			);
		}
	}

	/* --- one product -------------------------------------------------- */

	private drawProduct(body: HTMLElement, issue: ProductIssue): void {
		const product = issue.product;
		const card = body.createDiv({ cls: "pantry-card" });

		card.createDiv({ cls: "pantry-card-kicker", text: "How do you buy this?" });
		card.createEl("h2", { cls: "pantry-card-title", text: product.name });

		this.drawLines(card, issue.zero);

		const choices = card.createDiv({ cls: "pantry-choices" });

		this.choice(
			choices,
			"Per piece",
			"You count them one by one — three onions, one lemon.",
			() =>
				guarded(`could not save your answer for ${product.name}`, () =>
					this.answer(product, { unit: "piece", size: "", amount: "" })
				)
		);

		const pack = this.choice(
			choices,
			"Per package",
			"A tin, a pack, a bottle — with a fixed amount inside.",
			() => {
				this.expanded = this.expanded === product.path ? "" : product.path;
				this.drawBody();
			}
		);
		pack.toggleClass("is-open", this.expanded === product.path);

		this.choice(
			choices,
			"Amount does not matter",
			"Salt, oil, spices: you keep them in the house, you do not measure them onto a list.",
			() =>
				guarded(`could not save your answer for ${product.name}`, () =>
					this.answer(product, { amount: "any" })
				)
		);

		if (this.expanded === product.path) {
			this.drawPackageForm(card, issue);
		}

		this.drawFooter(card, product.path, product);
	}

	/** Package name plus what is inside it: the two numbers that fix the maths. */
	private drawPackageForm(card: HTMLElement, issue: ProductIssue): void {
		const product = issue.product;
		const form = card.createDiv({ cls: "pantry-form" });

		form.createDiv({ cls: "pantry-form-label", text: "What do you call one?" });
		const nameRow = form.createDiv({ cls: "pantry-form-row" });
		const name = nameRow.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "pack, tin, bottle" },
		});
		name.value = product.unit;

		const known = this.plugin.products.values("unit");
		const chips = form.createDiv({ cls: "pantry-segment is-wrap" });
		[...new Set([...known, ...PACKAGES])].forEach((option) => {
			const chip = chips.createEl("button", {
				cls: "pantry-segment-item",
				text: option,
			});
			chip.onclick = () => {
				name.value = option;
				chips.findAll(".pantry-segment-item").forEach((item) =>
					item.removeClass("is-active")
				);
				chip.addClass("is-active");
				amount.focus();
			};
			chip.toggleClass("is-active", option === product.unit);
		});

		form.createDiv({ cls: "pantry-form-label", text: "How much is in one?" });
		const sizeRow = form.createDiv({ cls: "pantry-form-row" });
		// `type="text"`, want een `type="number"`-veld geeft voor "1,5" een lege
		// string terug — de komma wordt weggegooid vóórdat de code hem kan
		// omzetten. Het product gold daarna als beantwoord en verdween naar
		// "Answered, still ignored" met alleen zijn eenheid.
		const amount = sizeRow.createEl("input", {
			cls: "pantry-field-number",
			attr: { type: "text", inputmode: "decimal", placeholder: "400" },
		});
		if (product.size) amount.value = `${product.size.amount}`;
		const unit = sizeRow.createEl("input", {
			cls: "pantry-field-unit",
			attr: { type: "text", placeholder: "g" },
		});
		unit.value = product.size?.unit ?? commonUnit(issue.zero);

		const hint = commonUnit(issue.zero);
		if (hint) {
			form.createDiv({
				cls: "pantry-form-hint",
				text: `Your recipes measure this in ${hint}, so give the contents in ${hint} too.`,
			});
		}

		const save = form.createEl("button", {
			cls: "pantry-button-primary",
			text: "Save",
		});
		const commit = (): void => {
			const value = Number(amount.value.trim().replace(",", "."));
			const measure = unit.value.trim();
			const filled = amount.value.trim().length > 0 || measure.length > 0;
			const valid = Number.isFinite(value) && value > 0 && measure.length > 0;

			// Half ingevuld is geen antwoord: wegschrijven zou het product als
			// beantwoord markeren terwijl het nog steeds niet te converteren is.
			if (filled && !valid) {
				new Notice("Give the contents as a number and a unit, like 400 g.");
				amount.focus();
				return;
			}

			const size = valid ? `${value} ${measure}` : "";
			guarded(`could not save your answer for ${product.name}`, () =>
				this.answer(product, {
					unit: name.value.trim() || "pack",
					size,
					amount: "",
				})
			);
		};
		save.onclick = commit;
		[name, amount, unit].forEach((field) =>
			field.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter") commit();
			})
		);
	}

	/* --- one unknown ingredient --------------------------------------- */

	private drawUnknown(body: HTMLElement, entry: UnknownIngredient): void {
		const card = body.createDiv({ cls: "pantry-card" });
		card.createDiv({
			cls: "pantry-card-kicker",
			text: "No product for this ingredient",
		});
		card.createEl("h2", { cls: "pantry-card-title", text: entry.name });

		this.drawLines(card, entry.lines);

		const choices = card.createDiv({ cls: "pantry-choices" });

		this.choice(
			choices,
			"Make it a product",
			`Creates "${entry.name}" in your product folder.`,
			() =>
				guarded(`could not create ${entry.name}`, () => this.create(entry))
		);

		const link = this.choice(
			choices,
			"It is one I already have",
			"Point it at an existing product; the name is remembered as an alias.",
			() => {
				this.picking = this.picking === entry.key ? "" : entry.key;
				this.query = "";
				this.drawBody();
			}
		);
		link.toggleClass("is-open", this.picking === entry.key);

		if (this.picking === entry.key) this.drawPicker(card, entry);

		this.drawFooter(card, `?${entry.key}`, null);
	}

	private drawPicker(card: HTMLElement, entry: UnknownIngredient): void {
		const form = card.createDiv({ cls: "pantry-form" });
		const search = form.createEl("input", {
			cls: "pantry-field-search",
			attr: { type: "text", placeholder: "Search your products" },
		});
		search.value = this.query;

		const results = form.createDiv({ cls: "pantry-picker" });
		const fill = (): void => {
			results.empty();
			const query = search.value.trim().toLowerCase();
			this.plugin.products
				.all()
				.filter((product) => product.name.toLowerCase().includes(query))
				.slice(0, 8)
				.forEach((product) => {
					const row = results.createEl("button", {
						cls: "pantry-picker-row",
						text: product.name,
					});
					row.onclick = () =>
						guarded(`could not link ${entry.name} to ${product.name}`, () =>
							this.link(entry, product)
						);
				});
		};
		search.addEventListener("input", () => {
			this.query = search.value;
			fill();
		});
		fill();
		window.setTimeout(() => search.focus(), 0);
	}

	/* --- shared card pieces ------------------------------------------- */

	private drawLines(card: HTMLElement, lines: RecipeLine[]): void {
		if (lines.length === 0) return;
		const list = card.createDiv({ cls: "pantry-card-lines" });
		lines.slice(0, 6).forEach((line) => {
			const row = list.createDiv({ cls: "pantry-card-line" });
			row.createSpan({ cls: "pantry-card-line-text", text: line.text });
			row.createSpan({ cls: "pantry-card-line-recipe", text: line.recipe });
		});
		if (lines.length > 6) {
			list.createDiv({
				cls: "pantry-card-line-more",
				text: `and ${lines.length - 6} more`,
			});
		}
	}

	private choice(
		parent: HTMLElement,
		title: string,
		hint: string,
		onClick: () => void
	): HTMLElement {
		const button = parent.createEl("button", { cls: "pantry-choice" });
		button.createDiv({ cls: "pantry-choice-title", text: title });
		button.createDiv({ cls: "pantry-choice-hint", text: hint });
		button.onclick = onClick;
		return button;
	}

	private drawFooter(
		card: HTMLElement,
		key: string,
		product: Product | null
	): void {
		const footer = card.createDiv({ cls: "pantry-card-footer" });

		const skip = footer.createEl("button", {
			cls: "pantry-button-ghost",
			text: "Skip for now",
		});
		skip.onclick = () => {
			this.skipped.add(key);
			this.expanded = "";
			this.picking = "";
			this.drawBody();
		};

		if (!product) return;
		const open = footer.createEl("button", { cls: "pantry-button-ghost" });
		setIcon(open.createSpan({ cls: "pantry-button-icon" }), "file-text");
		open.createSpan({ text: "Open note" });
		open.onclick = () => {
			guarded(`could not open ${product.name}`, () =>
				this.app.workspace.getLeaf(false).openFile(product.file)
			);
		};
	}

	/* --- the list that answers nothing yet ---------------------------- */

	private drawStubborn(body: HTMLElement): void {
		const issues = this.plugin.cleanup.stubborn();
		if (issues.length === 0) {
			const wrap = body.createDiv({ cls: "pantry-empty" });
			wrap.createDiv({
				cls: "pantry-empty-title",
				text: "Every line counts",
			});
			wrap.createDiv({
				cls: "pantry-empty-hint",
				text: "Nothing you have set up is being ignored.",
			});
			return;
		}

		const section = body.createDiv({ cls: "pantry-section" });
		const head = section.createDiv({ cls: "pantry-section-head is-static" });
		head.createSpan({ cls: "pantry-section-name", text: "Answered, still ignored" });
		head.createSpan({ cls: "pantry-section-count", text: `${issues.length}` });

		const intro = section.createDiv({ cls: "pantry-empty-hint" });
		intro.setText(
			"These products know how they are bought, but these lines still cannot be converted into that unit. Usually the contents are missing, or the recipe measures in something else entirely."
		);

		const list = section.createDiv({ cls: "pantry-section-body" });
		issues.forEach((issue) => {
			const row = list.createDiv({ cls: "pantry-stubborn" });
			const head = row.createDiv({ cls: "pantry-stubborn-head" });
			head.createSpan({ cls: "pantry-stubborn-name", text: issue.product.name });
			head.createSpan({
				cls: "pantry-stubborn-unit",
				text: issue.product.size
					? `${issue.product.unit || "package"} of ${issue.product.size.amount} ${issue.product.size.unit}`
					: issue.product.amountMatters
						? issue.product.unit || "no unit"
						: "amount does not matter",
			});
			this.drawLines(row, issue.zero);

			const again = row.createEl("button", {
				cls: "pantry-button-ghost",
				text: "Answer again",
			});
			again.onclick = () => {
				guarded(`could not reopen ${issue.product.name}`, async () => {
					await this.plugin.products.update(issue.product, {
						unit: "",
						size: "",
						amount: "",
					});
					this.mode = "todo";
					this.skipped.delete(issue.product.path);
					this.draw();
					await this.reload();
				});
			};
		});
	}

	private drawDone(body: HTMLElement): void {
		const wrap = body.createDiv({ cls: "pantry-empty" });
		wrap.createDiv({ cls: "pantry-empty-title", text: "Nothing left to sort out" });
		wrap.createDiv({
			cls: "pantry-empty-hint",
			text: "Every ingredient your recipes ask for points at a product that knows how it is bought.",
		});

		const stubborn = this.plugin.cleanup.stubborn();
		if (stubborn.length > 0) {
			const button = wrap.createEl("button", {
				cls: "pantry-button-ghost",
				text: `${stubborn.length} still do not count — look`,
			});
			button.onclick = () => {
				this.mode = "zero";
				this.draw();
			};
		}
	}

	/* --- writing ------------------------------------------------------ */

	private async answer(
		product: Product,
		patch: { unit?: string; size?: string; amount?: string }
	): Promise<void> {
		this.expanded = "";
		await this.plugin.products.update(product, patch);
		await this.after();
	}

	private async create(entry: UnknownIngredient): Promise<void> {
		await this.plugin.products.create(entry.name);
		await this.after();
	}

	private async link(entry: UnknownIngredient, product: Product): Promise<void> {
		this.picking = "";
		await this.plugin.products.learn(product, entry.name);
		await this.after();
	}

	/** One place to rebuild everything a written answer changes. */
	private async after(): Promise<void> {
		await this.reload();
		await this.plugin.list.refresh();
		this.plugin.refreshViews();
	}
}
