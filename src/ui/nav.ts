import { ItemView, setIcon } from "obsidian";

export const HOME_VIEW_TYPE = "pantry-home";

/**
 * Pantry is five screens, and moving between them should feel like one app
 * rather than five tabs. Every screen therefore replaces the one before it in
 * the same leaf, and carries the same way back.
 *
 * The constant lives here rather than in the home view so that a screen can
 * import the way home without importing the home screen itself.
 */
export async function openHere(
	view: ItemView,
	type: string,
	state?: Record<string, unknown>
): Promise<void> {
	await view.leaf.setViewState({ type, active: true, state: state ?? {} });
}

/** The way back, drawn as the first thing in a screen's header. */
export function drawBackLink(parent: HTMLElement, view: ItemView): HTMLElement {
	const back = parent.createEl("button", { cls: "pantry-back" });
	setIcon(back.createSpan({ cls: "pantry-back-icon" }), "arrow-left");
	back.createSpan({ cls: "pantry-back-label", text: "Pantry" });
	back.setAttr("aria-label", "Back to Pantry");
	back.onclick = () => void openHere(view, HOME_VIEW_TYPE);
	return back;
}
