# Pantry — conventies

Obsidian-plugin voor recepten, weekplanning, voorraad en boodschappen. Eén
huishouden, geen communitycatalogus. Nederlands in de UI waar dat Jeroens woord
is, Engels in de code.

## Draaien

```bash
npm run test          # node --test, draait ook binnen npm run build
npm run build         # test + tsc -noEmit + esbuild -> main.js
npm run build:deploy  # build + kopieer main.js/manifest.json/styles.css naar de vault
npm run lint          # ESLint, type-aware
npm run typecheck:strict   # de noUncheckedIndexedAccess-achterstand (51 open)
```

Bouw en typecheck vóórdat je zegt dat iets klaar is. Obsidian pakt een verse
`main.js` pas op na een **volledige herstart** van de app — niet met plugin
off/on of Cmd+R.

Broncode staat in `~/git/prive/pantry`, **niet** in de vault. In de vault staan
alleen `main.js`, `manifest.json`, `styles.css` en `data.json`.

## Regels die het vaakst geschonden worden

**Onbekend blijft onbekend.** Nooit een getal verzinnen. Een telling die er niet
is, is `null` en geen `0`. Een receptregel die niet naar de teleenheid te
vertalen is, levert `0` op en geen schatting — een gok komt anders ongemerkt op
de boodschappenlijst terecht. `"plus"` is met opzet geen getal.

**Nooit de metadata-cache teruglezen in dezelfde tick als de schrijfactie.**
`processFrontMatter` keert terug voordat Obsidians cache bij is; opnieuw
indexeren geeft dan de oude waarden en het scherm moet twee keer worden
aangetikt. Pas de wijziging op het object in het geheugen toe en herindexeer
(`ProductIndex.apply`).

**Wat de gebruiker typt gaat nooit door `mutate()`.** `mutate` tekent het raster
opnieuw en trekt de cursor onder je vandaan. Gebruik `saveQuietly()` voor alles
wat tijdens het typen opslaat.

**Geen kale `void promise`.** ESLint staat op `ignoreVoid: false`. Een mislukte
schrijfactie moet zichtbaar zijn: `console.error` **én** een `Notice`. De plugin
schrijft continu naar de vault; stil falen betekent dat iemand denkt dat zijn
voorraad geboekt is terwijl er niets gebeurd is.

**Nooit vanuit een geheugenkopie schrijven.** Een plan of lijst in het geheugen
is een momentopname; de notitie kan intussen via Sync van een ander apparaat
veranderd zijn. Elke schrijfactie is een *wijziging op wat er nu staat*:
`PlanStore.update(week, change)` en `ShoppingLists.mutate(list, change)` lezen
de notitie binnen `vault.process` opnieuw, passen `change` daarop toe en
schrijven dat. Er is geen `save(plan)`. `change` is synchroon en wijst een
maaltijd aan met `entryAt(plan, ref)`, nooit via objectidentiteit. Wat niet te
lezen is (`plan.unreadable`, `list.frozen`) wordt nooit overschreven — dat
geeft een `Refusal` met de reden in de melding.

**Onbekend product ≠ weg.** Een mandje-regel voor een product dat hier (nog)
niet bestaat blijft op naam bewaard (`list.unresolved`) en gaat ongewijzigd mee
bij het schrijven.

**Formaatnummer.** Elke notitie die Pantry schrijft draagt `format:
PANTRY_FORMAT` (`src/format.ts`). Een build die een hoger nummer tegenkomt leest
wel, schrijft niet, en Home zegt dat het apparaat bijgewerkt moet worden.
Verhoog het nummer alleen als een oudere build iets zou weggooien.

**Iets weggooien vraagt eerst.** Done, Delete list en Delete product gaan door
`confirm()` (`src/ui/confirm.ts`). Done gooit niet weg maar verhuist naar
`Pantry/Shopping/Done/`; `sweep()` ruimt na `cookKeepDays` op.

**Notities zijn de waarheid.** `data.json` is alleen voor wat geen notitie kan
zijn. Een boodschappenlijst is één notitie in `Pantry/Shopping/`: de keuzes en
het mandje in de frontmatter, de afvinklijst in de body als spiegel van de
productnotities. De voorraad zelf staat alleen in de productnotitie.

**Een schrijver die op een cache-event reageert, moet zijn eigen echo negeren** —
stempel de tijd (`lastWrite`) en sla de schrijfactie over als de gerenderde
inhoud gelijk is aan wat er staat. Anders loopt het rond.

**Serialiseer alleen velden die iets zeggen.** Bouw een schoon object per
element; geef nooit de interne structuur rechtstreeks aan `stringifyYaml`. Oude
notities moeten byte-identiek blijven als er niets veranderd is.

**Het weekplan bewaart de link zoals geschreven**, `[[haakjes]]` inbegrepen.
Altijd door `linkTarget()` halen voordat je een bestand zoekt.

## UI

Elke control als `.pantry-app button.x` met expliciete hoogte en achtergrond:
Obsidian geeft elke `<button>` een vaste hoogte en thema's overschilderen ze.
Hetzelfde voor `<textarea>`. Nieuwe view-types toevoegen aan de selectorlijst
boven in `styles.css`, anders parkeert een sticky header onder de padding die
een thema op `.view-content` zet.

Slepen: luisteraars op `window`, gekoppeld op `pointerId`, plus een inline
`translateY`. Pointer capture sterft zodra het element in de DOM verplaatst
wordt. Volg `src/ui/reorder.ts`, niet het oudere `touch-drag.ts`.

## Commentaar

Doc-comments leggen uit **waarom**, niet wat. Elke ontwerpbeslissing die je over
een jaar kwijt bent, hoort boven de code die hem uitvoert. Zie `products.ts`
(waarom `"plus"` geen getal is), `consume.ts` (waarom er een `check`-vlag is).

## Tests

`tests/harness/` zet de echte indexen op een neppe vault (`Map<pad, markdown>`).
Scenario's zijn markdownnotities onder `tests/fixtures/<scenario>/`. Verander de
broncode niet om hem testbaar te maken — het harnas past zich aan.

Bekende bugs staan als `test(..., { todo: "H1 — …" })` met de **gewenste**
uitkomst. Repareer je zo'n bug, haal dan `{ todo }` weg; pas nooit de assertie
aan om hem groen te krijgen.
