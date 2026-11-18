/**
 * De plugin laadt, en alles wat hij aanmeldt is er.
 *
 * Op 2026-11-18 gaf de e2e drieëndertig keer "Cannot read properties of
 * undefined (reading 'lists')": Cupboard was in de test-Obsidian niet geladen,
 * en dat was pas na een minuut wachten te zien — zonder reden erbij. Of
 * `onload` doorloopt, of elk scherm een aanmaakfunctie heeft en elk commando
 * een uniek id, hoeft geen Obsidian te vragen.
 *
 * Dit draait de echte `main.ts` tegen de neppe vault. Wat het niet bewijst:
 * dat Obsidian zelf de bundel accepteert. Dat blijft de eerste check van de
 * e2e.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { installDom, settle } from "../harness/dom";
import { loadFixture } from "../harness/fixtures";
import { WorkspaceLeaf, type Plugin } from "../harness/obsidian";
import { FakeVault } from "../harness/vault";

installDom();

async function load() {
	const app = new FakeVault(loadFixture("week-basis"));
	let ready: (() => void) | null = null;
	const on = (): object => ({});
	// De instellingen bieden bestaande mappen aan; de neppe vault kent die niet.
	Object.assign(app.vault, { on, getAllFolders: () => [] });
	Object.assign(app.metadataCache, { on });
	Object.assign(app.workspace, {
		on,
		onLayoutReady: (fn: () => void) => {
			ready = fn;
		},
		getLeaf: () => new WorkspaceLeaf(),
		revealLeaf: () => Promise.resolve(),
		getActiveFile: () => null,
		getActiveViewOfType: () => null,
	});

	const { default: PantryPlugin } = await import("../../src/main");
	const plugin = new (PantryPlugin as unknown as new (app: unknown, manifest: unknown) => Plugin & {
		onload(): Promise<void>;
	})(app, { id: "cupboard", version: "test" });
	await plugin.onload();
	(ready as (() => void) | null)?.();
	await settle(20);
	return plugin;
}

test("onload loopt door en meldt elk scherm en commando aan", async () => {
	const plugin = await load();

	const views = [...plugin.views.keys()].sort();
	assert.ok(views.includes("pantry-stock-round"), "de telronde is een scherm");
	assert.ok(views.includes("pantry-shopping-lists"));
	assert.ok(views.includes("pantry-home"));

	const commands = [...plugin.commands.keys()];
	for (const id of ["open-home", "open-shopping-lists", "new-shopping-list", "check-stock", "new-shop", "new-recipe", "cook-focus"]) {
		assert.ok(commands.includes(id), `commando ${id} ontbreekt`);
	}
});

test("elk aangemeld scherm is ook echt aan te maken", async () => {
	const plugin = await load();
	for (const [type, create] of plugin.views) {
		const view = create(new WorkspaceLeaf()) as { getViewType(): string };
		assert.equal(view.getViewType(), type);
	}
});
