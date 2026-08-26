/**
 * Dragging rows into a new order, with one code path for mouse and finger.
 *
 * Two things make this survive real use. The move and up listeners live on the
 * window, not on the grip: the row is re-inserted in the DOM while you drag, and
 * a browser drops pointer capture the moment the capturing element leaves the
 * document, which silently killed the drag after the very first swap. And the
 * dragged row is translated to follow the pointer, so what you see under your
 * finger is the row itself rather than a list that jumps when it feels like it.
 *
 * The drag starts anywhere on the row except on a control, so the grip is a
 * hint, not a requirement.
 */
export interface RowDragSpec {
	/** The scrollable row container. */
	list: HTMLElement;
	/** Selector matching the draggable rows inside it. */
	rowSelector: string;
	/** Called once, when the pointer lifts, with the rows in their new order. */
	commit: (rows: HTMLElement[]) => void;
	/** Optional: called after every move, to renumber or relabel. */
	onMove?: (rows: HTMLElement[]) => void;
}

/** How far the pointer must travel before this counts as a drag and not a tap. */
const THRESHOLD = 4;

function rowsOf(spec: RowDragSpec): HTMLElement[] {
	return Array.from(spec.list.querySelectorAll<HTMLElement>(spec.rowSelector));
}

/** A press on a button, link or field is that control's business, not a drag. */
function isControl(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return target.closest("button, a, input, textarea, select") !== null;
}

export function enableRowDrag(
	handle: HTMLElement,
	row: HTMLElement,
	spec: RowDragSpec
): void {
	const start = (event: PointerEvent): void => {
		if (event.button !== 0 && event.pointerType === "mouse") return;
		if (isControl(event.target)) return;

		const startY = event.clientY;
		// Where inside the row the pointer landed, so the row does not jump.
		const grabOffset = startY - row.getBoundingClientRect().top;
		let dragging = false;

		const place = (pointerY: number): void => {
			// Read the row's own position with the transform cleared, so the
			// offset stays honest after every re-insertion.
			row.style.transform = "";
			const top = row.getBoundingClientRect().top;
			row.style.transform = `translateY(${pointerY - grabOffset - top}px)`;
		};

		const begin = (): void => {
			dragging = true;
			row.addClass("is-dragging");
			spec.list.addClass("is-reordering");
		};

		const move = (moveEvent: PointerEvent): void => {
			if (moveEvent.pointerId !== event.pointerId) return;
			if (!dragging) {
				if (Math.abs(moveEvent.clientY - startY) < THRESHOLD) return;
				begin();
			}
			moveEvent.preventDefault();

			const pointerY = moveEvent.clientY;
			for (const other of rowsOf(spec)) {
				if (other === row) continue;
				const box = other.getBoundingClientRect();
				const middle = box.top + box.height / 2;
				const rowIsAfter =
					(other.compareDocumentPosition(row) &
						Node.DOCUMENT_POSITION_FOLLOWING) !==
					0;

				if (pointerY < middle && rowIsAfter) {
					spec.list.insertBefore(row, other);
					break;
				}
				if (pointerY > middle && !rowIsAfter) {
					spec.list.insertBefore(row, other.nextSibling);
					break;
				}
			}

			place(pointerY);
			spec.onMove?.(rowsOf(spec));
		};

		const stop = (stopEvent: PointerEvent): void => {
			if (stopEvent.pointerId !== event.pointerId) return;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			row.style.transform = "";
			row.removeClass("is-dragging");
			spec.list.removeClass("is-reordering");
			if (dragging) spec.commit(rowsOf(spec));
		};

		window.addEventListener("pointermove", move, { passive: false });
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	};

	// The grip is where a finger is meant to land, so it never scrolls the pane;
	// the rest of the row waits for a deliberate vertical move before taking over.
	handle.addEventListener("pointerdown", start);
	row.addEventListener("pointerdown", (event: PointerEvent) => {
		if (handle.contains(event.target as Node)) return;
		start(event);
	});
}
