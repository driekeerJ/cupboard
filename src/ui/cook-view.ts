import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { guarded } from "../guard";

import type PantryPlugin from "../main";
import {
	findDurations,
	formatClock,
	parseRecipeBody,
	remaining,
	timerKey,
	type RecipeBody,
} from "../cook";
import { scaleIngredient } from "../ingredients";
import { formatServings } from "../plan";
import type { CookSession } from "../types";

export const COOK_VIEW_TYPE = "pantry-cook";

/** Half a portion is the smallest step that ever makes sense. */
const SERVINGS_STEP = 0.5;

export interface CookViewState {
	path: string;
	servings: number;
}

interface TimerChip {
	key: string;
	seconds: number;
	el: HTMLElement;
	clockEl: HTMLElement;
}

export class CookView extends ItemView {
	private plugin: PantryPlugin;
	private path = "";
	private servings = 1;
	private file: TFile | null = null;
	private body: RecipeBody = { ingredients: [], steps: [] };
	private session: CookSession = {
		ingredients: [],
		steps: [],
		timers: {},
		updatedAt: 0,
	};
	private chips: TimerChip[] = [];
	/** Timers already announced, so the sound plays once per finish. */
	private announced: Set<string> = new Set();
	private audio: AudioContext | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COOK_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Cooking";
	}

	getIcon(): string {
		return "chef-hat";
	}

	getState(): Record<string, unknown> {
		return { path: this.path, servings: this.servings };
	}

	async setState(
		state: unknown,
		result: ViewStateResult
	): Promise<void> {
		const incoming = state as Partial<CookViewState> | null;
		if (incoming?.path) this.path = incoming.path;
		if (typeof incoming?.servings === "number") this.servings = incoming.servings;
		await super.setState(state, result);
		await this.reload();
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path === this.path) {
					guarded("could not reload the recipe", () => this.reload());
				}
			})
		);
		// Half a second keeps the seconds flipping over cleanly without churn.
		this.registerInterval(window.setInterval(() => this.tick(), 500));
		await this.reload();
	}

	async onClose(): Promise<void> {
		this.chips = [];
		// Geluid is versiering: mislukt het sluiten, dan is dat geen boodschap
		// voor de kok. Wel opvangen, want een losse rejection is geen stijl.
		this.audio?.close().catch(() => undefined);
		this.audio = null;
	}

	private async reload(): Promise<void> {
		this.file = this.plugin.cook.file(this.path);
		if (!this.file) {
			this.contentEl.empty();
			this.contentEl.createDiv({
				cls: "pantry-empty-state",
				text: "That recipe could not be found any more.",
			});
			return;
		}

		this.session = this.plugin.cook.session(this.file.path);
		if (this.session.servings && this.servings <= 0) {
			this.servings = this.session.servings;
		}
		if (this.servings <= 0) this.servings = this.plugin.cook.householdServings();

		const content = await this.app.vault.cachedRead(this.file);
		this.body = parseRecipeBody(content);
		this.draw();
	}

	private async persist(): Promise<void> {
		if (!this.file) return;
		await this.plugin.cook.write(this.file.path, {
			...this.session,
			servings: this.servings,
		});
	}

	private factor(): number {
		if (!this.file) return 1;
		const base = this.plugin.cook.baseServings(this.file);
		if (!base) return 1;
		return this.servings / base;
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pantry-cook");
		this.chips = [];

		this.drawHeader(root);
		this.drawIngredients(root);
		this.drawSteps(root);
		this.tick();
	}

	private drawHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "pantry-cook-header" });

		const top = header.createDiv({ cls: "pantry-cook-top" });
		top.createEl("h2", {
			cls: "pantry-cook-title",
			text: this.file?.basename ?? "Cooking",
		});

		const actions = top.createDiv({ cls: "pantry-cook-actions" });

		const openNote = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Recipe",
			attr: { "aria-label": "Open recipe note" },
		});
		openNote.onclick = () => {
			const file = this.file;
			if (file) {
				guarded("could not open the recipe note", () =>
					this.app.workspace.getLeaf(false).openFile(file)
				);
			}
		};

		const reset = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Start over",
		});
		reset.onclick = () => guarded("could not start over", () => this.reset());

		const row = header.createDiv({ cls: "pantry-servings-row" });

		// Characters rather than icons: a missing glyph is far less likely than
		// a missing icon, and these are the most-used controls on the screen.
		const minus = row.createEl("button", {
			cls: "pantry-step-button",
			text: "−",
			attr: { "aria-label": "Fewer servings" },
		});
		minus.onclick = () =>
			guarded("could not change the servings", () =>
				this.setServings(this.servings - SERVINGS_STEP)
			);

		row.createSpan({
			cls: "pantry-servings-value",
			text: `${formatServings(this.servings)} ${
				this.servings === 1 ? "serving" : "servings"
			}`,
		});

		const plus = row.createEl("button", {
			cls: "pantry-step-button",
			text: "+",
			attr: { "aria-label": "More servings" },
		});
		plus.onclick = () =>
			guarded("could not change the servings", () =>
				this.setServings(this.servings + SERVINGS_STEP)
			);

		const base = this.file ? this.plugin.cook.baseServings(this.file) : null;
		row.createSpan({
			cls: "pantry-cook-scale",
			text: base
				? `recipe serves ${formatServings(base)} · ×${formatServings(
						Math.round(this.factor() * 100) / 100
				  )}`
				: `no ${this.plugin.settings.servingsField} in this recipe`,
		});
	}

	private async setServings(value: number): Promise<void> {
		const next = Math.max(SERVINGS_STEP, Math.round(value * 2) / 2);
		if (next === this.servings) return;
		this.servings = next;
		await this.persist();
		this.draw();
	}

	private async reset(): Promise<void> {
		this.session = { ingredients: [], steps: [], timers: {}, updatedAt: 0 };
		this.announced.clear();
		await this.persist();
		this.draw();
		new Notice("Cooking session cleared.");
	}

	private drawIngredients(root: HTMLElement): void {
		const section = root.createDiv({ cls: "pantry-cook-section" });
		section.createDiv({ cls: "pantry-cook-heading", text: "Ingredients" });

		if (this.body.ingredients.length === 0) {
			section.createDiv({
				cls: "pantry-settings-hint",
				text: "No ingredients found. Add an \"Ingredients\" heading with a list underneath.",
			});
			return;
		}

		const factor = this.factor();
		this.body.ingredients.forEach((line, index) => {
			const scaled = scaleIngredient(line, factor);
			const ticked = this.session.ingredients[index] === true;

			const row = section.createEl("button", { cls: "pantry-check-row" });
			row.toggleClass("is-done", ticked);
			row.setAttr("aria-pressed", `${ticked}`);

			const box = row.createSpan({ cls: "pantry-check-box" });
			// A character, for the same reason as the stepper: it always renders.
			if (ticked) box.setText("✓");

			const text = row.createDiv({ cls: "pantry-check-body" });
			text.createDiv({ cls: "pantry-check-text", text: scaled.text });

			row.onclick = () => {
				this.session.ingredients[index] = !ticked;
				guarded("could not save your ticks", () => this.persist());
				this.draw();
			};
		});
	}

	private drawSteps(root: HTMLElement): void {
		const section = root.createDiv({ cls: "pantry-cook-section" });
		section.createDiv({ cls: "pantry-cook-heading", text: "Method" });

		if (this.body.steps.length === 0) {
			section.createDiv({
				cls: "pantry-settings-hint",
				text: "No steps found. Add a \"Method\" heading with a numbered list underneath.",
			});
			return;
		}

		this.body.steps.forEach((line, index) => this.drawStep(section, line, index));
	}

	private drawStep(section: HTMLElement, line: string, index: number): void {
		const ticked = this.session.steps[index] === true;

		const row = section.createDiv({ cls: "pantry-step" });
		row.toggleClass("is-done", ticked);

		const box = row.createSpan({ cls: "pantry-check-box" });
		if (ticked) box.setText("✓");

		const body = row.createDiv({ cls: "pantry-step-body" });
		body.createSpan({ cls: "pantry-step-number", text: `${index + 1}.` });

		const text = body.createSpan({ cls: "pantry-step-text" });
		this.drawStepText(text, line, index);

		const toggle = (event: MouseEvent): void => {
			// A tap on a timer must not also tick the step off.
			if ((event.target as HTMLElement).closest(".pantry-timer")) return;
			this.session.steps[index] = !ticked;
			guarded("could not save your ticks", () => this.persist());
			this.draw();
		};
		box.onclick = toggle;
		body.onclick = toggle;
	}

	/** Writes the step out, turning every duration into its own timer button. */
	private drawStepText(host: HTMLElement, line: string, step: number): void {
		const durations = findDurations(line);
		let cursor = 0;

		durations.forEach((duration, order) => {
			if (duration.start > cursor) {
				host.createSpan({ text: line.slice(cursor, duration.start) });
			}

			const key = timerKey(step, order);
			const chip = host.createEl("button", { cls: "pantry-timer" });
			chip.createSpan({ cls: "pantry-timer-label", text: duration.label });
			const clock = chip.createSpan({ cls: "pantry-timer-clock" });

			chip.onclick = (event: MouseEvent) => {
				event.stopPropagation();
				guarded("could not start the timer", () =>
					this.toggleTimer(key, duration.seconds)
				);
			};

			this.chips.push({ key, seconds: duration.seconds, el: chip, clockEl: clock });
			cursor = duration.end;
		});

		if (cursor < line.length) host.createSpan({ text: line.slice(cursor) });
	}

	private async toggleTimer(key: string, seconds: number): Promise<void> {
		if (this.session.timers[key]) {
			delete this.session.timers[key];
			this.announced.delete(key);
		} else {
			this.session.timers[key] = { startedAt: Date.now(), seconds };
			// Touching the audio graph inside the tap keeps iOS willing to play.
			this.primeAudio();
		}
		await this.persist();
		this.tick();
	}

	/** Repaints the running clocks; the rest of the view stays untouched. */
	private tick(): void {
		const now = Date.now();

		this.chips.forEach((chip) => {
			const timer = this.session.timers[chip.key];
			if (!timer) {
				chip.el.removeClass("is-running");
				chip.el.removeClass("is-finished");
				chip.clockEl.setText("");
				return;
			}

			const left = remaining(timer, now);
			chip.el.addClass("is-running");
			chip.el.toggleClass("is-finished", left <= 0);
			chip.clockEl.setText(formatClock(left));

			if (left <= 0 && !this.announced.has(chip.key)) {
				this.announced.add(chip.key);
				// Only shout about a timer that ran out while we were watching.
				if (left > -3) {
					this.beep();
					new Notice(`Timer finished: ${chip.el.textContent ?? ""}`);
				}
			}
		});
	}

	private primeAudio(): void {
		try {
			const Ctor =
				window.AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext })
					.webkitAudioContext;
			if (!Ctor) return;
			this.audio = this.audio ?? new Ctor();
			// Zie onClose: geluid mag stil mislukken.
			this.audio.resume().catch(() => undefined);
		} catch {
			this.audio = null;
		}
	}

	/** Three short tones. Only audible while Obsidian is open and in front. */
	private beep(): void {
		const ctx = this.audio;
		if (!ctx) return;
		try {
			ctx.resume().catch(() => undefined);
			[0, 0.3, 0.6].forEach((offset) => {
				const start = ctx.currentTime + offset;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = 880;
				gain.gain.setValueAtTime(0.0001, start);
				gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(start);
				osc.stop(start + 0.26);
			});
		} catch {
			// A silent timer is better than a broken view.
		}
	}
}
