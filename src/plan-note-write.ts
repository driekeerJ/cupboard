import { MarkdownView, TFile, type App } from "obsidian";

/**
 * Het schrijven van het meal-plan-blok in een notitie die openstaat.
 *
 * Dit stond in `plan.ts`, tussen `parse`, `serialise` en `addRecipe` — zestig
 * regels UI-gedrag in de module die je opent als je iets aan het planformaat
 * wilt veranderen. Het zijn ook de fragielste regels van het project: ze
 * bewegen de cursor en de scrollpositie van iemand die op dat moment aan het
 * lezen is. Apart, zodat je ze kunt lezen zonder het planformaat erbij, en het
 * planformaat zonder deze trucs.
 */

/** De markdown-views die precies dit bestand tonen. */
export function viewsFor(app: App, file: TFile): MarkdownView[] {
	return app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view)
		.filter(
			(view): view is MarkdownView =>
				view instanceof MarkdownView && view.file === file
		);
}

/**
 * Replaces just the block through the editor, so the surrounding text, the
 * cursor and the scroll position all stay exactly where they were.
 *
 * Geeft de nieuwe inhoud terug als het gelukt is, en null als de notitie niet
 * openstaat om te bewerken — de aanroeper onthoudt die inhoud, want de editor
 * flusht pas seconden later naar schijf.
 */
export function writeThroughEditor(
	app: App,
	file: TFile,
	block: string,
	pattern: RegExp
): string | null {
	for (const view of viewsFor(app, file)) {
		if (view.getMode() !== "source") continue;

		const editor = view.editor;
		const content = editor.getValue();
		const match = pattern.exec(content);
		if (!match) continue;
		if (match[0] === block) return content;

		const scroll = editor.getScrollInfo();
		editor.replaceRange(
			block,
			editor.offsetToPos(match.index),
			editor.offsetToPos(match.index + match[0].length)
		);

		// Live Preview tears the rendered block down and builds it again, so
		// the position is put back once more after that has settled.
		const restore = (): void => editor.scrollTo(scroll.left, scroll.top);
		restore();
		window.requestAnimationFrame(restore);
		return editor.getValue();
	}
	return null;
}

/**
 * Reading view re-renders the block after a write and can lose its place, so
 * the scroll offset is put back once the new content has been laid out.
 */
export function capturePreviewScroll(app: App, file: TFile): () => void {
	const views = viewsFor(app, file).filter((view) => view.getMode() === "preview");
	if (views.length === 0) return () => undefined;

	const offsets = views.map((view) => view.currentMode.getScroll());
	return () => {
		const apply = (): void =>
			views.forEach((view, index) => view.currentMode.applyScroll(offsets[index] ?? 0));
		apply();
		window.setTimeout(apply, 120);
	};
}
