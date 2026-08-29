const MS_PER_DAY = 86_400_000;

export const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/** Strips the time part so date maths never trips over daylight saving. */
export function atMidnight(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
	const next = atMidnight(date);
	next.setDate(next.getDate() + days);
	return next;
}

/** First day of the week containing `date`, honouring the configured start day. */
export function startOfWeek(date: Date, weekStartDay: number): Date {
	const day = atMidnight(date);
	const offset = (day.getDay() - weekStartDay + 7) % 7;
	return addDays(day, -offset);
}

/** yyyy-mm-dd in local time. */
export function toISODate(date: Date): string {
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function fromISODate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (Number.isNaN(date.getTime())) return null;
	// `new Date(2026, 1, 30)` rolt stilletjes door naar 2 maart. Een
	// handgetypte `weekStart: 2026-02-30` ankerde de planner daarmee op een
	// andere week dan er stond. Terugrekenen is de enige controle die telt.
	return toISODate(date) === value.trim() ? date : null;
}

export function isSameDay(a: Date, b: Date): boolean {
	return toISODate(a) === toISODate(b);
}

/**
 * ISO 8601 week number and week-year. Taken from the middle of the week so the
 * result stays stable no matter which day the user starts their week on.
 */
export function isoWeek(weekStart: Date): { year: number; week: number } {
	const target = addDays(weekStart, 3);
	const thursday = new Date(target.getTime());
	thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
	const firstThursday = new Date(thursday.getFullYear(), 0, 4);
	firstThursday.setDate(
		firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7)
	);
	const week =
		1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
	return { year: thursday.getFullYear(), week };
}

/** e.g. "2026-W35" */
export function weekId(weekStart: Date): string {
	const { year, week } = isoWeek(weekStart);
	return `${year}-W${`${week}`.padStart(2, "0")}`;
}

export function formatDayHeader(date: Date): { weekday: string; day: string } {
	return {
		weekday: WEEKDAY_NAMES[date.getDay()] ?? "",
		day: `${date.getDate()}`,
	};
}

export function formatRange(weekStart: Date): string {
	const end = addDays(weekStart, 6);
	const sameMonth = weekStart.getMonth() === end.getMonth();
	const month = (d: Date) =>
		d.toLocaleDateString("en-GB", { month: "long" });
	if (sameMonth) {
		return `${weekStart.getDate()}–${end.getDate()} ${month(end)} ${end.getFullYear()}`;
	}
	return `${weekStart.getDate()} ${month(weekStart)} – ${end.getDate()} ${month(end)} ${end.getFullYear()}`;
}
