import type { DragPayload } from "./drag";

/** How long a finger must rest on a card before the drag takes over. */
const LONG_PRESS_MS = 380;
/** Moving further than this first means the user is scrolling, not dragging. */
const MOVE_TOLERANCE = 10;
/** Distance from an edge at which the surrounding list starts scrolling. */
const EDGE_ZONE = 76;
const EDGE_SPEED = 13;

export interface TouchDragSpec {
	/** What is being dragged, read at the moment the drag starts. */
	payload: () => DragPayload;
	/** Text for the ghost that follows the finger. */
	label: () => string;
	/** Called when the finger lifts over a slot. */
	drop: (payload: DragPayload, date: string, meal: string) => void;
}

/** Nearest ancestor that actually scrolls, so edge scrolling has something to move. */
function scrollParent(element: HTMLElement): HTMLElement | null {
	let node: HTMLElement | null = element.parentElement;
	while (node) {
		const overflow = window.getComputedStyle(node).overflowY;
		const scrolls = overflow === "auto" || overflow === "scroll";
		if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
		node = node.parentElement;
	}
	return null;
}

function edgeSpeed(scroller: HTMLElement | null, y: number): number {
	if (!scroller) return 0;
	const box = scroller.getBoundingClientRect();
	const top = Math.max(box.top, 0);
	const bottom = Math.min(box.bottom, window.innerHeight);
	if (y < top + EDGE_ZONE) return -EDGE_SPEED;
	if (y > bottom - EDGE_ZONE) return EDGE_SPEED;
	return 0;
}

/**
 * Touch has no HTML5 drag and drop, so press-and-hold starts a drag we run
 * ourselves: a ghost follows the finger, the slot underneath lights up, and the
 * list scrolls when the finger nears an edge. A short tap is left alone, so the
 * card's own click handler keeps working.
 */
export function enableTouchDrag(card: HTMLElement, spec: TouchDragSpec): void {
	let timer = 0;
	let frame = 0;
	let startX = 0;
	let startY = 0;
	let dragging = false;
	let speed = 0;
	let ghost: HTMLElement | null = null;
	let target: HTMLElement | null = null;
	let scroller: HTMLElement | null = null;

	const cancelTimer = (): void => {
		if (!timer) return;
		window.clearTimeout(timer);
		timer = 0;
	};

	const stopScrolling = (): void => {
		if (frame) window.cancelAnimationFrame(frame);
		frame = 0;
		speed = 0;
	};

	const step = (): void => {
		frame = 0;
		if (!dragging) return;
		// De kaart kan tijdens de sleep uit de DOM verdwijnen — een redraw van
		// het rooster is genoeg. Zijn eigen touchend komt dan nooit meer, en
		// deze lus plande zichzelf oneindig opnieuw in.
		if (!card.isConnected) {
			finish(false);
			return;
		}
		if (speed !== 0 && scroller) scroller.scrollTop += speed;
		frame = window.requestAnimationFrame(step);
	};

	const placeGhost = (x: number, y: number): void => {
		if (!ghost) return;
		ghost.style.left = `${Math.round(x)}px`;
		ghost.style.top = `${Math.round(y)}px`;
	};

	const highlight = (x: number, y: number): void => {
		const under = document.elementFromPoint(x, y);
		const slot =
			under instanceof Element
				? under.closest<HTMLElement>(".pantry-slot")
				: null;
		if (slot === target) return;
		target?.removeClass("is-drop-target");
		target = slot;
		target?.addClass("is-drop-target");
	};

	// Op window en niet op de kaart: een kaart die tijdens de sleep vervangen
	// wordt neemt haar eigen listeners mee, en dan eindigt de sleep nooit.
	// Alleen aangehangen zolang er gesleept wordt, zodat ze niet opstapelen bij
	// elke hertekening van het rooster.
	const endDrag = (): void => finish(true);
	const cancelDrag = (): void => finish(false);

	const begin = (x: number, y: number): void => {
		dragging = true;
		window.addEventListener("touchend", endDrag);
		window.addEventListener("touchcancel", cancelDrag);
		card.addClass("is-touch-dragging");
		scroller = scrollParent(card);
		ghost = document.body.createDiv({
			cls: "pantry-drag-ghost",
			text: spec.label(),
		});
		placeGhost(x, y);
		highlight(x, y);
		frame = window.requestAnimationFrame(step);
	};

	/** Eats the click the browser fires after a drag, so the panel stays shut. */
	const swallowNextClick = (): void => {
		const swallow = (event: Event): void => {
			event.preventDefault();
			event.stopPropagation();
		};
		card.addEventListener("click", swallow, true);
		window.setTimeout(() => card.removeEventListener("click", swallow, true), 400);
	};

	const finish = (drop: boolean): void => {
		cancelTimer();
		stopScrolling();
		if (!dragging) return;
		dragging = false;

		window.removeEventListener("touchend", endDrag);
		window.removeEventListener("touchcancel", cancelDrag);
		card.removeClass("is-touch-dragging");
		ghost?.remove();
		ghost = null;

		const slot = target;
		target?.removeClass("is-drop-target");
		target = null;
		scroller = null;
		swallowNextClick();

		if (!drop || !slot) return;
		const { date, meal } = slot.dataset;
		if (!date || !meal) return;
		spec.drop(spec.payload(), date, meal);
	};

	card.addEventListener(
		"touchstart",
		(event: TouchEvent) => {
			if (event.touches.length !== 1) return;
			const touch = event.touches[0];
			startX = touch.clientX;
			startY = touch.clientY;
			cancelTimer();
			timer = window.setTimeout(() => {
				timer = 0;
				begin(startX, startY);
			}, LONG_PRESS_MS);
		},
		{ passive: true }
	);

	card.addEventListener(
		"touchmove",
		(event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch) return;

			if (!dragging) {
				const moved =
					Math.abs(touch.clientX - startX) > MOVE_TOLERANCE ||
					Math.abs(touch.clientY - startY) > MOVE_TOLERANCE;
				if (moved) cancelTimer();
				return;
			}

			// Keep the gesture, or the list scrolls away under the finger.
			event.preventDefault();
			placeGhost(touch.clientX, touch.clientY);
			highlight(touch.clientX, touch.clientY);
			speed = edgeSpeed(scroller, touch.clientY);
		},
		{ passive: false }
	);

	// De kaart houdt alleen de start bij; het einde loopt via window, zie begin().
	card.addEventListener("touchend", () => cancelTimer());
	card.addEventListener("touchcancel", () => finish(false));
}
