import { ItemView, setIcon } from "obsidian";
import { guarded } from "../guard";
import type PantryPlugin from "../main";
import { openHere } from "./nav";
import { ROUND_VIEW_TYPE } from "./round-view";

/**
 * De strook bovenaan Voorraad en Boodschappen zolang er een ronde staat.
 *
 * Zonder deze strook is een ronde onverklaarbaar: producten die gisteren nog
 * op de lijst stonden zijn "zomaar" weg, en niets zegt waarom. De strook
 * zegt waar de ronde voor is en biedt de twee dingen die je er dan mee wilt:
 * hem aanpassen, of hem weghalen zodat het weekplan weer geldt.
 *
 * Tekent niets als er geen ronde is — het gewone geval hoort geen strook te
 * dragen die zegt dat alles gewoon is.
 */
export function drawRoundBanner(parent: HTMLElement, plugin: PantryPlugin, view: ItemView): void {
	if (!plugin.list.hasRound()) return;

	const banner = parent.createDiv({ cls: "pantry-round-banner" });
	const icon = banner.createSpan({ cls: "pantry-round-banner-icon" });
	setIcon(icon, "list-checks");

	const text = banner.createDiv({ cls: "pantry-round-banner-text" });
	text.createDiv({ cls: "pantry-round-banner-title", text: "Shopping round" });
	text.createDiv({ cls: "pantry-round-banner-label", text: plugin.list.roundLabel() });

	const actions = banner.createDiv({ cls: "pantry-round-banner-actions" });
	const change = actions.createEl("button", { cls: "pantry-text-button", text: "Change" });
	change.onclick = () =>
		guarded("could not open the shopping round", () => openHere(view, ROUND_VIEW_TYPE));

	const clear = actions.createEl("button", { cls: "pantry-text-button", text: "Clear" });
	clear.setAttr("aria-label", "Clear the shopping round and follow the meal plan again");
	clear.onclick = () =>
		guarded("could not clear the shopping round", async () => {
			await plugin.list.clearRound();
			plugin.refreshViews();
		});
}
