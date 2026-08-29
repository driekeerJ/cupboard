/**
 * Wat er tussen de receptenlijst en de planner heen en weer gesleept wordt.
 *
 * Stond in `planner.ts`, en daardoor liep er een echte importcyclus:
 * planner → add-recipe-modal → recipe-list → planner. Vandaag brak er niets,
 * omdat `DRAG_MIME` een top-level const is — maar zodra iemand in
 * `recipe-list.ts` iets uit `planner.ts` op modulenivo gebruikt, geeft die
 * cyclus een `undefined` bij het laden die esbuild niet meldt.
 */
export const DRAG_MIME = "text/plain";

export type DragPayload =
	| { kind: "recipe"; name: string }
	| { kind: "planned"; date: string; meal: string; index: number };

export function readPayload(event: DragEvent): DragPayload | null {
	const raw = event.dataTransfer?.getData(DRAG_MIME);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as DragPayload;
		return parsed && typeof parsed === "object" && "kind" in parsed ? parsed : null;
	} catch {
		return null;
	}
}
