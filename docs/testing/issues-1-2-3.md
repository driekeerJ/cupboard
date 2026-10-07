# Testscript — PR #5 (issues #1, #2, #3)

Ongeveer 20 minuten. Volgorde = belang: wat bovenaan staat, raakt de meeste
gebruikers of breekt het makkelijkst. Kom je in tijdnood, stop dan na blok C.

**Voorbereiding**
- [ ] Obsidian **volledig** herstart (niet alleen plugin uit/aan) en de kluis *Cupboard test* geopend
- [ ] Instellingen → Cupboard: de regel *Build* toont een tijdstempel van vandaag
- [ ] Op de iPhone: dezelfde kluis geopend via iCloud (pakt de build vanzelf mee)

---

## A. Winkellijst — de grootste gedragswijziging (#3) · telefoon · 6 min

Home → Shopping lists → *Supermarket · Wed 7 Oct* → stap **Shop**.

- [ ] **Tik op een productnaam** → het vinkje komt meteen, de rij wordt grijs en doorgestreept, en blijft ~1 s staan
- [ ] Daarna **glijdt** de rij naar onderen in zijn schap (geen sprong)
- [ ] Teller bovenaan ("x to buy · y in the basket") en voortgangsbalk lopen mee
- [ ] Tik **3 rijen snel achter elkaar** → alle drie blijven staan tot de laatste tik ~1 s oud is, dan zakken ze samen
- [ ] **Tik een afgevinkte rij** weer aan → hij glijdt terug naar zijn plek, het vinkje is weg
- [ ] **Scroll** door de lijst met je duim op de namen → er wordt niets afgevinkt
- [ ] **Houd een naam vast** (~½ s) → het productscherm opent; er wordt niets afgevinkt; geen tekstselectie of iOS-menu
- [ ] Het **ronde vinkje** zelf werkt nog
- [ ] **Hoeveelheid-knop** rechts → stepper +/− werkt nog, vinkt niets af
- [ ] Open een afgevinkt product als notitie: `count` is bijgewerkt (afvinken boekt nog steeds voorraad)

**Losse boodschap**
- [ ] *Add item* → "Batteries" → Add. Tik op de naam → doorgestreept, verdwijnt na ~1 s
- [ ] Nog een losse boodschap; **vasthouden** → het bewerkformulier opent

## B. Add-knop zichtbaar op de telefoon (#2) · telefoon · 3 min

- [ ] *Add item*: de knoppen Cancel / Add & new / **Add** staan volledig boven de onderrand (en boven de home-balk)
- [ ] Toetsenbord open in het naamveld → Add is nog te bereiken (of het formulier scrolt)
- [ ] Kop van het formulier valt niet onder de statusbalk/notch; het sluitkruisje (als zichtbaar) is tikbaar
- [ ] Products → **New product**: zelfde controle voor de onderste knoppen
- [ ] Hold een product in de winkellijst → productscherm: zelfde controle
- [ ] *(Alleen als je een Android met 3-knopsnavigatie kunt lenen: dit is de echte bug. Anders vraagt de melder het na.)*

## C. Winkels en recepten toevoegen (#1) · telefoon · 4 min

- [ ] Home → Shelves: naast *Supermarket* / *Farmers market* staat **+ Shop** in accentkleur
- [ ] **+ Shop** → venster met naamveld, Add is grijs zolang het leeg is → "Bakery" → Add shop
- [ ] Het scherm springt naar *Bakery*; de notitie `Shops/Bakery.md` bestaat
- [ ] Escape / Cancel in het venster → er gebeurt niets
- [ ] Meal planner → **+** in een maaltijdvak → receptkiezer: rechtsboven **New recipe**
- [ ] **New recipe** → kiezer sluit, venster vraagt een naam → "Test soup" → nieuwe notitie opent met `servings:` leeg en de kopjes *Ingredients* en *Method*
- [ ] Voeg `- 200 g [[Rice]]` toe en zet `servings: 2` → het recept verschijnt in de kiezer en is in te plannen
- [ ] Nog een keer **New recipe** met "Test soup" → melding "already exists; opening it", geen duplicaat
- [ ] Command palette: **New shop** en **New recipe** bestaan en werken

## D. Instelling vinkjes rechts (#3) · 2 min

- [ ] Instellingen → Cupboard → kopje *Shopping* → **Tick boxes on the right** aan
- [ ] Winkellijst: vinkjes staan nu aan de rechterrand, achter de hoeveelheid; tikken en vasthouden werken nog
- [ ] Uitzetten → terug naar links. (Mac: ook in de instellingen-zoekbalk te vinden op "tick")

## E. To check en uitleg (#3) · 3 min

- [ ] Home → All stock → **To check**: *Salt*, *Black pepper*, *Olive oil* e.d. (nooit geteld) staan erin
- [ ] Tel er één (bijv. Salt op 1) → hij verdwijnt bij de volgende keer openen uit To check
- [ ] Teller in de kop telt de nooit getelde producten mee ("… to check")
- [ ] **New product** "Testmeel" → onder *Package size* staat uitleg over pakken; tik *Amount does not matter* → de uitleg verandert naar die over zout en kruiden
- [ ] Na Add: open `Products/Testmeel.md` → de uitklapbare uitleg is **Engels** ("What the fields mean")
- [ ] Plan een recept in → het `meal-plan`-blok in de weeknotitie begint met de Engelse commentaarregel

## F. Snelle regressie · Mac · 2 min

- [ ] Planner: recept slepen naar een dag werkt nog
- [ ] Een bestaande weeknotitie openen → planner rendert, geen fout in de console (Cmd+Opt+I)
- [ ] Console tijdens alle stappen hierboven: geen rode `Cupboard:`-fouten

---

**Gevonden?** Noteer hier het blok + stap, dan pak ik het op:

-
