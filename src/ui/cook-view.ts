import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { guarded } from "../guard";

import type PantryPlugin from "../main";
import {
	findDurations,
	formatClock,
	remaining,
	timerKey,
} from "../cook";
import type { CookLine, CookNote } from "../cook-session";
import { withoutLinks } from "../ingredients";
import { formatServings } from "../plan";

export const COOK_VIEW_TYPE = "pantry-cook";

/** Half a portion is the smallest step that ever makes sense. */
const SERVINGS_STEP = 0.5;

/**
 * Zolang na onze eigen schrijfactie een `modify` niet als vreemde wijziging
 * telt. Zonder dit hertekent elk vinkje het scherm en spring je terug naar
 * boven — met natte handen, midden in stap zeven.
 */
const OWN_WRITE_MS = 1200;

export interface CookViewState {
	/** Pad van de kooksessie-notitie, niet van het recept. */
	path: string;
}

interface TimerChip {
	key: string;
	seconds: number;
	el: HTMLElement;
	clockEl: HTMLElement;
}

const EMPTY: CookNote = { servings: null, recipe: null, ingredients: [], steps: [] };

export class CookView extends ItemView {
	private plugin: PantryPlugin;
	private path = "";
	private file: TFile | null = null;
	private note: CookNote = EMPTY;
	private chips: TimerChip[] = [];
	/** Timers already announced, so the sound plays once per finish. */
	private announced: Set<string> = new Set();
	private audio: AudioContext | null = null;
	private lastWrite = 0;

	constructor(leaf: WorkspaceLeaf, plugin: PantryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COOK_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.note.recipe ?? this.file?.basename ?? "Cooking";
	}

	getIcon(): string {
		return "chef-hat";
	}

	getState(): Record<string, unknown> {
		return { path: this.path };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const incoming = state as Partial<CookViewState> | null;
		if (incoming?.path) this.path = incoming.path;
		await super.setState(state, result);
		await this.reload();
	}

	async onOpen(): Promise<void> {
		// Het pad is een string die nergens meeliep. Hernoemde je de notitie —
		// of de map eromheen — dan zei dit scherm "kon niet meer gevonden
		// worden" terwijl hij gewoon bestond.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (oldPath !== this.path) return;
				this.path = file.path;
				guarded("could not reload the cooking session", () => this.reload());
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path !== this.path) return;
				// Onze eigen vinkjes staan al op het scherm.
				if (Date.now() - this.lastWrite < OWN_WRITE_MS) return;
				guarded("could not reload the cooking session", () => this.reload());
			})
		);
		// Half a second keeps the seconds flipping over cleanly without churn.
		this.registerInterval(window.setInterval(() => this.tick(), 500));
		await this.reload();
	}

	onClose(): Promise<void> {
		this.chips = [];
		// Geluid is versiering: mislukt het sluiten, dan is dat geen boodschap
		// voor de kok. Wel opvangen, want een losse rejection is geen stijl.
		this.audio?.close().catch(() => undefined);
		this.audio = null;
		return Promise.resolve();
	}

	refresh(): void {
		guarded("could not reload the cooking session", () => this.reload());
	}

	private async reload(): Promise<void> {
		this.file = this.app.vault.getFileByPath(this.path);
		if (!this.file) {
			this.contentEl.empty();
			this.contentEl.createDiv({
				cls: "pantry-empty-state",
				text: "That cooking session could not be found any more.",
			});
			return;
		}

		this.note = await this.plugin.cook.read(this.file);
		this.draw();
	}

	private servings(): number {
		return this.note.servings ?? this.plugin.cook.householdServings();
	}

	private recipeFile(): TFile | null {
		return this.note.recipe ? this.plugin.cook.file(this.note.recipe) : null;
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
			text: this.note.recipe ?? this.file?.basename ?? "Cooking",
		});

		const actions = top.createDiv({ cls: "pantry-cook-actions" });

		const openNote = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Recipe",
			attr: { "aria-label": "Open recipe note" },
		});
		openNote.onclick = () => {
			const file = this.recipeFile();
			if (file) {
				guarded("could not open the recipe note", () =>
					this.app.workspace.getLeaf(false).openFile(file)
				);
			}
		};

		const openSession = actions.createEl("button", {
			cls: "pantry-text-button",
			text: "Note",
			attr: { "aria-label": "Open this cooking session as a note" },
		});
		openSession.onclick = () => {
			const file = this.file;
			if (file) {
				guarded("could not open the session note", () =>
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
				this.setServings(this.servings() - SERVINGS_STEP)
			);

		row.createSpan({
			cls: "pantry-servings-value",
			text: `${formatServings(this.servings())} ${
				this.servings() === 1 ? "serving" : "servings"
			}`,
		});

		const plus = row.createEl("button", {
			cls: "pantry-step-button",
			text: "+",
			attr: { "aria-label": "More servings" },
		});
		plus.onclick = () =>
			guarded("could not change the servings", () =>
				this.setServings(this.servings() + SERVINGS_STEP)
			);

		const recipe = this.recipeFile();
		const base = recipe ? this.plugin.cook.baseServings(recipe) : null;
		row.createSpan({
			cls: "pantry-cook-scale",
			text: base
				? `recipe serves ${formatServings(base)}`
				: `no ${this.plugin.settings.servingsField} in this recipe`,
		});
	}

	private async setServings(value: number): Promise<void> {
		const next = Math.max(SERVINGS_STEP, Math.round(value * 2) / 2);
		if (next === this.servings() || !this.file) return;
		this.lastWrite = Date.now();
		await this.plugin.cook.rescale(this.file, next);
		await this.reload();
	}

	private async reset(): Promise<void> {
		if (!this.file) return;
		this.announced.clear();
		this.lastWrite = Date.now();
		await this.plugin.cook.restart(this.file, this.servings());
		await this.reload();
		new Notice("Cooking session started over.");
	}

	private drawIngredients(root: HTMLElement): void {
		const section = root.createDiv({ cls: "pantry-cook-section" });
		section.createDiv({ cls: "pantry-cook-heading", text: "Ingredients" });

		if (this.note.ingredients.length === 0) {
			section.createDiv({
				cls: "pantry-settings-hint",
				text: "This session has no ingredients. Use Start over to build it from the recipe again.",
			});
			return;
		}

		// De kopjes komen uit de notitie zelf: wat je daar hernoemt of
		// verschuift, staat hier zo op het scherm.
		let host: HTMLElement = section;
		let group: string | null | undefined;
		for (const line of this.note.ingredients) {
			if (line.group !== group) {
				group = line.group;
				host = section.createDiv({ cls: "pantry-cook-group" });
				if (group) {
					host.createDiv({ cls: "pantry-cook-group-heading", text: group });
				}
			}
			this.drawIngredient(host, line);
		}
	}

	private drawIngredient(host: HTMLElement, line: CookLine): void {
		const row = host.createEl("button", { cls: "pantry-check-row" });
		row.toggleClass("is-done", line.done);
		row.setAttr("aria-pressed", `${line.done}`);

		const box = row.createSpan({ cls: "pantry-check-box" });
		// A character, for the same reason as the stepper: it always renders.
		if (line.done) box.setText("✓");

		const text = row.createDiv({ cls: "pantry-check-body" });
		text.createDiv({ cls: "pantry-check-text", text: withoutLinks(line.text) });

		row.onclick = () => {
			// Alleen deze rij bijwerken; het bestand volgt. Hertekenen zou de
			// scrollpositie weggooien.
			line.done = !line.done;
			row.toggleClass("is-done", line.done);
			row.setAttr("aria-pressed", `${line.done}`);
			box.setText(line.done ? "✓" : "");
			guarded("could not save your ticks", () => this.write(line));
		};
	}

	private drawSteps(root: HTMLElement): void {
		const section = root.createDiv({ cls: "pantry-cook-section" });
		section.createDiv({ cls: "pantry-cook-heading", text: "Method" });

		if (this.note.steps.length === 0) {
			section.createDiv({
				cls: "pantry-settings-hint",
				text: "This session has no steps. Use Start over to build it from the recipe again.",
			});
			return;
		}

		this.note.steps.forEach((line) => this.drawStep(section, line));
	}

	private drawStep(section: HTMLElement, line: CookLine): void {
		const row = section.createDiv({ cls: "pantry-step" });
		row.toggleClass("is-done", line.done);

		const box = row.createSpan({ cls: "pantry-check-box" });
		if (line.done) box.setText("✓");

		const body = row.createDiv({ cls: "pantry-step-body" });
		body.createSpan({ cls: "pantry-step-number", text: `${line.index + 1}.` });

		const text = body.createSpan({ cls: "pantry-step-text" });
		this.drawStepText(text, line.text, line.index);

		const toggle = (event: MouseEvent): void => {
			// A tap on a timer must not also tick the step off.
			if ((event.target as HTMLElement).closest(".pantry-timer")) return;
			line.done = !line.done;
			row.toggleClass("is-done", line.done);
			box.setText(line.done ? "✓" : "");
			guarded("could not save your ticks", () => this.write(line));
		};
		box.onclick = toggle;
		body.onclick = toggle;
	}

	private async write(line: CookLine): Promise<void> {
		if (!this.file) return;
		this.lastWrite = Date.now();
		await this.plugin.cook.tick(this.file, line.line, line.done);
	}

	/** Writes the step out, turning every duration into its own timer button. */
	private drawStepText(host: HTMLElement, rawLine: string, step: number): void {
		// De wikilink-syntax gaat er af vóór het zoeken naar tijdsduren, zodat
		// de posities die findDurations teruggeeft bij deze tekst horen.
		const line = withoutLinks(rawLine);
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
		const running = this.plugin.cook.timers(this.path)[key];
		if (running) {
			await this.plugin.cook.setTimer(this.path, key, null);
			this.announced.delete(key);
		} else {
			await this.plugin.cook.setTimer(this.path, key, {
				startedAt: Date.now(),
				seconds,
			});
			// Touching the audio graph inside the tap keeps iOS willing to play.
			this.primeAudio();
		}
		this.tick();
	}

	/** Repaints the running clocks; the rest of the view stays untouched. */
	private tick(): void {
		const now = Date.now();
		const timers = this.plugin.cook.timers(this.path);

		this.chips.forEach((chip) => {
			const timer = timers[chip.key];
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
