/**
 * The demo vault is written for week 39 of 2026. Cupboard shows the week of
 * today, so a demo that stays in week 39 photographs an empty planner and
 * tests an empty shopping list as soon as that week is past. Both the
 * screenshots and the e2e checks therefore move every demo date by whole
 * weeks, so that demo week 39 becomes the current week.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEMO_MONDAY = "2026-09-21"; // demo week 39

function isoDate(date) {
	return date.toISOString().slice(0, 10);
}

function mondayOf(date) {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d;
}

export function isoWeek(iso) {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
	const week = 1 + Math.round((d - firstThursday) / (7 * 864e5));
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Days between demo week 39 and this week; always whole weeks. */
export const SHIFT = Math.round((mondayOf(new Date()) - new Date(`${DEMO_MONDAY}T00:00:00Z`)) / 864e5);

export function shiftDate(iso) {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + SHIFT);
	return isoDate(d);
}

const shiftAll = (text) => text.replace(/\b20\d\d-\d\d-\d\d\b/g, shiftDate);

/** A demo path with its dates moved: `Meal plans/2026-W39.md` and the like. */
export function shiftPath(path) {
	const week = path.match(/(\d{4})-W(\d\d)/);
	if (!week) return shiftAll(path);
	// Monday of that ISO week, moved, and named again.
	const jan4 = new Date(Date.UTC(Number(week[1]), 0, 4));
	jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(week[2]) - 1) * 7);
	return path.replace(week[0], isoWeek(shiftDate(isoDate(jan4))));
}

/** Moves the dates in the notes that carry them, inside a copied demo vault. */
export function shiftVault(vault) {
	for (const folder of ["Meal plans", "Cupboard/Shopping", "Products"]) {
		const dir = join(vault, folder);
		for (const name of readdirSync(dir)) {
			let text = shiftAll(readFileSync(join(dir, name), "utf8"));
			let renamed = shiftAll(name);
			const week = text.match(/^weekStart: (\S+)$/m);
			if (week) {
				const [oldWeek] = text.match(/\d{4}-W\d\d/);
				const newWeek = isoWeek(week[1]);
				text = text.replaceAll(oldWeek, newWeek).replace(/week \d+/, `week ${Number(newWeek.slice(6))}`);
				renamed = `${newWeek}.md`;
			}
			rmSync(join(dir, name));
			writeFileSync(join(dir, renamed), text);
		}
	}
}
