import { normalizePath, type TFile } from "obsidian";
import { markdownIn } from "./folder";
import type PantryPlugin from "./main";
import { ensureFolder } from "./notes";
import { parseNumber } from "./products";
import type { HouseholdMember } from "./types";

/** Frontmatter-sleutels waar de portiefactor in kan staan, hoofdletterloos. */
const FACTOR_KEYS = [
	"portionfactor", "portion factor", "portion",
	"portiefactor", "portie", "porties", "factor",
];

/**
 * Wie er meeëet, als notities in een map.
 *
 * Het gezin stond alleen in `data.json`: dat bestand sterft met de plugin, en
 * daarmee ook dat een kind een halve portie eet. Winkels en producten zijn al
 * notities; hier is geen reden voor een uitzondering.
 *
 * Bewust naast de instellingen en niet ervoorin de plaats: staat er geen map
 * ingesteld, of is hij leeg, dan blijft de lijst uit `data.json` leidend. Wie
 * niets doet merkt niets, en overstappen is één knop (`moveToNotes`).
 */
export class HouseholdIndex {
	private plugin: PantryPlugin;
	private members: HouseholdMember[] = [];

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	folder(): string {
		const folder = this.plugin.settings.householdFolder.trim();
		return folder.length > 0 ? normalizePath(folder) : "";
	}

	isMemberNote(path: string): boolean {
		const folder = this.folder();
		if (folder.length === 0) return false;
		return normalizePath(path).startsWith(`${folder}/`);
	}

	/** Of de notities het gezin bepalen, of nog de instellingen. */
	usingNotes(): boolean {
		return this.members.length > 0;
	}

	build(): void {
		const folder = this.folder();
		if (folder.length === 0) {
			this.members = [];
			return;
		}

		this.members = markdownIn(this.plugin.app.vault, folder)
			.sort((a, b) => a.basename.localeCompare(b.basename))
			.map((file) => this.read(file));
	}

	/**
	 * De lijst waar de rest van de plugin mee rekent.
	 *
	 * `id` is het pad en `name` de bestandsnaam, dus overal waar de code al
	 * `name.trim() || id` deed verandert er niets aan de uitkomst.
	 */
	all(): HouseholdMember[] {
		return this.usingNotes() ? this.members : this.plugin.settings.household;
	}

	private read(file: TFile): HouseholdMember {
		const frontmatter =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

		const byLowerKey = new Map<string, unknown>();
		for (const [key, value] of Object.entries(frontmatter)) {
			byLowerKey.set(key.trim().toLowerCase(), value);
		}

		let factor = 1;
		for (const key of FACTOR_KEYS) {
			const value = parseNumber(byLowerKey.get(key));
			if (value !== null && value > 0) {
				factor = value;
				break;
			}
		}

		return { id: file.path, name: file.basename, portionFactor: factor };
	}

	/**
	 * Schrijft de mensen uit `data.json` weg als notities.
	 *
	 * Eenmalig en op verzoek, niet stilletijk bij het opstarten: dit maakt
	 * bestanden aan in de vault van iemand anders. Bestaande notities blijven
	 * ongemoeid, zodat twee keer klikken niets stukmaakt.
	 */
	async moveToNotes(): Promise<number> {
		const folder = this.folder();
		if (folder.length === 0) return 0;
		await ensureFolder(this.plugin.app.vault, folder);

		let written = 0;
		for (const member of this.plugin.settings.household) {
			const name = member.name.trim();
			if (name.length === 0) continue;

			const path = `${folder}/${name.replace(/[\\/:|#^[\]]/g, " ").trim()}.md`;
			if (this.plugin.app.vault.getFileByPath(path)) continue;

			await this.plugin.app.vault.create(
				path,
				`---\nportionFactor: ${member.portionFactor}\n---\n\n# ${name}\n`
			);
			written++;
		}

		this.build();
		return written;
	}
}
