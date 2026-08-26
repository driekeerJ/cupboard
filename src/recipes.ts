import { TFile, normalizePath } from "obsidian";
import type PantryPlugin from "./main";

export interface Recipe {
	/** Vault path of the note. */
	path: string;
	/** File name without extension — the recipe's title. */
	name: string;
	frontmatter: Record<string, unknown>;
}

/** Field values the user has ticked, keyed by frontmatter field. */
export type RecipeFilter = Record<string, string[]>;

/** The one field the list is ordered by, plus its direction. */
export interface RecipeSort {
	field: string;
	direction: "asc" | "desc";
}

/** Pseudo-field: the note title, which is not in the frontmatter. */
export const NAME_FIELD = "name";

/** The default order — the same one `RecipeIndex.all()` already returns. */
export const DEFAULT_SORT: RecipeSort = { field: NAME_FIELD, direction: "asc" };

function isInsideFolder(path: string, folder: string): boolean {
	if (folder.length === 0) return false;
	const prefix = `${folder}/`;
	return path.startsWith(prefix);
}

/** Frontmatter values can be scalars or lists; both end up as display strings. */
export function toValues(raw: unknown): string[] {
	if (raw === null || raw === undefined) return [];
	if (Array.isArray(raw)) return raw.flatMap(toValues);
	if (typeof raw === "boolean") return [raw ? "yes" : "no"];
	const text = `${raw}`.trim();
	return text.length > 0 ? [text] : [];
}

/**
 * Reads recipes straight from the vault each time. Obsidian keeps frontmatter
 * in its metadata cache, so this stays cheap even with a large recipe folder.
 */
export class RecipeIndex {
	private plugin: PantryPlugin;

	constructor(plugin: PantryPlugin) {
		this.plugin = plugin;
	}

	all(): Recipe[] {
		const folder = normalizePath(this.plugin.settings.recipeFolder ?? "");
		if (folder.length === 0 || folder === "/") return [];

		return this.plugin.app.vault
			.getMarkdownFiles()
			.filter((file: TFile) => isInsideFolder(file.path, folder))
			.map((file: TFile) => ({
				path: file.path,
				name: file.basename,
				frontmatter:
					(this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as
						| Record<string, unknown>
						| undefined) ?? {},
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Every frontmatter field found, with the distinct values it takes. */
	static fieldValues(recipes: Recipe[]): Map<string, string[]> {
		const found = new Map<string, Set<string>>();
		for (const recipe of recipes) {
			for (const [field, raw] of Object.entries(recipe.frontmatter)) {
				if (field === "position") continue;
				const values = toValues(raw);
				if (values.length === 0) continue;
				let bucket = found.get(field);
				if (!bucket) {
					bucket = new Set<string>();
					found.set(field, bucket);
				}
				values.forEach((value) => bucket!.add(value));
			}
		}

		const result = new Map<string, string[]>();
		[...found.keys()]
			.sort((a, b) => a.localeCompare(b))
			.forEach((field) => {
				result.set(
					field,
					[...found.get(field)!].sort((a, b) =>
						a.localeCompare(b, undefined, { numeric: true })
					)
				);
			});
		return result;
	}

	/** Values are OR'd within a field, fields are AND'ed with each other. */
	static matches(recipe: Recipe, query: string, filter: RecipeFilter): boolean {
		const trimmed = query.trim().toLowerCase();
		if (trimmed.length > 0 && !recipe.name.toLowerCase().includes(trimmed)) {
			return false;
		}

		for (const [field, wanted] of Object.entries(filter)) {
			if (wanted.length === 0) continue;
			const values = toValues(recipe.frontmatter[field]);
			if (!wanted.some((value) => values.includes(value))) return false;
		}
		return true;
	}
}

export function countActiveFilters(filter: RecipeFilter): number {
	return Object.values(filter).reduce((total, values) => total + values.length, 0);
}

/**
 * The value a recipe is sorted by for one field. A list field sorts on its
 * own first value, so `type: ["stoof", "frans"]` lands under "frans".
 * `null` means the recipe does not have the field at all.
 */
function sortKey(recipe: Recipe, field: string): string | null {
	if (field === NAME_FIELD) return recipe.name;
	const values = toValues(recipe.frontmatter[field]);
	if (values.length === 0) return null;
	return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
}

const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

/** Numbers sort as numbers only when every recipe that has the field has one. */
function isNumericField(recipes: Recipe[], field: string): boolean {
	let seen = false;
	for (const recipe of recipes) {
		const key = sortKey(recipe, field);
		if (key === null) continue;
		if (!NUMBER.test(key)) return false;
		seen = true;
	}
	return seen;
}

/** Every field the list can be ordered by: the title first, then frontmatter. */
export function sortFields(recipes: Recipe[]): string[] {
	return [NAME_FIELD, ...RecipeIndex.fieldValues(recipes).keys()];
}

/**
 * Orders a copy of the list. Recipes without the field always sink to the
 * bottom, in both directions — reversing the order should not promote the
 * ones that say nothing. Ties fall back on the title, so the list never
 * shuffles between redraws.
 */
export function sortRecipes(recipes: Recipe[], sort: RecipeSort): Recipe[] {
	const numeric = isNumericField(recipes, sort.field);
	const direction = sort.direction === "desc" ? -1 : 1;

	return [...recipes].sort((a, b) => {
		const left = sortKey(a, sort.field);
		const right = sortKey(b, sort.field);
		if (left === null && right === null) return a.name.localeCompare(b.name);
		if (left === null) return 1;
		if (right === null) return -1;

		const compared = numeric
			? Number(left.replace(",", ".")) - Number(right.replace(",", "."))
			: left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
		if (compared === 0) return a.name.localeCompare(b.name);
		return compared * direction;
	});
}
