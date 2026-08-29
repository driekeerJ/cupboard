/**
 * Welk ingrediënt hoort bij welke stap.
 *
 * Recepten zeggen dat nergens, dus het wordt geraden: de naam van het
 * ingrediënt opzoeken in de staptekst, en de eerste stap waarin hij voorkomt
 * wint. Dat is precies hoe een kok het zelf doet bij de mise en place — alles
 * wat in stap 1 nodig is ligt vóór stap 1 klaar.
 *
 * Het raden is bewust voorzichtig. Een gemiste koppeling zet het ingrediënt in
 * de groep "Rest" en dat is zichtbaar; een verkeerde koppeling zet de ui bij
 * stap 6 en dat merk je pas met een hete pan. Daarom alleen hele woorden, en
 * alleen kandidaten die iets zeggen: de volledige productnaam en het hoofdwoord
 * (het laatste betekenisdragende woord), met de gewone Nederlandse
 * meervoudsvormen erbij.
 */

import { parseIngredient } from "./ingredients";

/** Woorden die niets over het product zeggen en dus nooit alleen mogen matchen. */
const NOISE_WORDS = new Set([
	"de", "het", "een", "en", "of", "van", "met", "voor", "naar", "smaak",
	"the", "a", "an", "and", "or", "of", "to", "taste",
	"ah", "jumbo", "lidl", "aldi", "terra", "bio", "biologisch", "biologische",
	"plantaardig", "plantaardige", "ongezoet", "ongezoete", "vers", "verse",
	"naturel", "mild", "milde", "extra", "grof", "grove", "fijn", "fijne",
	"groot", "grote", "klein", "kleine", "los", "losse", "puur", "pure",
]);

/**
 * Woorden die in bijna elk recept voorkomen. Ze zeggen wél iets, maar niet
 * genoeg om er een stap aan op te hangen: "groenten" staat in vier van de acht
 * stappen en zou het bouillonblokje bij de verkeerde zetten.
 */
const GENERIC_WORDS = new Set([
	"groente", "groenten", "vlokken", "blokjes", "deelblokjes", "stukjes",
	"stukken", "partjes", "reepjes", "plakjes", "ringen", "poeder", "mix",
	"zak", "zakje", "pot", "potje", "blik", "blikje", "pak", "pakje",
	"saus", "olie", "water", "kruiden", "chunks", "dark", "sugar", "no",
]);

/** Onder deze lengte is een woord te kort om als los bewijs te dienen. */
const MIN_WORD = 3;
/** Vanaf hier telt een woord als sterk bewijs en mag het als eerste ronde mee. */
const STRONG_WORD = 6;
/** Vanaf deze lengte mag het ene woord in het andere zitten. */
const PREFIX_LENGTH = 5;
const INSIDE_LENGTH = 6;
/** Zoveel beginletters moeten twee lange woorden delen om hetzelfde te heten. */
const SHARED_PREFIX = 7;

function normalise(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[\u2019'`]/g, "")
		.replace(/[^a-z0-9\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** De wikilinkdoelen in een regel: de schrijver die precies was. */
function linkTargets(line: string): string[] {
	const found: string[] = [];
	const pattern = /\[\[([^\]]+)\]\]/g;
	let match = pattern.exec(line);
	while (match) {
		const inner = match[1].split("|")[0];
		if (inner) found.push(inner.trim());
		match = pattern.exec(line);
	}
	return found;
}

/**
 * "uien" moet "de ui" vinden en "boon" moet "de bonen" vinden. Geen stemmer,
 * maar de handvol vormen die in een receptzin voorkomen.
 */
export function wordForms(word: string): string[] {
	const forms = new Set<string>([word]);

	if (word.endsWith("en") && word.length > 3) {
		const stem = word.slice(0, -2);
		forms.add(stem);
		// bo-nen -> boon, pe-ren -> peer: de open lettergreep sluit weer.
		const open = /^(.*[^aeiou])([aeiou])([bcdfgklmnprstvz])$/.exec(stem);
		if (open) forms.add(`${open[1]}${open[2]}${open[2]}${open[3]}`);
		// ui-en -> ui staat er al via de stam.
	}
	if (word.endsWith("s") && word.length > 3) forms.add(word.slice(0, -1));
	if (word.endsWith("es") && word.length > 4) forms.add(word.slice(0, -2));
	forms.add(`${word}s`);
	forms.add(`${word}en`);

	return [...forms].filter((form) => form.length >= 2);
}

export interface SearchTerms {
	/** De volledige naam en de lange woorden erin: hier mag je op afgaan. */
	strong: string[];
	/** Korte woorden: alleen als de sterke ronde niets vond. */
	weak: string[];
}

/** Waar we op zoeken voor één ingrediënt.  */
export function searchTerms(line: string): SearchTerms {
	const names = linkTargets(line);
	if (names.length === 0) {
		const parsed = parseIngredient(line);
		if (parsed.name.trim()) names.push(parsed.name);
	}

	const strong = new Set<string>();
	const weak = new Set<string>();

	for (const name of names) {
		const clean = normalise(name);
		if (!clean) continue;
		const words = clean
			.split(/[\s-]+/)
			.filter((word) => word.length > 0 && !NOISE_WORDS.has(word));
		if (words.length === 0) continue;

		// De volledige naam zonder ruiswoorden, als die uit meer bestaat dan
		// één woord: "zwarte peper" is preciezer dan "peper".
		if (words.length > 1) strong.add(words.join(" "));

		for (const word of words) {
			if (GENERIC_WORDS.has(word) || word.length < MIN_WORD) continue;
			const bucket = word.length >= STRONG_WORD ? strong : weak;
			for (const form of wordForms(word)) bucket.add(form);
		}
	}

	return {
		strong: [...strong],
		weak: [...weak].filter((term) => !strong.has(term)),
	};
}

const LETTER = /[a-z0-9]/;

function isLetter(char: string | undefined): boolean {
	return char !== undefined && LETTER.test(char);
}

/** Hoeveel beginletters twee woorden delen. */
function sharedPrefix(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let shared = 0;
	while (shared < limit && a[shared] === b[shared]) shared += 1;
	return shared;
}

/**
 * Komt de term voor in de stap, als heel woord of als helft van een
 * samenstelling? Nederlands plakt aan elkaar: het bouillonblokje wordt
 * "bouillon", de citroen wordt "citroenrasp", het laurierblad wordt
 * "laurierblaadjes". Zonder die regel valt een vijfde van de lijst buiten de
 * boot.
 */
function matches(stepWords: string[], haystack: string, term: string): boolean {
	if (term.includes(" ")) {
		// Meerwoordsnamen alleen letterlijk, op woordgrenzen.
		let from = 0;
		for (;;) {
			const at = haystack.indexOf(term, from);
			if (at < 0) return false;
			if (!isLetter(haystack[at - 1]) && !isLetter(haystack[at + term.length])) {
				return true;
			}
			from = at + 1;
		}
	}

	return stepWords.some((word) => {
		if (word === term) return true;
		const short = word.length < term.length ? word : term;
		const long = word.length < term.length ? term : word;
		// "brood" in "broodjes", "cacao" in "cacaopoeder".
		if (short.length >= PREFIX_LENGTH && long.startsWith(short)) return true;
		// "mosterd" in "dijonmosterd", "suiker" in "rietsuiker".
		if (short.length >= INSIDE_LENGTH && long.includes(short)) return true;
		// "laurierblad" en "laurierblaadjes" lopen pas na tien letters uiteen.
		if (short.length >= SHARED_PREFIX && sharedPrefix(word, term) >= SHARED_PREFIX) {
			return true;
		}
		return false;
	});
}

export interface IngredientGroup {
	/** Het stapnummer waar deze groep bij hoort, of null voor "Rest". */
	step: number | null;
	/** Posities in de oorspronkelijke ingrediëntenlijst — vinkjes hangen eraan. */
	indexes: number[];
}

/**
 * De ingrediëntenlijst opgedeeld naar stap, in de volgorde van de stappen, met
 * ongekoppelde ingrediënten in een laatste groep. Binnen een groep blijft de
 * volgorde van het recept staan.
 *
 * Geeft `null` terug als groeperen niets oplevert — geen stappen, of niets dat
 * matcht. Dan is een platte lijst eerlijker dan één groep "Rest".
 */
export function groupIngredientsByStep(
	ingredients: string[],
	steps: string[]
): IngredientGroup[] | null {
	if (ingredients.length === 0 || steps.length === 0) return null;

	const haystacks = steps.map((step) => normalise(step));
	const stepWords = haystacks.map((haystack) =>
		haystack.split(/[\s-]+/).filter((word) => word.length > 0)
	);
	const assigned = new Map<number, number>();

	const assign = (index: number, terms: string[]): boolean => {
		for (let step = 0; step < haystacks.length; step += 1) {
			const haystack = haystacks[step] ?? "";
			const words = stepWords[step] ?? [];
			if (terms.some((term) => matches(words, haystack, term))) {
				assigned.set(index, step);
				return true;
			}
		}
		return false;
	};

	const terms = ingredients.map((line) => searchTerms(line));
	// Eerst de sterke ronde over alle ingrediënten. Een zwak woord dat toevallig
	// in stap 1 staat mag een sterke treffer in stap 3 niet voor zijn.
	ingredients.forEach((_line, index) => {
		assign(index, terms[index]?.strong ?? []);
	});
	ingredients.forEach((_line, index) => {
		if (!assigned.has(index)) assign(index, terms[index]?.weak ?? []);
	});

	if (assigned.size === 0) return null;

	const groups: IngredientGroup[] = [];
	steps.forEach((_step, step) => {
		const indexes = ingredients
			.map((_line, index) => index)
			.filter((index) => assigned.get(index) === step);
		if (indexes.length > 0) groups.push({ step, indexes });
	});

	const rest = ingredients
		.map((_line, index) => index)
		.filter((index) => !assigned.has(index));
	if (rest.length > 0) groups.push({ step: null, indexes: rest });

	return groups;
}
