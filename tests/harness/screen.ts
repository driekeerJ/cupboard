/**
 * Een scherm van Cupboard openen in een test, zonder Obsidian.
 *
 * `makeHarness` zet de echte indexen op een neppe vault; dit zet daar de
 * echte schermklassen bovenop, in de DOM uit `dom.ts`. Een test opent een
 * scherm, leest wat er staat, klikt, en kijkt wat er in de notities kwam —
 * dezelfde vragen als de e2e, in milliseconden in plaats van minuten.
 *
 * Zie `dom.ts` voor wat dit wel en niet bewijst.
 */
import type PantryPlugin from "../../src/main";
import type { PantrySettings } from "../../src/types";
import { ViewMemory } from "../../src/ui/view-memory";
import { installDom, settle } from "./dom";
import { WorkspaceLeaf } from "./obsidian";
import { makeHarness, type Harness } from "./plugin";

/** Wat een scherm minimaal is: iets met een `contentEl` dat open kan. */
interface Screen {
	contentEl: HTMLElement;
	app: unknown;
	onOpen(): Promise<void>;
	setState?(state: unknown, result: unknown): Promise<void>;
	refresh?(): void;
}

export interface Opened<T extends Screen> {
	view: T;
	/** Waar het scherm zichzelf in tekent. */
	root: HTMLElement;
	/** De tab; `leaf.opened` zegt waar een klik naartoe navigeerde. */
	leaf: WorkspaceLeaf;
}

export interface ScreenHarness extends Harness {
	/**
	 * Opent een scherm zoals Obsidian dat doet: aanmaken, staat meegeven als
	 * die er is, en wachten tot het zichzelf getekend heeft.
	 */
	open<T extends Screen>(
		View: new (leaf: never, plugin: PantryPlugin) => T,
		state?: Record<string, unknown>
	): Promise<Opened<T>>;
}

export function makeScreenHarness(
	files: Record<string, string>,
	settings: Partial<PantrySettings> = {}
): ScreenHarness {
	installDom();
	const harness = makeHarness(files, settings);
	const plugin = harness.plugin;
	const views: Screen[] = [];

	plugin.ui = new ViewMemory();
	// Net als in main.ts: wie iets wijzigt laat elk open scherm zich hertekenen.
	plugin.refreshViews = (): void => {
		for (const view of views) view.refresh?.();
	};
	// De neppe vault kent alleen `getLeavesOfType`; een scherm dat een notitie
	// opent vraagt om een tab.
	Object.assign((plugin.app as unknown as { workspace: object }).workspace, {
		getLeaf: () => new WorkspaceLeaf(),
	});

	return {
		...harness,
		async open(View, state) {
			const leaf = new WorkspaceLeaf();
			const view = new View(leaf as never, plugin);
			view.app = plugin.app;
			views.push(view);
			if (state && view.setState) await view.setState(state, {});
			else await view.onOpen();
			await settle();
			return { view, root: view.contentEl, leaf };
		},
	};
}
