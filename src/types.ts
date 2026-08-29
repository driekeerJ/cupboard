/** A person who eats along. Portion factor lets a child count as half an adult. */
export interface HouseholdMember {
	id: string;
	name: string;
	portionFactor: number;
}

/** A user defined meal moment, e.g. "Breakfast" or "Late night snack". */
export interface MealType {
	id: string;
	name: string;
}

export interface PantrySettings {
	/** Folder that holds the recipe notes. Everything inside it is a recipe. */
	recipeFolder: string;
	/** Folder the weekly plan notes are written to. */
	planFolder: string;
	/** Folder that holds the product notes: the base list of what you stock. */
	productFolder: string;
	/** Note the grocery list is mirrored into. */
	listNote: string;
	/**
	 * JSON in de vault met de lopende boodschappenronde: wat er in het mandje
	 * ligt en wat de telling ervóór was. In de vault en niet in `data.json`,
	 * zodat Obsidian Sync hem meeneemt van laptop naar telefoon.
	 */
	shoppingState: string;
	/** Folder holding one note per shop, each listing its shelves in order. */
	shopFolder: string;
	/** 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
	weekStartDay: number;
	meals: MealType[];
	/**
	 * Map met één notitie per huisgenoot, met `portionFactor` in de
	 * frontmatter. Leeg betekent: het gezin staat alleen in `data.json`.
	 */
	householdFolder: string;
	/**
	 * Het gezin zoals het in `data.json` staat. Alleen leidend zolang
	 * `householdFolder` leeg is of nog geen notities bevat — zie
	 * `HouseholdIndex`.
	 */
	household: HouseholdMember[];
	/** Frontmatter fields shown on a recipe card. */
	displayFields: string[];
	/** Frontmatter field holding the number of servings a recipe is written for. */
	servingsField: string;
	setupComplete: boolean;
	/** Folder the cook session notes are written to. */
	cookFolder: string;
	/** Sessions older than this are cleaned up on start. 0 keeps them forever. */
	cookKeepDays: number;
	/**
	 * Lopende timers per kooksessie-notitie.
	 *
	 * Het enige stukje kookmodus dat níet in de notitie staat. Een timer is een
	 * tijdstip, geen tekst: hem in het bestand zetten maakt de notitie
	 * onleesbaar en levert bij handmatig bewerken alleen maar onzin op.
	 */
	cookTimers: Record<string, Record<string, TimerState>>;
}

/** A timer as stored: the moment it started, not a countdown. */
export interface TimerState {
	startedAt: number;
	seconds: number;
}

/**
 * What happened to a planned meal. Absent means "still to come": it counts for
 * the grocery list and it is what the home screen asks you about.
 */
export type MealStatus = "eaten" | "skipped";

/** One recipe planned into one meal slot. */
export interface PlannedRecipe {
	/** Vault path of the recipe note. */
	recipe: string;
	/** Ids of the household members eating this. */
	eaters: string[];
	/** Extra guests, each counting as one full portion. */
	guests: number;
	/** Eaten or skipped. Absent while the meal is still ahead of you. */
	status?: MealStatus;
	/**
	 * Exactly what was taken off stock when this was marked eaten, in the unit
	 * that product is counted in. Kept so undoing the tick puts back what was
	 * actually booked, even if the recipe changed since.
	 *
	 * De sleutel is een wikilink (`[[Rijst]]`) in de notitie en een pad zolang
	 * hij in het geheugen zit; oudere blokken hebben er een pad staan en die
	 * blijven werken. Zie `PlanStore.describeUsed` en `consume.apply`.
	 */
	used?: Record<string, number>;
}

export interface PlannedMeal {
	meal: string;
	recipes: PlannedRecipe[];
}

export interface PlannedDay {
	/** ISO date, yyyy-mm-dd. */
	date: string;
	/**
	 * Free text for what the calendar says about this day: training, guests,
	 * home late. Written by hand in the planner, never derived.
	 */
	note?: string;
	meals: PlannedMeal[];
}

export interface WeekPlan {
	/** ISO date of the first day of the week. */
	weekStart: string;
	days: PlannedDay[];
}
