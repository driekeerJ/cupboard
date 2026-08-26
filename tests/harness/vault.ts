/**
 * Een neppe vault: `Map<pad, markdown>`, meer niet.
 *
 * Het punt van deze opzet is dat de echte `ProductIndex`, `NeedIndex`,
 * `GroceryList`, `PlanStore` en `consume.ts` er ongewijzigd op draaien. Wat
 * hier staat is precies wat zij van Obsidian vragen — niets meer, zodat het
 * duidelijk blijft hoe klein dat oppervlak is.
 *
 * Het duurste onderdeel is `processFrontMatter`: die moet écht YAML lezen,
 * muteren en terugschrijven. Zonder dat is de schrijfkant van de keten (en dus
 * bevinding H1, voorraad die uit het niets ontstaat) niet te testen.
 */
import { dump, load } from "js-yaml";
import type { TFile } from "obsidian";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

/** Wat de code van een TFile aanraakt: het pad en de bestandsnaam. */
function asFile(path: string): TFile {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const basename = name.replace(/\.md$/, "");
	return { path, name, basename, extension: "md" } as unknown as TFile;
}

function splitFrontMatter(markdown: string): {
	data: Record<string, unknown>;
	body: string;
} {
	const match = FRONTMATTER.exec(markdown);
	if (!match) return { data: {}, body: markdown };
	const parsed = load(match[1]);
	const data =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	return { data, body: markdown.slice(match[0].length) };
}

function joinFrontMatter(data: Record<string, unknown>, body: string): string {
	if (Object.keys(data).length === 0) return body;
	const yaml = dump(data, { lineWidth: -1, noRefs: true }).trimEnd();
	return `---\n${yaml}\n---\n${body.replace(/^\r?\n/, "")}`;
}

export class FakeVault {
	/** Pad → markdown. Dit is de hele vault. */
	readonly files = new Map<string, string>();
	private folders = new Set<string>();
	/**
	 * Paden waarvan elke schrijfactie weigert.
	 *
	 * Zo is na te spelen wat er in het echt gebeurt als een notitie halverwege
	 * verwijderd, hernoemd of gelockt wordt: één product klapt, de rest moet
	 * gewoon doorgaan.
	 */
	readonly refuseWrites = new Set<string>();

	constructor(files: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(files)) this.write(path, content);
	}

	/** Zet een bestand neer en registreer de mappen eromheen. */
	write(path: string, content: string): void {
		this.files.set(path, content);
		const parts = path.split("/");
		parts.pop();
		let prefix = "";
		for (const part of parts) {
			prefix = prefix ? `${prefix}/${part}` : part;
			this.folders.add(prefix);
		}
	}

	read(path: string): string {
		return this.files.get(path) ?? "";
	}

	/** Alles wat er staat, op alfabetische volgorde — reproduceerbaar. */
	snapshot(): Record<string, string> {
		return Object.fromEntries([...this.files.entries()].sort());
	}

	// --- Het oppervlak dat de plugin gebruikt --------------------------------

	readonly vault = {
		getMarkdownFiles: (): TFile[] =>
			[...this.files.keys()]
				.filter((path) => path.endsWith(".md"))
				.sort()
				.map(asFile),

		getFileByPath: (path: string): TFile | null =>
			this.files.has(path) ? asFile(path) : null,

		getFolderByPath: (path: string): { path: string } | null =>
			this.folders.has(path) ? { path } : null,

		createFolder: (path: string): Promise<void> => {
			this.folders.add(path);
			return Promise.resolve();
		},

		cachedRead: (file: TFile): Promise<string> =>
			Promise.resolve(this.read(file.path)),

		create: (path: string, content: string): Promise<TFile> => {
			this.write(path, content);
			return Promise.resolve(asFile(path));
		},

		modify: (file: TFile, content: string): Promise<void> => {
			this.write(file.path, content);
			return Promise.resolve();
		},

		process: (file: TFile, fn: (content: string) => string): Promise<string> => {
			const next = fn(this.read(file.path));
			this.write(file.path, next);
			return Promise.resolve(next);
		},
	};

	readonly metadataCache = {
		getFileCache: (file: TFile): { frontmatter: Record<string, unknown> } => ({
			frontmatter: splitFrontMatter(this.read(file.path)).data,
		}),

		/**
		 * Obsidian zoekt eerst op exact pad, dan op bestandsnaam. Een link als
		 * `[[Rijst]]` moet `Products/Rijst.md` vinden zonder dat de map genoemd
		 * wordt — precies wat het weekplan en de boodschappennotitie doen.
		 */
		getFirstLinkpathDest: (linkpath: string, _source: string): TFile | null => {
			const target = linkpath.trim();
			if (target.length === 0) return null;
			for (const candidate of [target, `${target}.md`]) {
				if (this.files.has(candidate)) return asFile(candidate);
			}
			const match = [...this.files.keys()]
				.sort()
				.find((path) => asFile(path).basename === target);
			return match ? asFile(match) : null;
		},
	};

	readonly fileManager = {
		/**
		 * Schrijft de frontmatter echt terug. `delete frontmatter.x` moet de
		 * sleutel uit het bestand halen, anders leest de volgende ronde een
		 * waarde die de gebruiker net heeft weggegooid.
		 */
		processFrontMatter: (
			file: TFile,
			fn: (frontmatter: Record<string, unknown>) => void
		): Promise<void> => {
			if (this.refuseWrites.has(file.path)) {
				return Promise.reject(new Error(`refused: ${file.path}`));
			}
			const { data, body } = splitFrontMatter(this.read(file.path));
			fn(data);
			this.write(file.path, joinFrontMatter(data, body));
			return Promise.resolve();
		},
	};

	readonly workspace = {
		getLeavesOfType: (): unknown[] => [],
	};
}
