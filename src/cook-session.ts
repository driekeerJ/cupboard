/**
 * De kooksessie als notitie.
 *
 * Koken doe je één keer, voor dit aantal mensen, op deze dag. Dat is geen
 * eigenschap van het recept, dus het hoort ook niet in de plugin-instellingen
 * te zitten waar je er niet bij kunt. Een sessie is een gewone notitie in de
 * vault: geschaalde ingrediënten per stap, de bereiding als aanvinkbare lijst,
 * en onderaan ruimte voor wat je de volgende keer anders wilt.
 *
 * Het bestand is de waarheid. De kookmodus leest eruit en schrijft erin; wat
 * jij er met de hand in verandert blijft staan. Alleen het aantal porties
 * wijzigen bouwt de ingrediëntenlijst opnieuw op uit het recept — dan is
 * herrekenen nu eenmaal het hele punt.
 */

import { LINK_TARGET } from "./links";
import { parseNumber } from "./number";

/** De frontmatter-sleutel die een notitie als kooksessie van Pantry merkt. */
export const COOK_MARK = "pantry";
export const COOK_MARK_VALUE = "cook";

/** Regels die de plugin herkent en terugschrijft. */
const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;
const GROUP_LABEL = /^\*\*(.+?)\*\*\s*$/;
const HEADING = /^##\s+(.*)$/;

const INGREDIENTS_HEADING = "## Ingredients";
const METHOD_HEADING = "## Method";
const NOTES_HEADING = "## Notes";

export type CookLineKind = "ingredient" | "step";

export interface CookLine {
	kind: CookLineKind;
	/** Positie binnen zijn eigen lijst; hieraan hangt het vinkje. */
	index: number;
	/** Regelnummer in het bestand, zodat terugschrijven één regel raakt. */
	line: number;
	text: string;
	done: boolean;
	/** Het kopje waaronder deze regel staat, alleen bij ingrediënten. */
	group: string | null;
}

export interface CookNote {
	servings: number | null;
	recipe: string | null;
	ingredients: CookLine[];
	steps: CookLine[];
}

/** Een naam die als bestandsnaam door Obsidian heen komt. */
export function safeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** `Cook sessions/2026-08-29 Aardappelsoep.md` */
export function sessionPath(folder: string, date: string, recipe: string): string {
	const base = folder.replace(/\/+$/, "");
	const name = safeFileName(`${date} ${recipe}`);
	return base.length > 0 ? `${base}/${name}.md` : `${name}.md`;
}

export interface SessionInput {
	recipe: string;
	date: string;
	servings: number;
	/** Kopje plus de regels eronder, in de volgorde waarin ze getoond worden. */
	groups: { label: string; lines: string[] }[];
	steps: string[];
}

/** De notitie zoals hij bij het begin van een kooksessie op schijf komt. */
export function renderSession(input: SessionInput): string {
	const out: string[] = [
		"---",
		`${COOK_MARK}: ${COOK_MARK_VALUE}`,
		`recipe: "[[${input.recipe}]]"`,
		`servings: ${input.servings}`,
		`date: ${input.date}`,
		"---",
		"",
		`# ${input.recipe}`,
		"",
		...renderRegion(input),
		"",
		NOTES_HEADING,
		"",
		"",
	];
	return out.join("\n");
}

/** Alleen het stuk dat Pantry beheert; de notities eronder blijven van jou. */
export function renderRegion(input: SessionInput): string[] {
	const out: string[] = [INGREDIENTS_HEADING, ""];

	for (const group of input.groups) {
		if (group.lines.length === 0) continue;
		out.push(`**${group.label}**`, "");
		for (const line of group.lines) out.push(`- [ ] ${line}`);
		out.push("");
	}

	out.push(METHOD_HEADING, "");
	input.steps.forEach((step, index) => out.push(`${index + 1}. [ ] ${step}`));
	out.push("");

	return out;
}

/**
 * Leest een kooksessie terug uit zijn notitie.
 *
 * Bewust tolerant: kopjes mogen anders staan en er mogen regels tussen die de
 * plugin niet kent. Alles wat een vinkvakje heeft telt mee, in de volgorde
 * waarin het staat — dat is wat je op het scherm terugziet.
 */
export function parseCookSession(content: string): CookNote {
	const lines = content.split(/\r?\n/);

	const note: CookNote = {
		servings: readFrontmatterNumber(content, "servings"),
		recipe: readRecipeLink(content),
		ingredients: [],
		steps: [],
	};

	let where: CookLineKind | null = null;
	let group: string | null = null;
	// De frontmatter overslaan: daar staan geen vinkjes, maar wel streepjes.
	let start = 0;
	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (close > 0) start = close + 1;
	}

	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index] ?? "";

		const heading = HEADING.exec(line);
		if (heading) {
			const title = (heading[1] ?? "").trim().toLowerCase();
			if (title.startsWith("ingredient")) {
				where = "ingredient";
				group = null;
			} else if (title.startsWith("method") || title.startsWith("bereiding")) {
				where = "step";
				group = null;
			} else {
				where = null;
			}
			continue;
		}

		if (where === "ingredient") {
			const label = GROUP_LABEL.exec(line.trim());
			if (label) {
				group = (label[1] ?? "").trim();
				continue;
			}
		}

		if (!where) continue;
		const box = CHECKBOX.exec(line);
		if (!box) continue;

		const bucket = where === "ingredient" ? note.ingredients : note.steps;
		bucket.push({
			kind: where,
			index: bucket.length,
			line: index,
			text: (box[4] ?? "").trim(),
			done: (box[2] ?? " ").toLowerCase() === "x",
			group: where === "ingredient" ? group : null,
		});
	}

	return note;
}

/**
 * Zet één vinkje om, op regelnummer.
 *
 * Op regelnummer en niet op tekst: twee keer "2 el taco kruiden" in dezelfde
 * lijst is heel gewoon, en dan vinkt zoeken-op-tekst de verkeerde af.
 */
export function setTick(content: string, line: number, done: boolean): string {
	const lines = content.split("\n");
	const target = lines[line];
	if (target === undefined) return content;
	const box = CHECKBOX.exec(target);
	if (!box) return content;
	lines[line] = `${box[1]}${done ? "x" : " "}${box[3]}${box[4]}`;
	return lines.join("\n");
}

/** Vervangt het beheerde stuk en laat alles eronder staan. */
export function replaceCookRegion(content: string, input: SessionInput): string {
	const lines = content.split(/\r?\n/);
	const body = renderRegion(input);

	let from = -1;
	let to = lines.length;
	for (let index = 0; index < lines.length; index += 1) {
		const heading = HEADING.exec(lines[index] ?? "");
		if (!heading) continue;
		const title = (heading[1] ?? "").trim().toLowerCase();
		if (from === -1 && title.startsWith("ingredient")) {
			from = index;
			continue;
		}
		if (from !== -1 && !title.startsWith("method") && !title.startsWith("bereiding")) {
			to = index;
			break;
		}
	}

	if (from === -1) return `${content.trimEnd()}\n\n${body.join("\n")}\n`;
	return [...lines.slice(0, from), ...body, ...lines.slice(to)].join("\n");
}

/** Het aantal porties in de frontmatter bijwerken. */
export function setServings(content: string, servings: number): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return content;
	const block = match[1] ?? "";
	const next = /^servings\s*:.*$/m.test(block)
		? block.replace(/^servings\s*:.*$/m, `servings: ${servings}`)
		: `${block}\nservings: ${servings}`;
	return content.replace(block, next);
}

function readFrontmatterNumber(content: string, key: string): number | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return null;
	const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(match[1] ?? "");
	if (!line) return null;
	const value = parseNumber(line[1]);
	return value !== null && value > 0 ? value : null;
}

function readRecipeLink(content: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return null;
	const line = /^recipe\s*:\s*(.*)$/m.exec(match[1] ?? "");
	if (!line) return null;
	const link = LINK_TARGET.exec(line[1] ?? "");
	return link ? (link[1] ?? "").trim() : (line[1] ?? "").trim().replace(/^["']|["']$/g, "") || null;
}
