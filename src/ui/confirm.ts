import { Modal, type App } from "obsidian";

/**
 * Eén vraag vóór iets wat niet terug te draaien is.
 *
 * Done en Delete list waren één tik, zonder tussenstap. In de winkel, op een
 * telefoon, met een duim: dat is precies het moment dat je ernaast tikt. En
 * juist dáár was op 2026-09-09 een lijst ineens weg. De vraag kost een tik;
 * een lijst kwijt kost een winkelbezoek.
 */
export interface ConfirmOptions {
	title: string;
	/** Eén of twee zinnen: wat er gebeurt, en wat erna nog kan. */
	body: string;
	/** Tekst op de knop die het doet. */
	action: string;
	/** Rood: dit haalt iets weg. */
	danger?: boolean;
}

export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}

class ConfirmModal extends Modal {
	private options: ConfirmOptions;
	private resolve: (answer: boolean) => void;
	private answered = false;

	constructor(app: App, options: ConfirmOptions, resolve: (answer: boolean) => void) {
		super(app);
		this.options = options;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.modalEl.addClass("pantry-app", "pantry-confirm");
		this.titleEl.setText(this.options.title);
		this.contentEl.createDiv({ cls: "pantry-confirm-body", text: this.options.body });

		const foot = this.contentEl.createDiv({ cls: "pantry-confirm-foot" });
		const cancel = foot.createEl("button", { cls: "pantry-text-button", text: "Cancel" });
		cancel.onclick = () => this.answer(false);
		const go = foot.createEl("button", {
			cls: `pantry-text-button ${this.options.danger ? "pantry-danger-button" : "pantry-primary-button"}`,
			text: this.options.action,
		});
		go.onclick = () => this.answer(true);
		// De veilige keuze heeft de focus: Enter doet dan niets onherroepelijks.
		cancel.focus();
	}

	onClose(): void {
		// Wegklikken of Escape is nee.
		if (!this.answered) this.answer(false);
		this.contentEl.empty();
	}

	private answer(value: boolean): void {
		if (this.answered) return;
		this.answered = true;
		this.resolve(value);
		this.close();
	}
}
