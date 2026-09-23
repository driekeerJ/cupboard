import { Notice } from "obsidian";

/**
 * Eén plek waar een mislukte schrijfactie een verhaal krijgt.
 *
 * De plugin schrijft voortdurend naar de vault, en bijna al die schrijfacties
 * gingen als `void x.then(redraw)` de deur uit. `void` is daar geen vergeten
 * `await` maar een actief onderdrukte foutafhandeling: verdwijnt de notitie,
 * hernoemt iemand hem, of zit het bestand op slot, dan verwerpt
 * `processFrontMatter` stil. Erger nog, `ProductIndex.update` heeft de
 * wijziging op dat moment al in het geheugen doorgevoerd — het scherm toont
 * dus een getal dat niet op schijf staat, tot de volgende `build()`.
 *
 * Het contract: de gebruiker ziet dat het misging (`Notice`), de devtools
 * houden het spoor vast (`console.error`), en wat ná de schrijfactie hoort te
 * gebeuren — meestal een redraw — gebeurt alleen als de schrijfactie lukte.
 *
 * Bericht schrijven als een zin die achter "Cupboard" past:
 * `guard("could not update the product", …)`.
 */
export async function guard<T>(
	message: string,
	work: () => Promise<T>
): Promise<T | null> {
	try {
		return await work();
	} catch (error) {
		console.error(`Cupboard: ${message}`, error);
		if (error instanceof Refusal) new Notice(error.message);
		else new Notice(`Cupboard ${message}. See the console for details.`);
		return null;
	}
}

/**
 * Een schrijfactie die bewust níét doorging, met een reden die de gebruiker
 * iets zegt: "de notitie is niet te lezen, herstel dat eerst". Anders dan een
 * onverwachte fout hoort de reden zelf in de melding, niet "see the console".
 * De tekst is een volledige zin die met "Cupboard" begint.
 */
export class Refusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Refusal";
	}
}

/**
 * Dezelfde bescherming voor een aanroeper die niet kan wachten — een
 * klikhandler, een `onOpen`. Alles wat ná de schrijfactie moet gebeuren zet je
 * in `work`, zodat het overgeslagen wordt als de schrijfactie mislukt.
 */
export function guarded(message: string, work: () => Promise<unknown>): void {
	// De enige plek in de plugin waar een promise bewust niet afgewacht wordt.
	// Hier mag het: `guard` vangt alles, dus er kan geen rejection ontsnappen.
	// eslint-disable-next-line @typescript-eslint/no-floating-promises -- zie hierboven: guard() vangt alles, dus hier kan geen rejection ontsnappen.
	guard(message, work);
}
