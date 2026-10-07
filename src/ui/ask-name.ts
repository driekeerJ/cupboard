import { Modal, type App } from "obsidian";

/**
 * Eén naam vragen, voor iets wat een notitie wordt: een winkel, een recept.
 *
 * Een eigen venster en geen invoerveld in het scherm zelf: een veld onderaan
 * een lange schaproute vond niemand ("ik kon niet ontdekken hoe ik een tweede
 * winkel toevoeg"), en een knop kan overal staan waar je hem zoekt — in de
 * kop, in de kiezer, in het command palette.
 */
export interface AskNameOptions {
	title: string;
	/** Eén zin: wat er gebeurt als je op de knop drukt. */
	body: string;
	placeholder: string;
	/** Tekst op de knop die het doet. */
	action: string;
}

/** De getypte naam, of null als je annuleert of niets typt. */
export function askName(app: App, options: AskNameOptions): Promise<string | null> {
	return new Promise((resolve) => {
		new AskNameModal(app, options, resolve).open();
	});
}

class AskNameModal extends Modal {
	private options: AskNameOptions;
	private resolve: (name: string | null) => void;
	private answered = false;

	constructor(app: App, options: AskNameOptions, resolve: (name: string | null) => void) {
		super(app);
		this.options = options;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.modalEl.addClass("pantry-app", "pantry-confirm");
		this.titleEl.setText(this.options.title);
		this.contentEl.createDiv({ cls: "pantry-confirm-body", text: this.options.body });

		const input = this.contentEl.createEl("input", {
			cls: "pantry-field-input pantry-ask-input",
			attr: { type: "text", placeholder: this.options.placeholder, enterkeyhint: "done" },
		});

		const foot = this.contentEl.createDiv({ cls: "pantry-confirm-foot" });
		const cancel = foot.createEl("button", { cls: "pantry-text-button", text: "Cancel" });
		cancel.onclick = () => this.answer(null);
		const go = foot.createEl("button", {
			cls: "pantry-text-button pantry-primary-button",
			text: this.options.action,
		});

		const submit = (): void => {
			const name = input.value.trim();
			if (name.length > 0) this.answer(name);
		};
		const lock = (): void => {
			const empty = input.value.trim().length === 0;
			go.disabled = empty;
			go.toggleClass("is-disabled", empty);
		};
		go.onclick = submit;
		input.addEventListener("input", lock);
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			submit();
		});
		lock();
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		// Wegklikken of Escape is: toch niet.
		if (!this.answered) this.answer(null);
		this.contentEl.empty();
	}

	private answer(name: string | null): void {
		if (this.answered) return;
		this.answered = true;
		this.resolve(name);
		this.close();
	}
}
