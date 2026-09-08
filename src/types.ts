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
	/**
	 * Map met één notitie per boodschappenlijst: de keuzes en het mandje in
	 * de frontmatter, de afvinklijst in de body. In de vault en niet in
	 * `data.json`, zodat Obsidian Sync alles meeneemt naar je telefoon.
	 */
	shoppingFolder: string;
	/** Folder holding one note per shop, each listing its shelves in order. */
	shopFolder: string;
	/** 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
	weekStartDay: number;
	/**
	 * Hoeveel dagen vooruit de boodschappenlijst kijkt, vanaf vandaag.
	 *
	 * Niet "deze week": een weekplan is een notitie per week, maar boodschappen
	 * doen is dat niet. Wie op woensdag bestelt voor tot en met volgende week
	 * dinsdag kijkt over de weekgrens heen, en een lijst die op zondag stopt
	 * mist dan de helft.
	 */
	horizonDays: number;
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

/**
 * Een moment waarop de boodschappen van één winkel in huis komen — of je er
 * nu heen loopt of het bezorgd wordt. Vanaf dit punt in het plan is alles wat
 * je daar koopt beschikbaar, en daarvóór niet.
 *
 * De positie in de dag staat als een maaltijdnaam plus "ervoor" of "erna", en
 * niet als een klok: het plan denkt in maaltijden, en een bezorging om 17:45
 * zegt niets zolang je niet weet hoe laat er gegeten wordt.
 */
export interface ShoppingStop {
	/** Naam van de winkel, zoals de winkelnotitie heet. */
	shop: string;
	/** Maaltijd waar dit moment aan hangt. Leeg = het begin van de dag. */
	meal?: string;
	/** Ervoor of erna. Standaard "before". */
	when?: "before" | "after";
}

export interface PlannedDay {
	/** ISO date, yyyy-mm-dd. */
	date: string;
	/**
	 * Free text for what the calendar says about this day: training, guests,
	 * home late. Written by hand in the planner, never derived.
	 */
	note?: string;
	/**
	 * Wanneer er die dag boodschappen in huis komen. Meerdere winkels op één
	 * dag mag: de Lidl om elf uur en de bezorging na het avondeten.
	 */
	shopping?: ShoppingStop[];
	meals: PlannedMeal[];
}

export interface WeekPlan {
	/** ISO date of the first day of the week. */
	weekStart: string;
	days: PlannedDay[];
}
